// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { NotaReceiptStore } from "nota-contracts/NotaReceiptStore.sol";
import { PurchaseRefRegistry } from "nota-contracts/PurchaseRefRegistry.sol";

import { EntitlementRedemption } from "../src/EntitlementRedemption.sol";
import { MockEIP3009Token } from "./mocks/MockEIP3009Token.sol";

/// @notice What a redemption proves when the listing's own seller produced the payment record.
/// @dev Real `NotaReceiptStore` and `PurchaseRefRegistry` from the pinned `lib/nota-contracts`
///      submodule, real `EntitlementRedemption`; no mocks of either side and no off-chain policy.
///      A seller can always reach `EntitlementRedeemed` on its own listing at no net cost. What
///      the invariants below pin is that nobody else can: not the buyer an attestation names, and
///      not a seller acting on another seller's listing.
contract AttestReceiptRedemptionTest is Test {
    MockEIP3009Token internal usdc;
    PurchaseRefRegistry internal registry;
    NotaReceiptStore internal store;
    EntitlementRedemption internal redemption;

    address internal feeRecipient = address(0xFEE);
    address internal attacker;
    uint256 internal attackerKey;
    address internal attackerControlledBuyer = makeAddr("attacker-controlled-buyer");
    address internal victimSeller = makeAddr("victim-seller");

    string internal rawPurchaseRef = "attacker-chosen-ref";
    bytes32 internal purchaseRefNonce = keccak256("attacker-chosen-nonce");
    bytes32 internal metadataHash = keccak256("any-non-zero-metadata");

    function setUp() public {
        (attacker, attackerKey) = makeAddrAndKey("attacker");
        usdc = new MockEIP3009Token();
        registry = new PurchaseRefRegistry(address(this));
        store = new NotaReceiptStore(
            address(usdc), address(registry), feeRecipient, 0, address(this)
        );
        registry.setConsumerAuthorization(address(store), true);
        redemption = new EntitlementRedemption(address(store), new address[](0));
    }

    function _deployMaxFeeStore()
        internal
        returns (NotaReceiptStore feeStore, EntitlementRedemption feeRedemption)
    {
        feeStore = new NotaReceiptStore(
            address(usdc),
            address(registry),
            feeRecipient,
            store.MAX_PROTOCOL_FEE_BPS(),
            address(this)
        );
        registry.setConsumerAuthorization(address(feeStore), true);
        feeRedemption = new EntitlementRedemption(address(feeStore), new address[](0));
    }

    function _createListingAs(address who) internal returns (uint256 listingId) {
        vm.prank(who);
        listingId = store.createListing(
            keccak256(abi.encode(who)), 0, NotaReceiptStore.ListingMode.SignedQuoteOnly
        );
    }

    function _attestAs(address who, uint256 listingId, address buyer, bytes32 ref) internal {
        vm.prank(who);
        store.attestReceipt(listingId, buyer, ref, metadataHash, bytes32(0), bytes32(0));
    }

    /// @dev The path completes. An address with no USDC and no prior standing creates a listing,
    ///      attests a reference of its own choosing, and redeems it as that listing's seller.
    ///      The `buyer` it names is irrelevant: redemption never reads a buyer.
    function test_UnpaidAttestation_RedeemsForAttestingSeller_WithNoUsdcMoved() public {
        uint256 supplyBefore = usdc.totalSupply();
        assertEq(usdc.balanceOf(attacker), 0);

        uint256 listingId = _createListingAs(attacker);
        bytes32 ref = store.hashPurchaseRef(attacker, listingId, rawPurchaseRef, purchaseRefNonce);

        _attestAs(attacker, listingId, attacker, ref);
        assertEq(registry.consumedBy(ref), address(store));
        assertTrue(redemption.isAcceptedConsumer(address(store)));

        vm.prank(attacker);
        bytes32 redeemed = redemption.redeemEntitlement(listingId, rawPurchaseRef, purchaseRefNonce);

        assertEq(redeemed, ref);
        assertEq(uint256(redemption.redeemedAt(ref)), block.timestamp);
        assertEq(usdc.totalSupply(), supplyBefore);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(address(store)), 0);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    /// @dev Prior art for the path above: `purchaseReceipt` has no buyer != seller check, so a
    ///      seller can buy its own listing and redeem it. At `MIN_PURCHASE_AMOUNT` even the maximum
    ///      protocol fee rounds to zero, so the seller ends with the balance it started with.
    function test_SelfPurchase_AtMinimumPrice_RedeemsForSeller_WithNoNetUsdcCost() public {
        (NotaReceiptStore feeStore, EntitlementRedemption feeRedemption) = _deployMaxFeeStore();
        uint256 price = feeStore.MIN_PURCHASE_AMOUNT();
        usdc.mint(attacker, price);

        vm.startPrank(attacker);
        uint256 listingId = feeStore.createListing(
            keccak256("self"), price, NotaReceiptStore.ListingMode.PublicFixedPrice
        );
        bytes32 ref =
            feeStore.hashPurchaseRef(attacker, listingId, rawPurchaseRef, purchaseRefNonce);
        usdc.approve(address(feeStore), price);
        feeStore.purchaseReceipt(listingId, ref, price);
        feeRedemption.redeemEntitlement(listingId, rawPurchaseRef, purchaseRefNonce);
        vm.stopPrank();

        assertEq(registry.consumedBy(ref), address(feeStore));
        assertEq(uint256(feeRedemption.redeemedAt(ref)), block.timestamp);
        assertEq(usdc.balanceOf(attacker), price);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    /// @dev The same holds on a listing priced well above the minimum: a signed quote's amount is
    ///      independent of `unitPrice`, and nothing stops the seller from quoting itself at
    ///      `MIN_PURCHASE_AMOUNT` and paying that quote.
    function test_SelfSignedQuote_AtMinimumPrice_OnHigherPricedListing_WithNoNetUsdcCost() public {
        (NotaReceiptStore feeStore, EntitlementRedemption feeRedemption) = _deployMaxFeeStore();
        uint256 price = feeStore.MIN_PURCHASE_AMOUNT();
        usdc.mint(attacker, price);

        vm.prank(attacker);
        uint256 listingId = feeStore.createListing(
            keccak256("expensive"), 100e6, NotaReceiptStore.ListingMode.PublicFixedPrice
        );
        bytes32 ref =
            feeStore.hashPurchaseRef(attacker, listingId, rawPurchaseRef, purchaseRefNonce);

        NotaReceiptStore.SignedReceiptQuote memory quote = NotaReceiptStore.SignedReceiptQuote({
            listingId: listingId,
            buyer: attacker,
            purchaseRef: ref,
            amount: price,
            metadataHash: metadataHash,
            agentId: bytes32(0),
            integratorFeeRecipient: address(0),
            integratorFeeAmount: 0,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 hours)
        });
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(attackerKey, feeStore.hashSignedReceiptQuote(quote));

        vm.startPrank(attacker);
        usdc.approve(address(feeStore), price);
        feeStore.purchaseSignedReceipt(quote, abi.encodePacked(r, s, v), address(0));
        feeRedemption.redeemEntitlement(listingId, rawPurchaseRef, purchaseRefNonce);
        vm.stopPrank();

        assertEq(uint256(feeRedemption.redeemedAt(ref)), block.timestamp);
        assertEq(usdc.balanceOf(attacker), price);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    /// @dev Invariant: the address an attestation names as `buyer` cannot redeem. Redemption is
    ///      callable only by the listing seller, so naming a controlled buyer gains nothing.
    function test_UnpaidAttestation_NamedBuyerCannotRedeem_CallerNotSeller() public {
        uint256 listingId = _createListingAs(attacker);
        bytes32 ref = store.hashPurchaseRef(attacker, listingId, rawPurchaseRef, purchaseRefNonce);
        _attestAs(attacker, listingId, attackerControlledBuyer, ref);

        vm.prank(attackerControlledBuyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementRedemption.CallerNotSeller.selector, attackerControlledBuyer, attacker
            )
        );
        redemption.redeemEntitlement(listingId, rawPurchaseRef, purchaseRefNonce);
    }

    /// @dev Invariant: an attacker cannot redeem against another seller's listing. Even with the
    ///      victim's reference attested and the victim's preimage in hand, the caller check fails.
    function test_UnpaidAttestation_CannotRedeemAgainstAnotherSellersListing_CallerNotSeller()
        public
    {
        uint256 victimListingId = _createListingAs(victimSeller);
        uint256 attackerListingId = _createListingAs(attacker);
        bytes32 victimRef =
            store.hashPurchaseRef(victimSeller, victimListingId, rawPurchaseRef, purchaseRefNonce);

        _attestAs(attacker, attackerListingId, attacker, victimRef);
        assertEq(registry.consumedBy(victimRef), address(store));

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementRedemption.CallerNotSeller.selector, attacker, victimSeller
            )
        );
        redemption.redeemEntitlement(victimListingId, rawPurchaseRef, purchaseRefNonce);
    }

    /// @dev Invariant: what a redemption does prove is consumption. Once redeemed, the same
    ///      reference cannot be redeemed again through this deployment, whoever produced it.
    function test_UnpaidAttestation_CannotBeRedeemedTwice_EntitlementAlreadyRedeemed() public {
        uint256 listingId = _createListingAs(attacker);
        bytes32 ref = store.hashPurchaseRef(attacker, listingId, rawPurchaseRef, purchaseRefNonce);
        _attestAs(attacker, listingId, attacker, ref);

        vm.startPrank(attacker);
        redemption.redeemEntitlement(listingId, rawPurchaseRef, purchaseRefNonce);
        vm.expectRevert(
            abi.encodeWithSelector(EntitlementRedemption.EntitlementAlreadyRedeemed.selector, ref)
        );
        redemption.redeemEntitlement(listingId, rawPurchaseRef, purchaseRefNonce);
        vm.stopPrank();
    }
}
