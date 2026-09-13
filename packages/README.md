# Nota x402 layer

An agent discovers a paid resource, sees an itemised list of what it is buying, verifies that the seller signed exactly that, pays without holding ETH, and gets the resource back with an on-chain receipt.

**This is one vertical path, not general x402 support.** It settles Nota quotes through `NotaX402Settlement` and nothing else. There is no PayAI integration and no generalized-facilitator compatibility: the facilitator here only submits `settleWithAuthorization`, only to adapters on its allowlist, and the resource server only accepts payment it can find as an `X402ReceiptSettled` event. Pointing this at a non-Nota x402 server, or a non-Nota facilitator at these payloads, will not work and is not meant to.

Nota receipts are distinct from x402's optional Signed Offers & Receipts extension;
tested interoperability is not claimed. See the [root README](../README.md#backend-architecture).

## Packages

| Package | What it is |
| --- | --- |
| [`x402-nota`](./x402-nota) | Shared types, the extension payload, EIP-712 and EIP-3009 typed data, JCS canonicalization, and the buyer-side verification |
| [`facilitator`](./facilitator) | Nota-aware relayer. Submits the settlement and pays the gas |
| [`resource-server`](./resource-server) | One paid endpoint. Returns 402 with the extension, and the resource once settlement is on chain |
| [`client`](./client) | The buying agent. Parses the 402, verifies, signs, relays, retries |
| [`e2e`](./e2e) | Fork fixture and the end-to-end test |

## The flow

The client is programmatic purchasing tooling, not an LLM reasoning demonstration.
The report content is illustrative. Payment, content access and redemption are
separate operations:

```mermaid
sequenceDiagram
    participant A as Buyer client
    participant M as Resource server
    participant F as Facilitator
    participant B as Base contracts
    participant R as Redemption endpoint
    A->>A: Generate original preimage bundle
    A->>M: Private POST /reports/:id + X-PAYER + bundle
    M->>B: hashPurchaseRef (RPC sees bundle)
    M->>M: Persist order and merchant-held bundle copy
    M-->>A: 402 + buyer-bound quote + itemized metadata + public purchaseRef
    A->>B: Reconstruct own bundle commitment; verify trusted wiring and seller quote
    A->>A: Verify metadata hash and total; sign EIP-3009
    A->>F: POST /settle (quote + payment signature, no bundle)
    F->>B: settleWithAuthorization (relayer pays gas)
    B-->>F: X402ReceiptSettled
    F-->>A: Settlement transaction / public purchaseRef
    A->>M: POST /access/challenge (public purchaseRef)
    M-->>A: Single-use buyer access challenge
    A->>A: Verify challenge and sign with buyer wallet
    A->>M: Paid GET + X-PAYMENT + X-PAYMENT-AUTH
    M->>B: Verify adapter settlement and registry consumption
    M->>M: Verify signed access challenge against buyer
    M-->>A: Content + receipt + merchant-held bundle copy
    Note over A,M: Content is delivered BEFORE redemption; recovery repeats signed access after restart
    A->>R: Fresh redemption challenge, then signed POST /v1/redemptions + bundle + purchaseTxHash
    R->>B: Verify receipt/order, consumedBy and redeemedAt
    R->>R: Require authenticated wallet == receipt buyer
    R->>B: Seller submits redeemEntitlement (bundle becomes public calldata)
    B-->>R: EntitlementRedeemed
    R-->>A: 201 REDEEMED
```

`purchaseRef` is a public commitment/join key, not a password. The preimage bundle
is `rawPurchaseRef` + `purchaseRefNonce`; it is absent from public payment messages.
`X-PAYER` declares a buyer before purchase but does not authenticate that wallet.
Paid access and redemption use **different** signed challenge protocols.

## What the extension adds

Plain x402 tells an agent a price. The `nota.receipt.v1` extension tells it **what the price is for**, and lets it check that claim against something the seller signed:

- the seller-signed `SignedReceiptQuote`, the signature, and the claimed signer
- the canonical checkout metadata document, inline or by URI
- the adapter address the payment authorization must name
- the store, settlement token, and registry the quote is bound to

The buyer recomputes `keccak256(JCS(document))` and compares it with `quote.metadataHash` **before signing anything**. A mismatch is refused and logged with every reason. It also checks the itemised lines add up to the total, that the total is the amount being charged, and that the document describes the resource actually requested — a seller can sign a document that is internally inconsistent, and that is still not a purchase worth making.

The agent additionally refuses an unbound quote, a quote bound to a different buyer, a quote above its own spending limit, and an expired one.

### The agent trusts configuration, not the response

Every check the agent makes against a 402 response — recomputing the metadata hash, comparing it
to `quote.metadataHash`, adding up the itemisation — establishes that the response is internally
consistent. A hostile endpoint can satisfy all of it: it signs its own quote, over its own
document, naming its own adapter.

So `AgentConfig.trusted` is required and carries the store, settlement token, registry and the
adapters the agent will authorize payment to. The response is checked against that, never the
other way round. The agent then confirms on chain that the adapter is actually wired to the
trusted store, token and registry, and calls `validateSignedReceiptPurchase` **on the trusted
store** — which is what authenticates the seller signature, since a hash proves nothing about who
signed. Only then does it sign an authorization.

An agent configured with no adapters cannot be talked into paying one.

### `X-PAYER`

A Nota quote binds one buyer, and the adapter rejects unbound quotes outright, so the server cannot issue a quote until it knows who is paying. The agent declares its address in `X-PAYER` on the first request. A request without it gets a 402 carrying the standard `accepts` block and no Nota extension.

### The redemption credential

The current client generates `rawPurchaseRef` and `purchaseRefNonce` **before
checkout**, privately POSTs them with `X-PAYER`, and retains its original copy.
Before payment it reconstructs `purchaseRef` through the trusted store and rejects
a quote that commits to a different bundle. The merchant stores a copy before
returning the quote; authenticated paid access can recover that copy after restart.

The bundle appears in **no 402 response, settlement request, or settlement calldata**.
The merchant sees it in POST checkout; the configured RPC sees canonical helper calls;
the buyer may save a private copy via `onBundleCreated`. Later seller-submitted
redemption publishes the bundle in calldata. It is not a long-lived secret or
buyer-exclusive credential. Never log bodies, proofs or bundle values.

**Legacy behavior:** GET checkout with `X-PAYER` still generates a bundle at the
merchant. `payAndFetch` uses buyer-generated POST checkout and never silently falls
back to GET. The paid GET is a separate authenticated access request, not that
legacy checkout path.

Access checks the single-use challenge with `verifyMessage` against the settlement
buyer. Payment/access support for contract-wallet signatures does not imply
ERC-1271 support in the EOA-only mock redemption authorizer.

The separate [redemption service](./resource-server/REDEMPTION.md) accepts this
bundle plus the purchase transaction hash, authenticates the requester behind an
`AgentAuthorizer` interface, and requires its wallet to equal the on-chain buyer.
The current implementation verifies real EOA signatures in explicitly labelled mock
mode; it does not verify World ID or resolve AgentBook registrations.

## This is a Nota-specific scheme, not x402 `exact`

The 402 response advertises `nota-exact`, not `exact`, and that is deliberate.

The flow here does not match the registered `exact` semantics. A client returns a reference to an
already-settled on-chain receipt rather than a transfer authorization for a facilitator to
execute, and funds reach the seller through the Nota adapter rather than directly, which is what
makes the purchase reference consume-once and the receipt redeemable. Advertising `exact` would
invite a generic x402 client to attempt a settlement it cannot complete.

There is no PayAI or generalized-facilitator compatibility here, and none is attempted. This is a
Nota-aware settlement path: the facilitator submits to a specific adapter on an allowlist, and the
agent authorizes payment only to adapters it was configured to trust. Interoperating with the
wider x402 ecosystem would mean registering the mechanism and testing against the x402 SDK, which
this does not yet do.

## Verification is from chain state

The resource server does not trust the payment payload. It reads `X402ReceiptSettled` from the adapter for the purchase reference it issued, then checks the seller, buyer, amount, listing, and metadata commitment against the quote it actually offered, and confirms with `PurchaseRefRegistry` that the reference was consumed by the expected adapter. The transaction hash a client may include is used for logging and never as evidence.

## Running it

For one connected HTTP purchase, authenticated access, resource-server restart, and
the attacker/buyer/replay redemption sequence against the deployed Nota dependencies
on a disposable Base fork:

```sh
# BASE_RPC_URL must already hold your configured endpoint (never type a keyed URL inline).
export BASE_RPC_URL
npm run demo:connected
```

This sends transactions only to localhost and uses explicitly labelled mock-wallet
authentication, not World verification. The buyer generates the original bundle,
and all redemption attempts use that exact bundle. The report is delivered before
redemption; this does not implement one-time file access.
See the [demo details](../README.md#connected-purchase-to-redemption-demo).

Deterministic tests need Node.js 22 recommended (minimum 20.19), Foundry 1.8.1
(including Anvil), and initialized submodules,
but no external RPC. The redemption local-EVM suite always runs and builds its artifacts;
the separate Base end-to-end suite skips without `BASE_RPC_URL`.

```sh
npm ci
npm run typecheck
npm test
```

```sh
forge build   # the fixture deploys the adapter from out/
export BASE_RPC_URL   # already configured; enables the Base fork suites
npm test
```

The fixture boots anvil, deploys the adapter, has the registry owner authorize it as a consumer, creates a listing, and funds the buyer with USDC and deliberately no ETH.

Do not use the stock anvil development accounts here. Those addresses carry EIP-7702 delegation code on Base, so on a fork they have a codesize, and both the store and USDC verify signatures with `SignatureChecker`, which routes any address with code to ERC-1271. An ordinary ECDSA signature from one of them is rejected and every settlement fails with `InvalidQuoteSigner`. The fixture derives its own keys and asserts the signers have no code.

## Manual-service configuration

Start with the [Git-checkout quickstart](../README.md#quickstart); a plain ZIP
does not include initialized Solidity dependencies. Run commands below from the
**repository root**, not this package directory. None automatically loads `.env`.
Supply secrets privately through the environment; never paste key values into commands.

| Entry point / command | RPC variable | Signing key variable | Other configuration read by that entry point |
| --- | --- | --- | --- |
| [Facilitator](./facilitator/src/server.ts): `npm run facilitator` | `RPC_URL` (default localhost:8545) | `FACILITATOR_PRIVATE_KEY` | Required `NOTA_X402_ADAPTER`; optional `CHAIN_ID` (8453), `FACILITATOR_PORT` (4021) |
| [Resource server](./resource-server/src/server.ts): `npm run resource-server` | `RPC_URL` (default localhost:8545) | `SELLER_PRIVATE_KEY` (quote signing) | `QUOTE_STORE_PATH`, `NOTA_RECEIPT_STORE`, `SETTLEMENT_TOKEN`, `PURCHASE_REF_REGISTRY`, `NOTA_X402_ADAPTER`; optional `CHAIN_ID`, `LISTING_ID`, `FROM_BLOCK`, `RESOURCE_PORT`, `RESOURCE_BASE_URL`, `FACILITATOR_URL` |
| [Redemption server](./resource-server/src/redemption/server.ts): `npm run redemption-server` | `BASE_RPC_URL` (default localhost:8545) | `SELLER_PRIVATE_KEY` (seller transactions) | `QUOTE_STORE_PATH`, `AGENT_AUTH_MODE=mock`, `ENTITLEMENT_REDEMPTION`, `NOTA_RECEIPT_STORE`, `REDEMPTION_ADAPTERS`, `REDEMPTION_PORT`, `REDEMPTION_BASE_URL`, `REDEMPTION_CONFIRMATIONS`; refuses `NODE_ENV=production` |
| [Connected live demo / preflight](./e2e/src/live-config.ts) | `BASE_RPC_URL` (HTTPS required) | `SELLER_PRIVATE_KEY`, `BUYER_PRIVATE_KEY`, optional `RELAYER_PRIVATE_KEY` | `LIVE_DEMO_USDC_AMOUNT`, `LIVE_DEMO_STATE_DIR`; manifest addresses, not manual-service address variables |

`RELAYER_PRIVATE_KEY` is **not** read by the standalone facilitator;
`FACILITATOR_PRIVATE_KEY` is **not** read by the connected live demo. The fork demo
creates test keys itself and uses `BASE_RPC_URL` only as its fork source. For manual
services on one local Base fork, configure both RPC variables to that fork, not one
to mainnet. The same seller may sign quotes and submit redemptions, but only one
redemption writer may submit with that key.

After securely configuring the appropriate environment for each terminal:

```sh
npm run facilitator
```

```sh
npm run resource-server
```

```sh
npm run redemption-server
```

Manual startup does not create a listing, deploy contracts, fund wallets or authorize
the adapter in the registry. These must already be configured on the chosen chain.
The facilitator and resource entry points do not explicitly restrict their listening
host; do not expose them as hardened public services. The redemption entry point binds
loopback and refuses production mock mode. Configure HTTPS and operational controls
before remote exposure. [Security model](../SECURITY.md).

The resource and redemption commands require the same absolute `QUOTE_STORE_PATH`.
Run one resource-server writer per private order file, with read-only redemption
consumers. No memory fallback is used by those commands. Files contain bundles:
protect storage and backups; keep them out of Git and recordings.
[Persistence limits](../README.md#persistent-issued-orders).

The existing live demo records block another `--live` run. Use the repeatable fork
story instead; do not delete evidence or bypass the guard. The Graph index is not
queried by these application services. Nothing here is published as an npm package.
