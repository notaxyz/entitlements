// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { Script, console } from "forge-std/Script.sol";

import { NotaX402Settlement } from "../src/NotaX402Settlement.sol";
import { IPurchaseRefRegistry } from "../src/interfaces/IPurchaseRefRegistry.sol";

/// @notice Deploys `NotaX402Settlement` against a deployed Nota receipt store.
/// @dev THE DEPLOYMENT IS NOT USABLE ON ITS OWN. The adapter consumes purchase references in the
///      shared `PurchaseRefRegistry`, and the registry owner must authorize it first:
///
///          registry.setConsumerAuthorization(<adapter address>, true)
///
///      Until that owner transaction lands, every `settleWithAuthorization` call reverts with
///      `UnauthorizedConsumer(<adapter address>)`. This script prints the exact call to make.
contract DeployNotaX402Settlement is Script {
    address internal constant BASE_NOTA_RECEIPT_STORE = 0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88;

    function run() external returns (NotaX402Settlement adapter) {
        address storeAddress = vm.envOr("NOTA_RECEIPT_STORE", BASE_NOTA_RECEIPT_STORE);

        vm.startBroadcast();
        adapter = new NotaX402Settlement(storeAddress);
        vm.stopBroadcast();

        IPurchaseRefRegistry registry = adapter.PURCHASE_REF_REGISTRY();

        console.log("NotaX402Settlement:  %s", address(adapter));
        console.log("NotaReceiptStore:    %s", address(adapter.STORE()));
        console.log("PurchaseRefRegistry: %s", address(registry));
        console.log("SettlementToken:     %s", address(adapter.SETTLEMENT_TOKEN()));
        console.log("");
        console.log(
            "REQUIRED POST-DEPLOY STEP, run by the PurchaseRefRegistry owner (%s):",
            registry.owner()
        );
        console.log("  cast send %s \\", address(registry));
        console.log('    "setConsumerAuthorization(address,bool)" %s true', address(adapter));
        console.log("");
        console.log(
            "Until then every settleWithAuthorization call reverts with UnauthorizedConsumer."
        );
    }
}
