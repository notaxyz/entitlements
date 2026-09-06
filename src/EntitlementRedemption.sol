// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { INotaReceiptStore } from "./interfaces/INotaReceiptStore.sol";
import { IPurchaseRefRegistry } from "./interfaces/IPurchaseRefRegistry.sol";

/// @title EntitlementRedemption
/// @notice Records one redemption for an entitlement purchased through Nota.
/// @dev This contract holds no funds and intentionally has no owner, pause, or upgrade mechanism.
contract EntitlementRedemption {
    INotaReceiptStore public immutable STORE;
    IPurchaseRefRegistry public immutable PURCHASE_REF_REGISTRY;

    mapping(bytes32 purchaseRef => uint64 timestamp) public redeemedAt;

    error InvalidStore();
    error InvalidRegistry();
    error CallerNotSeller(address caller, address seller);
    error EntitlementNotPaid(bytes32 purchaseRef);
    error EntitlementAlreadyRedeemed(bytes32 purchaseRef);

    event EntitlementRedeemed(
        bytes32 indexed purchaseRef, address indexed seller, uint64 redeemedAt
    );

    constructor(address storeAddress) {
        if (storeAddress == address(0)) revert InvalidStore();

        INotaReceiptStore store_ = INotaReceiptStore(storeAddress);
        address registryAddress = store_.PURCHASE_REF_REGISTRY();

        if (registryAddress == address(0)) revert InvalidRegistry();

        STORE = store_;
        PURCHASE_REF_REGISTRY = IPurchaseRefRegistry(registryAddress);
    }

    /// @notice Redeem a paid purchase reference once for its listing seller.
    /// @param listingId Nota listing that issued the entitlement.
    /// @param rawPurchaseRef Purchase reference supplied as part of the redemption preimage bundle.
    /// @param purchaseRefNonce Nonce providing cryptographic secrecy for the preimage bundle.
    /// @return purchaseRef The reconstructed purchase-reference hash.
    function redeemEntitlement(
        uint256 listingId,
        string calldata rawPurchaseRef,
        bytes32 purchaseRefNonce
    ) external returns (bytes32 purchaseRef) {
        address seller = STORE.getListing(listingId).seller;
        if (msg.sender != seller) revert CallerNotSeller(msg.sender, seller);

        purchaseRef = STORE.hashPurchaseRef(seller, listingId, rawPurchaseRef, purchaseRefNonce);

        if (PURCHASE_REF_REGISTRY.consumedBy(purchaseRef) != address(STORE)) {
            revert EntitlementNotPaid(purchaseRef);
        }
        if (redeemedAt[purchaseRef] != 0) {
            revert EntitlementAlreadyRedeemed(purchaseRef);
        }

        uint64 timestamp = uint64(block.timestamp);
        redeemedAt[purchaseRef] = timestamp;

        emit EntitlementRedeemed(purchaseRef, seller, timestamp);
    }
}
