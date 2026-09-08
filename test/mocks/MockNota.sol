// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { INotaReceiptStore } from "../../src/interfaces/INotaReceiptStore.sol";
import { INotaSignedQuoteStore } from "../../src/interfaces/INotaSignedQuoteStore.sol";
import { IPurchaseRefRegistry } from "../../src/interfaces/IPurchaseRefRegistry.sol";

contract MockPurchaseRefRegistry is IPurchaseRefRegistry {
    mapping(bytes32 purchaseRef => address consumer) public override consumedBy;
    mapping(address consumer => bool authorized) public override authorizedConsumers;

    address public override owner = msg.sender;

    function setConsumedBy(bytes32 purchaseRef, address consumer) external {
        consumedBy[purchaseRef] = consumer;
    }

    function setConsumerAuthorization(address consumer, bool authorized) external override {
        authorizedConsumers[consumer] = authorized;
    }

    function consume(bytes32 purchaseRef) external override {
        if (!authorizedConsumers[msg.sender]) revert UnauthorizedConsumer(msg.sender);

        address consumer = consumedBy[purchaseRef];
        if (consumer != address(0)) revert PurchaseRefAlreadyConsumed(purchaseRef, consumer);

        consumedBy[purchaseRef] = msg.sender;
    }

    function isConsumed(bytes32 purchaseRef) external view override returns (bool) {
        return consumedBy[purchaseRef] != address(0);
    }
}

contract MockNotaReceiptStore is INotaReceiptStore {
    address public immutable override PURCHASE_REF_REGISTRY;

    mapping(uint256 listingId => Listing listing) internal listings;

    error NotListingSeller();

    constructor(address registry) {
        PURCHASE_REF_REGISTRY = registry;
    }

    function setListing(uint256 listingId, address seller) external {
        listings[listingId] = Listing({
            seller: seller,
            listingHash: keccak256(abi.encode("listing", listingId)),
            unitPrice: 1e6,
            active: true,
            mode: ListingMode.SignedQuoteOnly
        });
    }

    function getListing(uint256 listingId) external view returns (Listing memory listing) {
        listing = listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
    }

    function hashPurchaseRef(
        address seller,
        uint256 listingId,
        string calldata rawPurchaseRef,
        bytes32 purchaseRefNonce
    ) external view returns (bytes32) {
        Listing memory listing = listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
        if (listing.seller != seller) revert NotListingSeller();

        return keccak256(abi.encode(seller, rawPurchaseRef, purchaseRefNonce));
    }
}

