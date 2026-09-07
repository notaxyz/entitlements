// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @notice Minimal interface for the NotaReceiptStore deployed on Base mainnet.
/// @dev The tuple layout and signatures match the deployed ABI at
///      0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88.
interface INotaReceiptStore {
    enum ListingMode {
        PublicFixedPrice,
        SignedQuoteOnly
    }

    error ListingNotFound();
    error ListingInactive();
    error InvalidParams();
    error InvalidPurchaseRef();
    error PurchaseRefAlreadyUsed();
    error QuoteExpired();
    error InvalidQuoteSigner();
    error QuoteBuyerMismatch();
    error IntegratorFeeTooHigh();
    error AmountOutOfBounds();
    error QuoteExpiryTooLong();
    error PurchasesPaused();

    struct Listing {
        address seller;
        bytes32 listingHash;
        uint256 unitPrice;
        bool active;
        ListingMode mode;
    }

    /// @dev Field order is the EIP-712 struct order the deployed store signs over. `buyer` is
    ///      optional in the store: a zero `buyer` leaves the quote unbound so any wallet may pay.
    struct SignedReceiptQuote {
        uint256 listingId;
        address buyer;
        bytes32 purchaseRef;
        uint256 amount;
        bytes32 metadataHash;
        bytes32 agentId;
        address integratorFeeRecipient;
        uint256 integratorFeeAmount;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    /// @dev Returned by `validateSignedReceiptPurchase`. The fee legs come from the store's own
    ///      `_quoteRake`, which is the same helper `_settleReceiptPurchase` uses, so these numbers
    ///      are authoritative and must not be recomputed by integrators.
    struct SignedReceiptPurchaseValidation {
        uint256 grossAmount;
        uint256 protocolFee;
        uint256 integratorFee;
        uint256 sellerNet;
        address protocolFeeRecipient;
        address integratorFeeRecipient;
        address seller;
        bytes32 listingHash;
        address verifiedSigner;
    }

    function getListing(uint256 listingId) external view returns (Listing memory);

    function hashPurchaseRef(
        address seller,
        uint256 listingId,
        string calldata rawPurchaseRef,
        bytes32 purchaseRefNonce
    ) external view returns (bytes32);

    function PURCHASE_REF_REGISTRY() external view returns (address);
}
