# Arbitrum Sepolia purchase-to-redemption

[Project overview](../README.md) · [Deployment record](../deployments/arbitrum-sepolia.json) · [Run logs](../runs/)

Two purchases were run against the Arbitrum Sepolia deployment on 2026-10-03, one per path:

- **Bound:** a purchase settled through the `NotaX402Settlement` adapter, then redeemed once.
- **Attested:** a purchase paid through an x402 facilitator and recorded by the seller with
  `attestReceipt`, through `notaxyz/bazaar-seller`.

This page has two parts:

- Part one shows how to check both runs from public data alone: the bound run first,
  then [the attested run](#part-one-continued-the-attested-run). The bound run needs nothing
  installed. The attested run needs `cast` for one hash.
- Part two shows how to run the bound purchase again with your own keys.

## Part one: verify the bound run

| Value | Recorded |
| --- | --- |
| Chain | Arbitrum Sepolia (421614) |
| `purchaseRef` | `0xe553e229584ef74f9b0f82ff5c98ae933602e4c61f555d1f4fcc472229e8f26e` |
| Settlement transaction | [`0x7b03f503…d504679f`](https://sepolia.arbiscan.io/tx/0x7b03f5038eb99896f56f89b05ab806a65784c161f27129e95298af21d504679f#eventlog) (block 315,354,022) |
| Redemption transaction | [`0x47d4782e…873744e7`](https://sepolia.arbiscan.io/tx/0x47d4782e216f13ba0c9531e469f726c4677f51c322f2f711620d3942873744e7#eventlog) (block 315,354,061) |
| Adapter (`NotaX402Settlement`) | [`0x9e5c2e8E4d38f555f487d3682456Be7c616F00A8`](https://sepolia.arbiscan.io/address/0x9e5c2e8E4d38f555f487d3682456Be7c616F00A8#code) |
| Redemption (`EntitlementRedemption`) | [`0x8718D0d64F14cB9ef5ecd0c0EAC403b32dC26eEE`](https://sepolia.arbiscan.io/address/0x8718D0d64F14cB9ef5ecd0c0EAC403b32dC26eEE#code) |
| `PurchaseRefRegistry` | [`0x32aAeC7768adBBFD65C776b129616b8727d0c8bd`](https://sepolia.arbiscan.io/address/0x32aAeC7768adBBFD65C776b129616b8727d0c8bd#readContract) |

**`purchaseRef` is the join key.** The settlement event, the registry consumption and the
redemption event all carry the same `purchaseRef`. Every check below matches on it.

### 1. The settlement event

Open the [settlement transaction's event log](https://sepolia.arbiscan.io/tx/0x7b03f5038eb99896f56f89b05ab806a65784c161f27129e95298af21d504679f#eventlog).
Find `X402ReceiptSettled`, emitted by the adapter `0x9e5c…00A8`. Read these fields:

| Field | Expected |
| --- | --- |
| `receiptId` (indexed) | `1` |
| `seller` (indexed) | `0xF2E63f2339141A317e0f446Bf1d81593aBc5D557` |
| `buyer` (indexed) | `0x2Ec0888751f2F82a12F60a638A73780e2D70f5f8` |
| `listingId` | `1` |
| `purchaseRef` | `0xe553e229…e8f26e` |
| `amount` | `250000` (0.25 USDC, six decimals) |

The same transaction also contains two USDC `Transfer` events, one moving funds from the
buyer to the adapter and one moving them on from the adapter. It also contains the registry's `PurchaseRefConsumed`.

### 2. The redemption event

Open the [redemption transaction's event log](https://sepolia.arbiscan.io/tx/0x47d4782e216f13ba0c9531e469f726c4677f51c322f2f711620d3942873744e7#eventlog).
Find `EntitlementRedeemed`, emitted by the redemption contract `0x8718…6eEE`.

- **`purchaseRef`** must equal the settlement's `purchaseRef`.
- **`seller`** is the listing seller.
- **`redeemedAt`** is `1791037157`.

### 3. The registry consumed the reference, and the consumer is the adapter

On the [registry's Read Contract tab](https://sepolia.arbiscan.io/address/0x32aAeC7768adBBFD65C776b129616b8727d0c8bd#readContract),
call `consumedBy` with the `purchaseRef`. It returns `0x9e5c2e8E4d38f555f487d3682456Be7c616F00A8`.

Compare that address with what the deployment fixed:

- It is the adapter recorded in [`deployments/arbitrum-sepolia.json`](../deployments/arbitrum-sepolia.json).
- On the [redemption contract's Read Contract tab](https://sepolia.arbiscan.io/address/0x8718D0d64F14cB9ef5ecd0c0EAC403b32dC26eEE#readContract),
  `isAcceptedConsumer(0x9e5c…00A8)` returns `true`.
- `acceptedConsumers()` lists only the store and that adapter.

So the consumer is the adapter, not some other address.

**The registry is a replay guard, not evidence of a sale.** A consumed reference only shows
that some authorized module used that reference once. It does not say who sold what to whom.
The record of the sale is the `X402ReceiptSettled` event.

### 4. There is exactly one redemption

- **`redeemedAt`:** on the redemption contract's Read Contract tab, `redeemedAt(purchaseRef)`
  returns `1791037157`. Any non-zero value means the reference is redeemed.
- **A second redemption reverts:** the contract rejects any later redemption of the same
  reference with `EntitlementAlreadyRedeemed`.
- **One event:** the redemption contract's Events tab shows a single `EntitlementRedeemed`
  whose first topic is this `purchaseRef`.

The run's other two attempts never reached the chain:

- the stranger's attempt was refused with HTTP 403
- the repeat attempt was refused with HTTP 409

The redemption server's log in [`runs/`](../runs/) shows both refusals happened before any
transaction was sent.

## Part one, continued: the attested run

The same buyer and seller also ran the attested path on 2026-10-03, through
[`notaxyz/bazaar-seller`](https://github.com/notaxyz/bazaar-seller). The buyer pays
`notaxyz/x402-facilitator`, the plain x402 facilitator described under
[Warnings](#warnings), in a separate USDC transfer. The seller then records the sale itself with
`attestReceipt`. Checking it needs chain data, one published file, and `cast`.

| Value | Recorded |
| --- | --- |
| Store (`NotaReceiptStore`, `attestReceipt` build) | [`0x6b13e2077c84e1326111acBbb618E028723e2EA2`](https://sepolia.arbiscan.io/address/0x6b13e2077c84e1326111acBbb618E028723e2EA2#code) |
| `PurchaseRefRegistry` | [`0x32aAeC7768adBBFD65C776b129616b8727d0c8bd`](https://sepolia.arbiscan.io/address/0x32aAeC7768adBBFD65C776b129616b8727d0c8bd#readContract), the same registry as above |
| Payment transaction | [`0xbe3d62b4…7872f70c6`](https://sepolia.arbiscan.io/tx/0xbe3d62b4e485bd827f6a2e7ed53deba086a1f2a6d6650da9746efff7872f70c6#eventlog) (block 315,317,494) |
| Forward transaction | [`0x8d51e24c…c10a6e86`](https://sepolia.arbiscan.io/tx/0x8d51e24cb706b02901cdf2cc7c1bc0454be472e65b192e3a98960962c10a6e86#eventlog) (block 315,317,499) |
| Attestation transaction | [`0x8fe4acbc…4a32a17d9`](https://sepolia.arbiscan.io/tx/0x8fe4acbc8f60d94de4fea01cf3619766e7092375ccd1275d306d28d4a32a17d9#eventlog) (block 315,317,510) |
| `purchaseRef` | `0x4065dbc7327556345eb940dc60d2ef2cea64f77776c6f01b42c1289e13b80999` |
| Delivered bytes | [`runs/2026-10-03-arb-sepolia-attested-response-bytes.json`](../runs/2026-10-03-arb-sepolia-attested-response-bytes.json), 4,925 bytes |

**`purchaseRef` joins only the attestation and the registry consumption.** It does not
appear in the payment or the forward. Nothing on chain binds either transfer to the
attestation.

### A1. The payment

Open the [payment transaction's event log](https://sepolia.arbiscan.io/tx/0xbe3d62b4e485bd827f6a2e7ed53deba086a1f2a6d6650da9746efff7872f70c6#eventlog).
USDC (`0x75fa…AA4d`) emits `AuthorizationUsed` and one `Transfer`:

| Field | Expected |
| --- | --- |
| `from` | `0x2Ec0888751f2F82a12F60a638A73780e2D70f5f8`, the buyer |
| `to` | `0x70c2fF74596E69974cc207183F241a573201AC14`, the facilitator's signer, which also sent this transaction |
| `value` | `250000` (0.25 USDC) |

That signer also sent the settlement recorded in bazaar-seller's
[2026-10-02 run log](https://github.com/notaxyz/bazaar-seller/blob/main/runs/agent-run-2026-10-02.txt).
The payment carries no `purchaseRef`.

### A2. The forward

Open the [forward transaction's event log](https://sepolia.arbiscan.io/tx/0x8d51e24cb706b02901cdf2cc7c1bc0454be472e65b192e3a98960962c10a6e86#eventlog).
One USDC `Transfer` moves `149253` from the facilitator's signer to the seller,
`0xF2E63f2339141A317e0f446Bf1d81593aBc5D557`. No log of this run is published. The 2026-10-02 run
log records a different run through the same facilitator, at the same price, with this fee
split: `149253` to the merchant, a `747` service fee and a `100000` gas fee, out of `250000`.
The amount here matches it. Nothing on chain ties this transfer to the payment.

### A3. The attestation

Open the [attestation transaction's event log](https://sepolia.arbiscan.io/tx/0x8fe4acbc8f60d94de4fea01cf3619766e7092375ccd1275d306d28d4a32a17d9#eventlog).
The store emits `ReceiptAttested`:

| Field | Expected |
| --- | --- |
| `receiptId` | `6` |
| `seller` (indexed) | `0xF2E63f2339141A317e0f446Bf1d81593aBc5D557` |
| `buyer` (indexed) | `0x2Ec0888751f2F82a12F60a638A73780e2D70f5f8` |
| `listingId` | `1` |
| `purchaseRef` (indexed) | `0x4065dbc7…e13b80999` |
| `metadataHash` | `0xb2d6f57d87d57a6189fdf9f304114fd285b84fb6ca6b9980d395ec8e9135800d` |
| `agentId` | `0x0`: no agent identity was bound to this receipt |
| `paymentRef` | `0xbe3d62b4e485bd827f6a2e7ed53deba086a1f2a6d6650da9746efff7872f70c6`, the payment transaction |

The seller sent this transaction. The same transaction contains the registry's
`PurchaseRefConsumed` for the same `purchaseRef`.

**`paymentRef` is a seller assertion.** The seller chose it and passed it to
`attestReceipt`. It points at the payment transaction above, but nothing on chain binds
that payment to this attestation. The store never saw the transfer, and the event carries
no amount. bazaar-seller's own verifier labels `paymentRef` "not evidence of payment". The
attestation is the seller's own commitment, not something the contract witnessed.

### A4. The registry consumed the reference, and the consumer is the store

On the [registry's Read Contract tab](https://sepolia.arbiscan.io/address/0x32aAeC7768adBBFD65C776b129616b8727d0c8bd#readContract),
call `consumedBy` with the `purchaseRef`. It returns the store,
`0x6b13e2077c84e1326111acBbb618E028723e2EA2`, because `attestReceipt` consumes through the
store. In the run above, the consumer is the adapter.

### A5. The attestation commits to the delivered bytes

The published file is the response body exactly as the buyer's client saved it on receipt.
Download it and hash it:

```bash
curl -sL https://raw.githubusercontent.com/notaxyz/entitlements/main/runs/2026-10-03-arb-sepolia-attested-response-bytes.json -o attested-response.json
wc -c < attested-response.json
cast keccak 0x$(od -An -v -tx1 attested-response.json | tr -d ' \n')
```

`wc` prints `4925`. `cast keccak` prints
`0xb2d6f57d87d57a6189fdf9f304114fd285b84fb6ca6b9980d395ec8e9135800d`, the attestation's
`metadataHash`. The `od` pipeline passes the file to `cast` as hex, so every byte is hashed
exactly as stored. From a clone, run the last command on the file in `runs/` directly.

**The contrast with the run above is the point of shipping both paths.** There, `purchaseRef`
is a real join key: the adapter moved the funds and emitted `X402ReceiptSettled` with that
`purchaseRef` in the same transaction. Here, the contract witnessed only the seller's claim.

## Part two: reproduce it yourself

**You need three keys you will not have from this repository:**

- **Seller key:** must own a signed-quote listing on the store. Listing 1 belongs to
  `0xF2E6…D557`, so you will create your own listing (step 3 below).
- **Facilitator key:** must hold a little Arbitrum Sepolia ETH, because it sends the
  settlement transaction.
- **Buyer key:** must hold Arbitrum Sepolia USDC. The buyer only signs; it needs no ETH.

The seller and facilitator may be the same wallet. In that case it pays gas for both the
settlement and the redemption.

### 1. Prerequisites

You need:

- Node.js 22 (minimum 20.19)
- Foundry, for `cast`
- an Arbitrum Sepolia RPC endpoint

Then clone with submodules and install:

```bash
git clone --recurse-submodules https://github.com/notaxyz/entitlements.git
cd entitlements
npm ci
```

Already cloned? Run `git submodule update --init --recursive`.

This demo does not need the submodules or `forge build`. The runner, the preflight and the
three services run TypeScript through `tsx`, and none of them reads Solidity build output or
anything under `lib/`. Foundry is needed here only for `cast`. The submodules matter only if
you also build or test the contracts.

### 2. Roles

| Role | Entry point | Key | Needs |
| --- | --- | --- | --- |
| Facilitator | `npm run facilitator` | facilitator | Arbitrum Sepolia ETH. Submits `settleWithAuthorization` to the allowlisted adapter |
| Resource server | `npm run resource-server` | seller | Signs quotes for the listing. Serves content once settlement is found |
| Redemption server | `npm run redemption-server` | seller | Arbitrum Sepolia ETH. Submits the redemption transaction as the listing seller |
| Runner (buyer) | `npm run demo:arb-sepolia` | buyer | Arbitrum Sepolia USDC, at least the catalog price of 0.25 USDC |

### 3. Create your own listing

Skip this step only if your seller key already owns listing 1.

The store takes a signed-quote listing with `unitPrice` 0 and mode `1` (`SignedQuoteOnly`).
Each order's price comes from the seller-signed quote. `listingHash` can be any non-zero
32-byte value. `--interactive` prompts for the seller key.

```bash
cast send 0x6b13e2077c84e1326111acBbb618E028723e2EA2 "createListing(bytes32,uint256,uint8)" $(cast keccak "my-arbitrum-sepolia-listing") 0 1 --rpc-url "$RPC_URL" --interactive
```

Find the new listing id in the `ListingCreated` event of that transaction, then set `LISTING_ID` to it.

### 4. Fund the buyer

The buyer needs Circle's Arbitrum Sepolia USDC, `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`.
Get it from Circle's testnet faucet, or transfer it from a wallet that already holds some.

The facilitator, and the seller if it runs the redemption server, need Arbitrum Sepolia ETH
from any Arbitrum Sepolia faucet.

### 5. Environment

The scripts do not load `.env`. Export each variable in the terminal that needs it, and
enter keys with `read -s` so they stay out of shell history.

`QUOTE_STORE_PATH` holds the redemption secrets the buyer needs, so it must stay
git-ignored. Use a path under the repository's ignored `private-data/` directory, or a
private directory outside the repository. The resource server and redemption server must use
the same file.

| Variable | Value for this deployment | Facilitator | Resource server | Redemption server | Runner | Preflight |
| --- | --- | :-: | :-: | :-: | :-: | :-: |
| `RPC_URL` | your Arbitrum Sepolia endpoint | ✓ | ✓ | ✓ | ✓ | ✓ |
| `CHAIN_ID` | `421614` (defaults to Base, 8453) | ✓ | ✓ | ✓ | ✓ | |
| `FACILITATOR_PRIVATE_KEY` | facilitator key (`read -s`) | ✓ | | | | |
| `FACILITATOR_PORT` | `4021` (default) | ✓ | | | | |
| `NOTA_X402_ADAPTER` | `0x9e5c2e8E4d38f555f487d3682456Be7c616F00A8` | ✓ | ✓ | | ✓ | |
| `SELLER_PRIVATE_KEY` | seller key (`read -s`) | | ✓ | ✓ | | ✓ |
| `QUOTE_STORE_PATH` | absolute, git-ignored path to `issued-orders.json` | | ✓ | ✓ | | ✓ |
| `NOTA_RECEIPT_STORE` | `0x6b13e2077c84e1326111acBbb618E028723e2EA2` | | ✓ | ✓ | ✓ | |
| `SETTLEMENT_TOKEN` | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | | ✓ | | ✓ | |
| `PURCHASE_REF_REGISTRY` | `0x32aAeC7768adBBFD65C776b129616b8727d0c8bd` | | ✓ | | ✓ | |
| `LISTING_ID` | your listing id (default `1`) | | ✓ | | | ✓ |
| `FROM_BLOCK` | a recent block number, before your purchase | | ✓ | | | |
| `RESOURCE_PORT` | `4020` (default) | | ✓ | | | |
| `RESOURCE_BASE_URL` | `http://127.0.0.1:4020` (default) | | ✓ | | | |
| `FACILITATOR_URL` | `http://127.0.0.1:4021` (default) | | ✓ | | | |
| `AGENT_AUTH_MODE` | `mock` (required) | | | ✓ | | |
| `ENTITLEMENT_REDEMPTION` | `0x8718D0d64F14cB9ef5ecd0c0EAC403b32dC26eEE` | | | ✓ | ✓ | |
| `REDEMPTION_ADAPTERS` | `0x9e5c2e8E4d38f555f487d3682456Be7c616F00A8` | | | ✓ | | |
| `REDEMPTION_PORT` | `4022` (default) | | | ✓ | | |
| `REDEMPTION_BASE_URL` | `http://127.0.0.1:4022` (default) | | | ✓ | ✓ | |
| `REDEMPTION_CONFIRMATIONS` | `2` (default) | | | ✓ | | |
| `RESOURCE_URL` | `http://127.0.0.1:4020/reports/arbitrum-sepolia-sample-report` | | | | ✓ | |
| `BUYER_PRIVATE_KEY` | buyer key (`read -s`) | | | | ✓ | ✓ (or `BUYER_ADDRESS`) |
| `BUYER_ADDRESS` | buyer address, instead of the key | | | | | ✓ |
| `MAX_AMOUNT` | `1000000`, the most the buyer will pay (default 1 USDC) | | | | ✓ | |

Notes on the table:

- **`FROM_BLOCK`:** the resource server looks for the settlement with one `eth_getLogs` query
  from `FROM_BLOCK` to the latest block, and RPC providers cap that range. Set it just before
  you start the services:

  ```bash
  export FROM_BLOCK=$(( $(cast block-number --rpc-url "$RPC_URL") - 100 ))
  ```

  Measured on 2026-10-04, the official endpoint `https://sepolia-rollup.arbitrum.io/rpc` rejects
  ranges over 10,000,000 blocks. That is about 29 days at Arbitrum Sepolia's four blocks a
  second. `https://arbitrum-sepolia-rpc.publicnode.com` rejects ranges over 50,000 blocks, about
  three and a half hours. The range grows as the chain advances, so on a low-cap provider a
  `FROM_BLOCK` that worked at startup stops working once the chain moves past the cap. Restart
  the resource server with a fresh value. When the query is rejected, the resource server
  answers HTTP 503. Without `FROM_BLOCK`, the search starts at block 0, which both endpoints
  reject.
- **Preflight addresses:** the preflight script reads every contract address from the
  deployment record, not from these variables.

### 6. Ports

| Port | Service |
| --- | --- |
| 4020 | Resource server |
| 4021 | Facilitator |
| 4022 | Redemption server |

All three listen on `127.0.0.1`. The checkout request carries the buyer's redemption secrets,
so the runner refuses any resource URL that is neither HTTPS nor loopback. Don't put these
services behind a tunnel.

### 7. Preflight first

```bash
npm run preflight:arb-sepolia
```

The preflight reads chain state only and sends no transactions. It prints `PASS` or `FAIL` for each check:

- the chain id
- the adapter's store, token and registry
- that the registry authorizes the adapter
- that the redemption contract accepts the adapter
- that purchases are not paused
- that the listing seller matches `SELLER_PRIVATE_KEY`
- that the buyer's USDC balance covers the price, printing both numbers
- that `QUOTE_STORE_PATH` is absolute, writable, and outside the repository or git-ignored

It exits non-zero if any check fails, so a misconfiguration shows up as one line instead of a failed run.

### 8. Start the services, then the runner

Use one terminal per service, each with its variables from the table above exported. Start
them in this order:

```bash
npm run facilitator
```

```bash
npm run resource-server
```

```bash
npm run redemption-server
```

Then, in a fourth terminal:

```bash
npm run demo:arb-sepolia
```

### 9. Expected output

The runner settles the purchase, then makes three redemption attempts in this order:

| Attempt | Who | Expected |
| --- | --- | --- |
| 1 | A newly generated wallet that holds nothing, with the correct bundle | `HTTP 403 BUYER_MISMATCH step 6`, no transaction |
| 2 | The paying wallet | `HTTP 201`, a redemption transaction hash, `EntitlementRedeemed emitted` |
| 3 | The paying wallet again | `HTTP 409 ALREADY_REDEEMED step 5`, no second transaction |

The stranger goes first so that its rejection cannot be confused with an "already redeemed" rejection.

The run ends with `PASS. Paid once, redeemed once, by the paying wallet only.` The
redemption server logs one JSON line per attempt. See the captures in [`runs/`](../runs/).

The runner never prints the redemption secrets, `rawPurchaseRef` and `purchaseRefNonce`.
Keep it that way. Note that the redemption transaction's calldata publishes them on-chain,
so they are not a lasting secret once redeemed.

### Warnings

**Do not set `NODE_ENV=production`.** The redemption server refuses mock mode in production,
and this demo requires `AGENT_AUTH_MODE=mock`.

**Set the RPC and chain on every service.**

- **RPC variable:** all three services read `RPC_URL`. Set it to your Arbitrum Sepolia
  endpoint. Do **not** point `BASE_RPC_URL` at Arbitrum: it is the Base mainnet RPC for the
  Base fork tests and the Base live demo, which require chain 8453. A terminal with it set to
  Arbitrum would fork the wrong chain the next time you run `npm test`.
- **Check the first line of output:** the redemption server's `redemption.started` line
  includes the `chainId` its RPC actually reported. It should be `421614`.
- **Chain id:** `CHAIN_ID` defaults to Base (8453) in the facilitator, resource server and
  redemption server. Set `CHAIN_ID=421614` in every terminal. On a mismatch, the redemption
  server refuses to start.

**Use this repository's facilitator, not `notaxyz/x402-facilitator`.** This organization has
two unrelated facilitators, and they are not interchangeable:

- **This repository's facilitator** ([`packages/facilitator`](../packages/facilitator)) listens
  on port 4021. It submits `settleWithAuthorization` only to an allowlisted
  `NotaX402Settlement` adapter, which settles a seller-signed Nota quote.
- **[`notaxyz/x402-facilitator`](https://github.com/notaxyz/x402-facilitator)** is a different
  service on a different port. It implements the plain x402 `/verify` and `/settle` API: the
  buyer pays the facilitator's signer, which takes its own service and gas fees before
  forwarding to the merchant.

Their fee models are incompatible. Pointing the resource server at the wrong one produces a
settlement failure that looks like a contract bug.

The attestation flow is a separate scheme in a separate repository,
[`notaxyz/bazaar-seller`](https://github.com/notaxyz/bazaar-seller). To verify its recorded
run, see [the attested run](#part-one-continued-the-attested-run) in part one.

## Limitations

- **Testnet only.** Arbitrum Sepolia is a testnet, and its USDC has no value.
- **Wallet control, not identity.** The redemption server's authorization is a mock
  wallet-signature check. It proves control of the wallet that paid. It is not World ID, not
  an AgentBook lookup, and not human verification.
- **Not an audit.** A deployment, verified source and a passing run are not a security audit.

See [SECURITY.md](../SECURITY.md) for the trust assumptions and the guarantees this does not make.
