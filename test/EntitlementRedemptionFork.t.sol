// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { EntitlementRedemption } from "../src/EntitlementRedemption.sol";
import { INotaReceiptStore } from "../src/interfaces/INotaReceiptStore.sol";
import { IPurchaseRefRegistry } from "../src/interfaces/IPurchaseRefRegistry.sol";

contract EntitlementRedemptionForkTest is Test {
    address internal constant NOTA_RECEIPT_STORE = 0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88;
    address internal constant PURCHASE_REF_REGISTRY = 0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991;

    uint256 internal constant LISTING_ID = 1;
    bytes32 internal constant RECEIPT_ONE_PURCHASE_REF =
        0x5333d780992fdf98c143083b765392aeaa27cb393a034235026f57f202806770;

    INotaReceiptStore internal store;
    IPurchaseRefRegistry internal registry;
    EntitlementRedemption internal redemption;
    address internal seller;

    event EntitlementRedeemed(
        bytes32 indexed purchaseRef, address indexed seller, uint64 redeemedAt
    );

    function setUp() public {
        string memory baseRpcUrl = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(baseRpcUrl).length == 0) {
            vm.skip(true, "BASE_RPC_URL is not set");
        }

        vm.createSelectFork(baseRpcUrl);

        store = INotaReceiptStore(NOTA_RECEIPT_STORE);
        registry = IPurchaseRefRegistry(PURCHASE_REF_REGISTRY);
        redemption = new EntitlementRedemption(NOTA_RECEIPT_STORE);
        seller = store.getListing(LISTING_ID).seller;

        assertTrue(seller != address(0), "listing 1 must exist");
        assertEq(address(redemption.PURCHASE_REF_REGISTRY()), PURCHASE_REF_REGISTRY);
        assertEq(registry.consumedBy(RECEIPT_ONE_PURCHASE_REF), NOTA_RECEIPT_STORE);
    }

    function test_RedeemsConsumedPurchaseRefAsSeller() public {
        (string memory rawPurchaseRef, bytes32 nonce) = _receiptOneBundle();

        vm.prank(seller);
        bytes32 purchaseRef = redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);

        assertEq(purchaseRef, RECEIPT_ONE_PURCHASE_REF);
        assertEq(uint256(redemption.redeemedAt(purchaseRef)), block.timestamp);
    }

    function test_RevertsForWrongPreimageBundle() public {
        string memory rawPurchaseRef = "wrong-receipt-1-reference";
        bytes32 wrongNonce = keccak256("wrong-receipt-1-nonce");
        bytes32 wrongPurchaseRef =
            store.hashPurchaseRef(seller, LISTING_ID, rawPurchaseRef, wrongNonce);

        assertNotEq(wrongPurchaseRef, RECEIPT_ONE_PURCHASE_REF);
        assertEq(registry.consumedBy(wrongPurchaseRef), address(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementRedemption.EntitlementNotPaid.selector, wrongPurchaseRef
            )
        );
        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, wrongNonce);
    }

    function test_RevertsForNonSellerCaller() public {
        address caller = makeAddr("non-seller");

        vm.expectRevert(
            abi.encodeWithSelector(EntitlementRedemption.CallerNotSeller.selector, caller, seller)
        );
        vm.prank(caller);
        redemption.redeemEntitlement(LISTING_ID, "unused", bytes32(0));
    }

    function test_RevertsForUnpaidReference() public {
        string memory rawPurchaseRef = "definitely-unpaid-entitlement";
        bytes32 nonce = keccak256("unpaid-nonce");
        bytes32 purchaseRef = store.hashPurchaseRef(seller, LISTING_ID, rawPurchaseRef, nonce);

        assertEq(registry.consumedBy(purchaseRef), address(0));

        vm.expectRevert(
            abi.encodeWithSelector(EntitlementRedemption.EntitlementNotPaid.selector, purchaseRef)
        );
        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);
    }

    function test_RevertsForDoubleRedemption() public {
        (string memory rawPurchaseRef, bytes32 nonce) = _receiptOneBundle();

        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);

        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementRedemption.EntitlementAlreadyRedeemed.selector, RECEIPT_ONE_PURCHASE_REF
            )
        );
        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);
    }

    function test_RevertsForNonexistentListing() public {
        vm.expectRevert(INotaReceiptStore.ListingNotFound.selector);
        redemption.redeemEntitlement(type(uint256).max, "unused", bytes32(0));
    }

    function test_EmitsCorrectEventFields() public {
        (string memory rawPurchaseRef, bytes32 nonce) = _receiptOneBundle();
        uint64 timestamp = uint64(block.timestamp);

        vm.expectEmit(true, true, false, true, address(redemption));
        emit EntitlementRedeemed(RECEIPT_ONE_PURCHASE_REF, seller, timestamp);

        vm.prank(seller);
        redemption.redeemEntitlement(LISTING_ID, rawPurchaseRef, nonce);
    }

    function _receiptOneBundle() internal returns (string memory rawPurchaseRef, bytes32 nonce) {
        rawPurchaseRef = vm.envOr("RECEIPT_1_RAW_PURCHASE_REF", string(""));
        string memory nonceText = vm.envOr("RECEIPT_1_PURCHASE_REF_NONCE", string(""));

        if (bytes(rawPurchaseRef).length == 0 || bytes(nonceText).length == 0) {
            vm.skip(true, "receipt 1 preimage bundle env vars are not set");
        }

        nonce = vm.parseBytes32(nonceText);

        bytes32 reconstructed = store.hashPurchaseRef(seller, LISTING_ID, rawPurchaseRef, nonce);
        assertEq(reconstructed, RECEIPT_ONE_PURCHASE_REF, "receipt 1 preimage bundle mismatch");
    }
}
