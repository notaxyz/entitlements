// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IEIP3009 } from "./interfaces/IEIP3009.sol";
import { INotaReceiptStore } from "./interfaces/INotaReceiptStore.sol";
import { INotaSignedQuoteStore } from "./interfaces/INotaSignedQuoteStore.sol";
import { IPurchaseRefRegistry } from "./interfaces/IPurchaseRefRegistry.sol";

/// @title NotaX402Settlement
/// @notice Settles a Nota seller-signed quote with an EIP-3009 authorization instead of an
///         `approve` + `transferFrom`, so a facilitator can submit the transaction and the buyer
///         needs no ETH.
/// @dev The adapter reuses the deployed store as the authority on validity and pricing: it calls
///      `validateSignedReceiptPurchase`, which runs the same checks as `purchaseSignedReceipt`,
///      and then pays out the exact fee breakdown that view returns. No fee math is reproduced
///      here, so there is nothing to drift from the store.
///
///      The adapter holds no funds between transactions: it receives `quote.amount` and pays out
///      `protocolFee + integratorFee + sellerNet`, which the store guarantees sum to exactly that
///      amount. It has no owner, no pause switch, and no upgrade path.
///
///      Settlement consumes `quote.purchaseRef` in the shared `PurchaseRefRegistry`, so the
///      registry owner must authorize this adapter as a consumer before any call can succeed.
///      See the post-deployment step in the README.
contract NotaX402Settlement is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice EIP-3009 `ReceiveWithAuthorization` payload signed by the buyer.
    /// @dev `nonce` is EIP-3009 replay protection scoped to the token. It is unrelated to the
    ///      `purchaseRefNonce` that forms the off-chain redemption bundle, and neither is ever
    ///      derived from the other. See SECURITY.md.
    struct ReceiveAuthorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    /// @notice Deployed Nota receipt store this adapter settles quotes for.
    INotaSignedQuoteStore public immutable STORE;
    /// @notice Shared consume-once registry, discovered from `STORE`.
    IPurchaseRefRegistry public immutable PURCHASE_REF_REGISTRY;
    /// @notice Settlement token, discovered from `STORE`. Must implement EIP-3009.
    IERC20 public immutable SETTLEMENT_TOKEN;

    /// @notice Next identifier this adapter will assign.
    /// @dev ADAPTER RECEIPT IDS ARE NOT STORE RECEIPT IDS. This counter is local to this contract
    ///      and is unrelated to `NotaReceiptStore.nextReceiptId`. Adapter id `7` and store receipt
    ///      `7` are different records in different id spaces; the only identifier that joins the
    ///      two systems is `purchaseRef`. Indexers must key on `purchaseRef`, never on the id.
    uint256 public nextAdapterReceiptId = 1;

    error InvalidStore();
    error InvalidRegistry();
    error InvalidSettlementToken();
    error UnboundQuote();
    error StorePurchasesPaused();
    error AuthorizationPayerMismatch(address authorizationFrom, address quoteBuyer);
    error AuthorizationRecipientMismatch(address authorizationTo, address adapter);
    error AuthorizationValueMismatch(uint256 authorizationValue, uint256 quoteAmount);
    error SettlementAccountingMismatch();

    /// @notice Emitted once per successful x402 settlement.
    /// @param receiptId Identifier from this adapter's own id space. It is NOT a
    ///        `NotaReceiptStore` receipt id and must not be treated as interchangeable with one.
    /// @param listingId Listing the quote was issued against. Adapter settlements do not emit
    ///        `ReceiptPurchasedV2`, and `purchaseRef` does not commit to a listing, so without
    ///        this field a settlement could not be attributed to a listing from its own event.
    ///
    ///        This is deliberately ASYMMETRIC with `EntitlementRedemption.EntitlementRedeemed`,
    ///        which omits the listing id on purpose. The difference is what a signature covers.
    ///        Here `listingId` is a member of the seller-signed EIP-712 `SignedReceiptQuote`, so
    ///        the seller signature the store verified above attests to it and emitting it
    ///        publishes an attested fact. Redemption has no signature over a listing id, so a
    ///        seller could emit any listing they liked; that event omits it rather than
    ///        publishing an unattested claim, and consumers join it by `purchaseRef` instead.
    ///        Same field, opposite correct answer. Do not "fix" either event to match the other.
    /// @param purchaseRef The globally consume-once reference this settlement consumed.
    /// @param authorizationNonce The EIP-3009 nonce, public from this point on. It is not the
    ///        redemption `purchaseRefNonce`, which never appears on-chain.
    event X402ReceiptSettled(
        uint256 indexed receiptId,
        address indexed seller,
        address indexed buyer,
        uint256 listingId,
        bytes32 purchaseRef,
        uint256 amount,
        bytes32 metadataHash,
        bytes32 agentId,
        bytes32 authorizationNonce
    );

    /// @param storeAddress Deployed `NotaReceiptStore`. The registry and settlement token are read
    ///        from it so the adapter cannot be pointed at a mismatched pair.
    constructor(address storeAddress) {
        if (storeAddress == address(0)) revert InvalidStore();

        INotaSignedQuoteStore store_ = INotaSignedQuoteStore(storeAddress);
        address registryAddress = store_.PURCHASE_REF_REGISTRY();
        address tokenAddress = store_.SETTLEMENT_TOKEN();

        if (registryAddress == address(0)) revert InvalidRegistry();
        if (tokenAddress == address(0)) revert InvalidSettlementToken();

        STORE = store_;
        PURCHASE_REF_REGISTRY = IPurchaseRefRegistry(registryAddress);
        SETTLEMENT_TOKEN = IERC20(tokenAddress);
    }

    /// @notice Settle a seller-signed quote by pulling the buyer's EIP-3009 authorization.
    /// @dev Any address may submit; that is the point. The buyer never sends a transaction and
    ///      never needs ETH, and the seller signature and the buyer authorization are both
    ///      verified on-chain, so the submitter is untrusted.
    /// @param quote Seller-authorized quote. `quote.buyer` must be non-zero: an unbound quote has
    ///        no payer to bind the authorization to, and the store would skip its buyer check.
    /// @param sellerSignature EIP-712 signature over `quote`, from the seller or a
    ///        listing-authorized quote signer. EOA or ERC-1271.
    /// @param claimedSigner Address asserted to have produced `sellerSignature`; zero means the
    ///        listing seller.
    /// @param authorization Buyer's `ReceiveWithAuthorization` payload, bound to this adapter.
    /// @param buyerSignature Signature over `authorization`, validated by the token. EOA or
    ///        ERC-1271, so a smart-wallet buyer can pay.
    /// @return receiptId Identifier in this adapter's own id space. See `nextAdapterReceiptId`.
    function settleWithAuthorization(
        INotaReceiptStore.SignedReceiptQuote calldata quote,
        bytes calldata sellerSignature,
        address claimedSigner,
        ReceiveAuthorization calldata authorization,
        bytes calldata buyerSignature
    ) external nonReentrant returns (uint256 receiptId) {
        // The store treats a zero buyer as "anyone may pay" and skips its buyer check entirely.
        // An EIP-3009 authorization has to name one payer, so an unbound quote is rejected here
        // rather than silently settling against whoever the authorization happens to name.
        if (quote.buyer == address(0)) revert UnboundQuote();

        // `purchasesPaused` is the one check `purchaseSignedReceipt` performs that
        // `validateSignedReceiptPurchase` does not repeat. Honouring it keeps the store owner's
        // kill switch effective for this settlement path too.
        if (STORE.purchasesPaused()) revert StorePurchasesPaused();

        INotaReceiptStore.SignedReceiptPurchaseValidation memory validation =
            STORE.validateSignedReceiptPurchase(quote, sellerSignature, quote.buyer, claimedSigner);

        if (authorization.from != quote.buyer) {
            revert AuthorizationPayerMismatch(authorization.from, quote.buyer);
        }
        if (authorization.to != address(this)) {
            revert AuthorizationRecipientMismatch(authorization.to, address(this));
        }
        if (authorization.value != quote.amount) {
            revert AuthorizationValueMismatch(authorization.value, quote.amount);
        }

        // The store's own `_quoteRake` guarantees this. It is re-checked because the constructor
        // accepts an arbitrary store address, and a store whose breakdown did not sum to the gross
        // would either strand tokens in this adapter or make a payout leg revert on a shortfall.
        if (
            validation.grossAmount != quote.amount
                || validation.protocolFee + validation.integratorFee + validation.sellerNet
                    != quote.amount
        ) {
            revert SettlementAccountingMismatch();
        }

        // `receiveWithAuthorization`, not `transferWithAuthorization`: the token requires
        // `msg.sender == to`, so this signed authorization is only executable through this
        // adapter. A front-runner who observes it cannot move the buyer's funds on its own.
        //
        // The `bytes` overload, not the `(v, r, s)` one: the token validates it with
        // `SignatureChecker`, so an ERC-1271 smart-wallet buyer can pay. The store already
        // accepts ERC-1271 seller signatures; an ECDSA-only buyer path would undo that.
        IEIP3009(address(SETTLEMENT_TOKEN))
            .receiveWithAuthorization(
                authorization.from,
                authorization.to,
                authorization.value,
                authorization.validAfter,
                authorization.validBefore,
                authorization.nonce,
                buyerSignature
            );

        // Mirrors `_settleReceiptPurchase`: funds in, then consume, then distribute. Consuming
        // after the pull means a settlement that cannot be paid never burns the reference, and
        // consuming before payout means a re-entrant payout target cannot double-spend it.
        PURCHASE_REF_REGISTRY.consume(quote.purchaseRef);

        receiptId = nextAdapterReceiptId++;

        _distributeProceeds(validation);

        _emitSettled(receiptId, validation.seller, quote, authorization.nonce);
    }

    /// @dev Split out so the event's nine fields do not have to be live on the stack alongside
    ///      the settlement locals.
    function _emitSettled(
        uint256 receiptId,
        address seller,
        INotaReceiptStore.SignedReceiptQuote calldata quote,
        bytes32 authorizationNonce
    ) private {
        emit X402ReceiptSettled(
            receiptId,
            seller,
            quote.buyer,
            quote.listingId,
            quote.purchaseRef,
            quote.amount,
            quote.metadataHash,
            quote.agentId,
            authorizationNonce
        );
    }

    /// @dev Pays the store's own fee breakdown out of the gross this adapter just received. The
    ///      three legs sum to exactly that gross, so nothing is left behind.
    ///
    ///      Zero legs are skipped. The deployed store runs a zero protocol fee with a zero fee
    ///      recipient, so an unconditional protocol transfer would send to `address(0)` and
    ///      revert. A non-zero protocol fee always has a non-zero recipient: the store's
    ///      constructor rejects that pairing.
    function _distributeProceeds(
        INotaReceiptStore.SignedReceiptPurchaseValidation memory validation
    ) private {
        if (validation.protocolFee > 0) {
            SETTLEMENT_TOKEN.safeTransfer(validation.protocolFeeRecipient, validation.protocolFee);
        }
        if (validation.integratorFee > 0) {
            SETTLEMENT_TOKEN.safeTransfer(
                validation.integratorFeeRecipient, validation.integratorFee
            );
        }
        if (validation.sellerNet > 0) {
            SETTLEMENT_TOKEN.safeTransfer(validation.seller, validation.sellerNet);
        }
    }
}
