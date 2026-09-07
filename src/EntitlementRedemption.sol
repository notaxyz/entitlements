// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { INotaReceiptStore } from "./interfaces/INotaReceiptStore.sol";
import { IPurchaseRefRegistry } from "./interfaces/IPurchaseRefRegistry.sol";

/// @title EntitlementRedemption
/// @notice Records one redemption for an entitlement purchased through Nota.
/// @dev This contract holds no funds and intentionally has no owner, pause, or upgrade mechanism.
///
///      Redemption trusts a SET of Nota settlement modules, not a single contract.
///      `PurchaseRefRegistry.consume` attributes a reference to the module that called it, so a
///      purchase settled through the receipt store records the store while one settled through
///      the x402 adapter records the adapter. Accepting only the store would make every x402
///      purchase permanently unredeemable.
///
///      The accepted set is fixed at construction and cannot be changed afterwards, which keeps
///      the no-owner property. Adding a settlement module later means deploying a new redemption
///      contract with the longer list -- a configuration change, not a source change. See
///      SECURITY.md for what that redeploy costs.
contract EntitlementRedemption {
    INotaReceiptStore public immutable STORE;
    IPurchaseRefRegistry public immutable PURCHASE_REF_REGISTRY;

    /// @notice Settlement modules whose consumption of a purchase reference counts as payment.
    mapping(address consumer => bool accepted) public isAcceptedConsumer;

    mapping(bytes32 purchaseRef => uint64 timestamp) public redeemedAt;

    address[] internal _acceptedConsumers;

    error InvalidStore();
    error InvalidRegistry();
    error InvalidConsumer();
    error DuplicateConsumer(address consumer);
    error CallerNotSeller(address caller, address seller);
    error EntitlementNotPaid(bytes32 purchaseRef);
    error EntitlementAlreadyRedeemed(bytes32 purchaseRef);

    event ConsumerAccepted(address indexed consumer);
    event EntitlementRedeemed(
        bytes32 indexed purchaseRef, address indexed seller, uint64 redeemedAt
    );

    /// @param storeAddress Deployed `NotaReceiptStore`. Always accepted as a consumer: it is the
    ///        contract that reconstructs the purchase reference, and refusing it would strand
    ///        every directly settled purchase.
    /// @param additionalConsumers Other Nota settlement modules whose consumption counts as
    ///        payment, such as `NotaX402Settlement`. Each must be non-zero and listed once.
    constructor(address storeAddress, address[] memory additionalConsumers) {
        if (storeAddress == address(0)) revert InvalidStore();

        INotaReceiptStore store_ = INotaReceiptStore(storeAddress);
        address registryAddress = store_.PURCHASE_REF_REGISTRY();

        if (registryAddress == address(0)) revert InvalidRegistry();

        STORE = store_;
        PURCHASE_REF_REGISTRY = IPurchaseRefRegistry(registryAddress);

        _acceptConsumer(storeAddress);

        for (uint256 i = 0; i < additionalConsumers.length; i++) {
            _acceptConsumer(additionalConsumers[i]);
        }
    }

    /// @notice Every settlement module whose consumption this contract accepts as payment.
    /// @dev Enumerable on purpose: the trust boundary is a set, so it should be readable as one.
    function acceptedConsumers() external view returns (address[] memory) {
        return _acceptedConsumers;
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

        // An unconsumed reference reads back as `address(0)`, which is never accepted, so this
        // one check covers both "never paid" and "paid through a module we do not trust".
        if (!isAcceptedConsumer[PURCHASE_REF_REGISTRY.consumedBy(purchaseRef)]) {
            revert EntitlementNotPaid(purchaseRef);
        }
        if (redeemedAt[purchaseRef] != 0) {
            revert EntitlementAlreadyRedeemed(purchaseRef);
        }

        uint64 timestamp = uint64(block.timestamp);
        redeemedAt[purchaseRef] = timestamp;

        emit EntitlementRedeemed(purchaseRef, seller, timestamp);
    }

    function _acceptConsumer(address consumer) private {
        if (consumer == address(0)) revert InvalidConsumer();
        if (isAcceptedConsumer[consumer]) revert DuplicateConsumer(consumer);

        isAcceptedConsumer[consumer] = true;
        _acceptedConsumers.push(consumer);

        emit ConsumerAccepted(consumer);
    }
}
