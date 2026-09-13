# Operator reference

[Quickstart](../README.md#quickstart) · [Manual services](../packages/README.md#manual-service-configuration)

These procedures are not needed to reproduce the fork demo. Existing deployments
and evidence must not be reset for a recording. All real spending requires operator approval.

## Deployment

The order and the two separate permission checks matter:

1. Deploy `NotaX402Settlement(storeAddress)`.
2. Have the existing registry owner authorize that adapter to consume references.
3. Deploy `EntitlementRedemption(storeAddress, [adapter])`; the store is included automatically.
4. Configure the backend with that redemption address, trusted adapter emitters,
   Base RPC, and dedicated seller key. Startup checks deployment wiring.

### Operator commands

These are operator instructions, not actions performed by the local demo. Configure
an appropriately authorized signer: `--broadcast` sends real transactions on the
selected network and spends gas. Never put private keys in command history.

```sh
forge script script/DeployNotaX402Settlement.s.sol --rpc-url "$BASE_RPC_URL" --broadcast

# Run separately with the existing registry owner's signer configuration:
# NOTA_X402_ADAPTER must be set to the adapter address returned by deployment.
cast send --rpc-url "$BASE_RPC_URL" 0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991 \
  "setConsumerAuthorization(address,bool)" "$NOTA_X402_ADAPTER" true

# Then deploy redemption with that adapter accepted:
ENTITLEMENT_ACCEPTED_CONSUMERS="$NOTA_X402_ADAPTER" \
  forge script script/DeployEntitlementRedemption.s.sol --rpc-url "$BASE_RPC_URL" --broadcast
```

The [adapter deployment script](../script/DeployNotaX402Settlement.s.sol) prints the
required registry-owner action. The [redemption deployment script](../script/DeployEntitlementRedemption.s.sol)
prints the fixed accepted-consumer set and warns when no adapters are supplied.

Without registry authorization, adapter settlement reverts with `UnauthorizedConsumer`.
Without inclusion in the redemption deployment, references consumed by that adapter
fail there with `EntitlementNotPaid`. Neither omission is fixed by changing a backend
environment variable. Adding a consumer later requires a new redemption deployment
and a plan for already-redeemed references.


### Connected demo on deployed Base mainnet contracts

**Current checkout: blocked from another paid run.** Both manifests already contain
`publicDemo`. After local configuration checks, the CLI refuses another run before
RPC preflight, confirmation or submission. There is no force, reset, resume or yes
flag. Preserve the records and guard. Use `npm run demo:connected -- --story` with
exported `BASE_RPC_URL` for repeatable recordings.

The following describes the existing operator path, **not instructions to bypass
that guard or repeat the recorded purchase**.

**Real spending, opt-in only.** The default `npm run demo:connected` remains fork-only.
`npm run demo:connected -- --live` reads the adapter/redemption addresses from
[`deployments/base.json`](../deployments/base.json); it never deploys replacements,
impersonates accounts, or fabricates balances. It runs the same HTTP flow above,
including the attacker attempt **before** the successful redemption so the rejection
demonstrates buyer binding, not merely replay protection. Authentication remains
**mock-wallet**, not World human verification.

Required environment: `BASE_RPC_URL` (HTTPS, with historical receipt/state access),
`SELLER_PRIVATE_KEY`, `BUYER_PRIVATE_KEY`, `LIVE_DEMO_USDC_AMOUNT` and
`LIVE_DEMO_STATE_DIR`. Optional `RELAYER_PRIVATE_KEY` defaults to the seller key.
A dedicated RPC is recommended: shared public endpoints can throttle this multi-step
flow. The runner does not blindly resubmit payments after a provider failure.
Seller/relayer need real Base ETH for gas; the distinct buyer needs real Base USDC.
The buyer signs EIP-3009 and access/redemption challenges, but sends no transaction.
Use dedicated, non-delegated EOA wallets and do not send other wallet transactions
while the demo runs. Keys must already be available in the process environment;
never paste them into command history or commit them.

From the repository root, with the keys and RPC already configured:

```sh
export LIVE_DEMO_USDC_AMOUNT=0.10
export LIVE_DEMO_STATE_DIR="$PWD/private-data/base-live-demo-1"
npm run demo:preflight          # read-only: no confirmation, lock, transactions or files
npm run demo:connected -- --live
```

`demo:preflight` runs the same chain, deployment, wallet and balance checks the live
run performs before its first transaction, and names the failing check (for RPC
failures, only the error type). The live run repeats these checks before the
confirmation prompt.

The amount is mandatory, accepts up to six decimals, and is capped at 10 USDC.
The original fork catalog remains 10 USDC; the live demo uses the amount you select
and labels its report as illustrative content. Inspect the displayed wallet addresses,
deployed contracts and amount, then type **`SPEND ON BASE`** at the interactive prompt.
Piped confirmation, non-interactive execution, unknown flags and `--yes` are refused.
Gas is additional and variable. Declining the initial confirmation prevents live writes;
cancelling later cannot undo transactions already submitted.

The runner checks chain ID, recorded contract bytecode/wiring, registry authorization,
wallet code, pending transactions and balances before listing creation. It derives
the listing ID from the confirmed `ListingCreated` event rather than a racy global
counter. Successful broadcasts print the transaction hash and a `basescan.org/tx/`
URL immediately; receipts require two confirmations. Unlike a fork, advancing block
height during attacker/replay attempts is normal; sender transaction counts and
redemption state still enforce the no-extra-transaction assertions.

**Recovery:** the new private directory is retained, not deleted at exit. It contains
owner-only issued orders, the buyer's original preimage bundle, listing details and
a public transaction journal. Do not share it or record its contents in the video.
Never blindly retry after a send timeout or partial failure: reconcile printed hashes
first. A new run creates a new listing/purchase; it is not a resume command. The
runner refuses an existing state directory or replacement of an already recorded demo.
A `private-data/live-demo.lock` prevents concurrent runs and remains after an incomplete
run. It is removed automatically after successful evidence recording or a controlled
story cancellation at a completed step/prompt; reconcile
the previous run before manually removing a retained lock, even if startup failed.

Only after all three scenarios and the confirmed event/receipt checks pass does it
save `public-evidence.json` in that directory and add a `publicDemo` record to **both**
deployment manifests, setting `scope.newPublicPurchaseAndRedemptionDemoRecorded`
to `true`. Those edits are local and uncommitted. Prior Graph verification counts
and World status remain unchanged: verify these new events in Studio separately.
Manifest replacement is atomic per file, not across both files; if recording fails,
use the saved public evidence to reconcile the files, **not another payment**.

**Current snapshot:** the operator-confirmed run is recorded at
`2026-09-12T16:36:35.607Z`. Both `scope.newPublicPurchaseAndRedemptionDemoRecorded`
flags are `true`, and both `publicDemo.indexVerification.status` values are
`EVENTS_INDEXED_AND_MATCHED`. These are preserved historical records, not a fresh query.
