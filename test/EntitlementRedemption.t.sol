// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { EntitlementRedemption } from "../src/EntitlementRedemption.sol";
import { INotaReceiptStore } from "../src/interfaces/INotaReceiptStore.sol";
import { MockNotaReceiptStore, MockPurchaseRefRegistry } from "./mocks/MockNota.sol";

contract EntitlementRedemptionTest is Test {
    uint256 internal constant LISTING_ID = 1;

    MockNotaReceiptStore internal store;
    MockPurchaseRefRegistry internal registry;
    EntitlementRedemption internal redemption;

    address internal seller;
    address internal adapter;
    string internal rawPurchaseRef;
    bytes32 internal nonce;
    bytes32 internal purchaseRef;

    event EntitlementRedeemed(
        bytes32 indexed purchaseRef, address indexed seller, uint64 redeemedAt
    );

    function setUp() public {
        seller = makeAddr("seller");
        rawPurchaseRef = "merchant-order-123";
        nonce = keccak256("buyer-generated-redemption-nonce");

        registry = new MockPurchaseRefRegistry();
        store = new MockNotaReceiptStore(address(registry));
        store.setListing(LISTING_ID, seller);

        adapter = makeAddr("authorized-settlement-adapter");

        address[] memory additionalConsumers = new address[](1);
        additionalConsumers[0] = adapter;
        redemption = new EntitlementRedemption(address(store), additionalConsumers);
        purchaseRef = store.hashPurchaseRef(seller, LISTING_ID, rawPurchaseRef, nonce);
        registry.setConsumedBy(purchaseRef, address(store));

        vm.warp(1_700_000_000);
    }

    function test_CorrectSellerAndConsumedByStoreSucceeds() public {
        vm.prank(seller);
        bytes32 redeemedPurchaseRef =
            redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);

        assertEq(redeemedPurchaseRef, purchaseRef);
        assertEq(uint256(redemption.redeemedAt(purchaseRef)), block.timestamp);
    }

    function test_AcceptedConsumerSetIsStoreAndAdditionalModules() public view {
        address[] memory accepted = redemption.acceptedConsumers();

        assertEq(accepted.length, 2);
        assertEq(accepted[0], address(store));
        assertEq(accepted[1], adapter);
        assertTrue(redemption.isAcceptedConsumer(address(store)));
        assertTrue(redemption.isAcceptedConsumer(adapter));
        assertFalse(redemption.isAcceptedConsumer(address(0)));
    }

    function test_ReferenceConsumedByAcceptedAdapterSucceeds() public {
        registry.setConsumedBy(purchaseRef, adapter);

        vm.prank(seller);
        bytes32 redeemedPurchaseRef =
            redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);

        assertEq(redeemedPurchaseRef, purchaseRef);
        assertEq(uint256(redemption.redeemedAt(purchaseRef)), block.timestamp);
    }

    function test_ConstructorRejectsZeroConsumer() public {
        address[] memory additionalConsumers = new address[](1);
        additionalConsumers[0] = address(0);

        vm.expectRevert(EntitlementRedemption.InvalidConsumer.selector);
        new EntitlementRedemption(address(store), additionalConsumers);
    }

    function test_ConstructorRejectsDuplicateConsumer() public {
        address[] memory additionalConsumers = new address[](1);
        additionalConsumers[0] = address(store);

        vm.expectRevert(
            abi.encodeWithSelector(EntitlementRedemption.DuplicateConsumer.selector, address(store))
        );
        new EntitlementRedemption(address(store), additionalConsumers);
    }

    function test_ReferenceConsumedByAnUnacceptedModuleFails() public {
        registry.setConsumedBy(purchaseRef, makeAddr("unaccepted-module"));

        vm.expectRevert(
            abi.encodeWithSelector(EntitlementRedemption.EntitlementNotPaid.selector, purchaseRef)
        );
        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);
    }

    function test_NonSellerFails() public {
        address caller = makeAddr("non-seller");

        vm.expectRevert(
            abi.encodeWithSelector(EntitlementRedemption.CallerNotSeller.selector, caller, seller)
        );
        vm.prank(caller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);
    }

    function test_WrongPreimageBundleFails() public {
        bytes32 wrongNonce = keccak256("wrong-redemption-nonce");
        bytes32 wrongPurchaseRef =
            store.hashPurchaseRef(seller, LISTING_ID, rawPurchaseRef, wrongNonce);

        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementRedemption.EntitlementNotPaid.selector, wrongPurchaseRef
            )
        );
        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, wrongNonce);
    }

    function test_UnconsumedReferenceFails() public {
        registry.setConsumedBy(purchaseRef, address(0));

        vm.expectRevert(
            abi.encodeWithSelector(EntitlementRedemption.EntitlementNotPaid.selector, purchaseRef)
        );
        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);
    }

    function test_ReplayFails() public {
        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);

        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementRedemption.EntitlementAlreadyRedeemed.selector, purchaseRef
            )
        );
        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);
    }

    function test_NonexistentListingFails() public {
        vm.expectRevert(INotaReceiptStore.ListingNotFound.selector);
        redemption.redeemEntitlement(type(uint256).max, rawPurchaseRef, nonce);
    }

    function test_EmitsCorrectEventFields() public {
        uint64 timestamp = uint64(block.timestamp);

        vm.expectEmit(true, true, false, true, address(redemption));
        emit EntitlementRedeemed(purchaseRef, seller, timestamp);

        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);
    }
}
