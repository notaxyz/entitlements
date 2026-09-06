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

        redemption = new EntitlementRedemption(address(store));
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

    function test_ReferenceConsumedByAnotherModuleFails() public {
        registry.setConsumedBy(purchaseRef, makeAddr("other-authorized-module"));

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
