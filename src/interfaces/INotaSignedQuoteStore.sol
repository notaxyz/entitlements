// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { INotaReceiptStore } from "./INotaReceiptStore.sol";

/// @notice The seller-signed-quote surface of the NotaReceiptStore deployed on Base mainnet.
/// @dev Split from `INotaReceiptStore` so the entitlement layer keeps depending on the smaller
///      slice it actually uses. The signatures match the deployed ABI at
///      0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88.
interface INotaSignedQuoteStore is INotaReceiptStore {
    function createListing(bytes32 listingHash, uint256 unitPrice, ListingMode mode)
        external
        returns (uint256 listingId);

    /// @notice Applies the same validation path as `purchaseSignedReceipt` without moving funds.
    /// @dev Reverts on every invalid case `purchaseSignedReceipt` rejects except the store-owner
    ///      `purchasesPaused` switch, which callers must check separately. It is a view and does
    ///      not consume `quote.purchaseRef`.
    function validateSignedReceiptPurchase(
        SignedReceiptQuote calldata quote,
        bytes calldata sellerSignature,
        address expectedBuyer,
        address claimedSigner
    ) external view returns (SignedReceiptPurchaseValidation memory);

    function SETTLEMENT_TOKEN() external view returns (address);

    function SIGNED_RECEIPT_QUOTE_TYPEHASH() external view returns (bytes32);

    function MAX_PROTOCOL_FEE_BPS() external view returns (uint16);

    function MAX_INTEGRATOR_FEE_BPS() external view returns (uint16);

    /// @notice Store-owner switch that blocks `purchaseSignedReceipt`.
    function purchasesPaused() external view returns (bool);

    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
}
