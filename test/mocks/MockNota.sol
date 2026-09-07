// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { INotaReceiptStore } from "../../src/interfaces/INotaReceiptStore.sol";
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
