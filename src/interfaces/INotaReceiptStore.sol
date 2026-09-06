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

    struct Listing {
        address seller;
        bytes32 listingHash;
        uint256 unitPrice;
        bool active;
        ListingMode mode;
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
