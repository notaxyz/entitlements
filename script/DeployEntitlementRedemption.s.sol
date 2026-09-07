// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { EntitlementRedemption } from "../src/EntitlementRedemption.sol";

/// @notice Deploys `EntitlementRedemption` against a receipt store and a set of settlement
///         modules whose consumption of a purchase reference counts as payment.
/// @dev DEPLOY THE SETTLEMENT MODULES FIRST. The accepted set is fixed at construction, and a
///      purchase settled through a module that is not in it can never be redeemed here. Pass the
///      adapter address through `ENTITLEMENT_ACCEPTED_CONSUMERS` as a comma-separated list; the
///      receipt store is always accepted and must not be listed again.
contract DeployEntitlementRedemption is Script {
    address internal constant BASE_NOTA_RECEIPT_STORE = 0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88;

    function run() external returns (EntitlementRedemption redemption) {
        address storeAddress = vm.envOr("NOTA_RECEIPT_STORE", BASE_NOTA_RECEIPT_STORE);
        address[] memory additionalConsumers =
            vm.envOr("ENTITLEMENT_ACCEPTED_CONSUMERS", ",", new address[](0));

        if (additionalConsumers.length == 0) {
            console.log("WARNING: no additional consumers.");
            console.log("Only purchases settled directly through the store will be redeemable.");
            console.log("x402 settlements will revert with EntitlementNotPaid.");
            console.log("");
        }

        vm.startBroadcast();
        redemption = new EntitlementRedemption(storeAddress, additionalConsumers);
        vm.stopBroadcast();

        console.log("EntitlementRedemption: %s", address(redemption));
        console.log("NotaReceiptStore:      %s", address(redemption.STORE()));
        console.log("PurchaseRefRegistry:   %s", address(redemption.PURCHASE_REF_REGISTRY()));
        console.log("");
        console.log("Accepted settlement modules (fixed for the life of this deployment):");

        address[] memory accepted = redemption.acceptedConsumers();
        for (uint256 i = 0; i < accepted.length; i++) {
            console.log("  %s", accepted[i]);
        }
    }
}