/// @notice Adds the seller-signed-quote surface to the receipt store mock.
/// @dev Mirrors the deployed store's `_quoteRake` and the validation `_verifySignedReceiptQuote`
///      performs, so an adapter tested against this behaves the way it does against Base. The
///      protocol fee is configurable because the deployed store runs it at zero with a zero
///      recipient, and both that case and a non-zero one need covering.
///
///      IT DOES NOT VERIFY SIGNATURES. Real EIP-712 seller-signature verification is exercised
///      against the deployed store in the fork suite; here `quoteSignatureAccepted` stands in for
///      the result so the adapter's own behaviour can be tested deterministically.
contract MockSignedQuoteStore is MockNotaReceiptStore, INotaSignedQuoteStore {
    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant MIN_PURCHASE_AMOUNT = 1e2;

    address public immutable override SETTLEMENT_TOKEN;

    bool public override purchasesPaused;
    bool public quoteSignatureAccepted = true;

    uint256 public nextListingId = 1;
    uint16 public protocolFeeBps;
    address public protocolFeeRecipient;

    bool public useCannedValidation;
    SignedReceiptPurchaseValidation internal cannedValidation;

    constructor(address registry, address token) MockNotaReceiptStore(registry) {
        SETTLEMENT_TOKEN = token;
    }

    function setPurchasesPaused(bool paused) external {
        purchasesPaused = paused;
    }

    function setQuoteSignatureAccepted(bool accepted) external {
        quoteSignatureAccepted = accepted;
    }

    function setProtocolFee(uint16 bps, address recipient) external {
        protocolFeeBps = bps;
        protocolFeeRecipient = recipient;
    }

    /// @dev Forces `validateSignedReceiptPurchase` to return a fixed breakdown, so a store whose
    ///      legs do not sum to the gross can be simulated.
    function setCannedValidation(SignedReceiptPurchaseValidation calldata validation) external {
        cannedValidation = validation;
        useCannedValidation = true;
    }

    function createListing(bytes32 listingHash, uint256 unitPrice, ListingMode mode)
        external
        override
        returns (uint256 listingId)
    {
        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            listingHash: listingHash,
            unitPrice: unitPrice,
            active: true,
            mode: mode
        });
    }

    function setListingActive(uint256 listingId, bool active) external {
        listings[listingId].active = active;
    }

    function validateSignedReceiptPurchase(
        SignedReceiptQuote calldata quote,
        bytes calldata sellerSignature,
        address expectedBuyer,
        address
    ) external view override returns (SignedReceiptPurchaseValidation memory validation) {
        Listing storage listing = listings[quote.listingId];

        if (listing.seller == address(0)) revert ListingNotFound();
        if (!listing.active) revert ListingInactive();
        if (quote.buyer != address(0) && quote.buyer != expectedBuyer) revert QuoteBuyerMismatch();
        if (quote.purchaseRef == bytes32(0)) revert InvalidPurchaseRef();
        if (quote.metadataHash == bytes32(0)) revert InvalidParams();
        if (quote.amount < MIN_PURCHASE_AMOUNT) revert AmountOutOfBounds();
        if (quote.expiresAt <= block.timestamp) revert QuoteExpired();
        if (sellerSignature.length == 0 || !quoteSignatureAccepted) revert InvalidQuoteSigner();
        if (IPurchaseRefRegistry(PURCHASE_REF_REGISTRY).isConsumed(quote.purchaseRef)) {
            revert PurchaseRefAlreadyUsed();
        }

        _validateIntegratorFee(
            quote.integratorFeeRecipient, quote.integratorFeeAmount, quote.amount
        );

        if (useCannedValidation) return cannedValidation;

        uint256 protocolFee = quote.amount * protocolFeeBps / BPS_DENOMINATOR;

        validation = SignedReceiptPurchaseValidation({
            grossAmount: quote.amount,
            protocolFee: protocolFee,
            integratorFee: quote.integratorFeeAmount,
            sellerNet: quote.amount - protocolFee - quote.integratorFeeAmount,
            protocolFeeRecipient: protocolFeeRecipient,
            integratorFeeRecipient: quote.integratorFeeRecipient,
            seller: listing.seller,
            listingHash: listing.listingHash,
            verifiedSigner: listing.seller
        });
    }

    function nextReceiptId() external pure override returns (uint256) {
        return 1;
    }

    function SIGNED_RECEIPT_QUOTE_TYPEHASH() external pure override returns (bytes32) {
        return keccak256("SignedReceiptQuote(mock)");
    }

    function MAX_PROTOCOL_FEE_BPS() external pure override returns (uint16) {
        return 50;
    }

    function MAX_INTEGRATOR_FEE_BPS() external pure override returns (uint16) {
        return 450;
    }

    function eip712Domain()
        external
        view
        override
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory)
    {
        return (
            hex"0f",
            "MockNotaReceiptStore",
            "2",
            block.chainid,
            address(this),
            bytes32(0),
            new uint256[](0)
        );
    }

    function _validateIntegratorFee(address recipient, uint256 feeAmount, uint256 grossAmount)
        private
        pure
    {
        if (feeAmount == 0) {
            if (recipient != address(0)) revert InvalidParams();
            return;
        }

        if (recipient == address(0)) revert InvalidParams();
        if (feeAmount > grossAmount * 450 / BPS_DENOMINATOR) revert IntegratorFeeTooHigh();
    }
}
