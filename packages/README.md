# Nota x402 layer

An agent discovers a paid resource, sees an itemised list of what it is buying, verifies that the seller signed exactly that, pays without holding ETH, and gets the resource back with an on-chain receipt.

**This is one vertical path, not general x402 support.** It settles Nota quotes through `NotaX402Settlement` and nothing else. There is no PayAI integration and no generalized-facilitator compatibility: the facilitator here only submits `settleWithAuthorization`, only to adapters on its allowlist, and the resource server only accepts payment it can find as an `X402ReceiptSettled` event. Pointing this at a non-Nota x402 server, or a non-Nota facilitator at these payloads, will not work and is not meant to.

For how a Nota receipt relates to x402's own Signed Offers & Receipts extension — they compose, and Nota does not replace it — see the [root README](../README.md#relationship-to-the-x402-signed-offers--receipts-extension).

## Packages

| Package | What it is |
| --- | --- |
| [`x402-nota`](./x402-nota) | Shared types, the extension payload, EIP-712 and EIP-3009 typed data, JCS canonicalization, and the buyer-side verification |
| [`facilitator`](./facilitator) | Nota-aware relayer. Submits the settlement and pays the gas |
| [`resource-server`](./resource-server) | One paid endpoint. Returns 402 with the extension, and the resource once settlement is on chain |
| [`client`](./client) | The buying agent. Parses the 402, verifies, signs, relays, retries |
| [`e2e`](./e2e) | Fork fixture and the end-to-end test |

## The flow

```
agent                  resource server            facilitator            Base
  │  GET + X-PAYER            │                        │                  │
  │──────────────────────────>│                        │                  │
  │                           │ hashPurchaseRef        │                  │
  │                           │───────────────────────────────────────────>│
  │  402 + nota.receipt.v1    │                        │                  │
  │<──────────────────────────│                        │                  │
  │                                                    │                  │
  │  recompute keccak256(JCS(document))                │                  │
  │  == quote.metadataHash ?  ── no ──> refuse, log every reason          │
  │  sign ReceiveWithAuthorization(to: adapter)        │                  │
  │                                                    │                  │
  │  POST /settle ────────────────────────────────────>│                  │
  │                                                    │ settleWith...    │
  │                                                    │─────────────────>│
  │  { txHash, receiptId }  <──────────────────────────│                  │
  │                           │                        │                  │
  │  GET + X-PAYMENT          │                        │                  │
  │──────────────────────────>│ getLogs X402ReceiptSettled                │
  │                           │───────────────────────────────────────────>│
  │  200 + content + receipt  │                        │                  │
  │<──────────────────────────│                        │                  │
```

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

`purchaseRefNonce` is what makes the on-chain `purchaseRef` unguessable, and it is the credential that redeems the entitlement later. **It appears in no 402 response, settlement request, or settlement calldata** — payment publishes only the purchase-reference hash. The extension payload has no field it could go in, and an end-to-end test asserts it is absent from the 402 body. The later seller-submitted redemption transaction publishes the bundle in calldata; it is not a long-lived secret.

Exactly one channel carries it: the paid resource response, after settlement, to a requester that has **proved control of the buyer wallet**. A settled `purchaseRef` is public — it is in the 402 response and in the settlement event — so naming one is not evidence of anything. The server issues a single-use challenge and the requester signs it; the signature is checked against the buyer the settlement records, via `verifyMessage`, so a smart-wallet buyer authenticates the same way it paid. That is what makes the entitlement theirs to redeem, and it is a deliberate choice rather than an incidental one — an end-to-end test asserts both halves, that the credential is absent before payment and that the deployed store reconstructs the settled `purchaseRef` from what is handed over.

The separate [Day 4 redemption service](./resource-server/REDEMPTION.md) accepts this
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

Deterministic tests need Node.js, Foundry (including Anvil), and initialized submodules,
but no external RPC. The redemption local-EVM suite always runs and builds its artifacts;
the separate Base end-to-end suite skips without `BASE_RPC_URL`.

```sh
npm install
npm run typecheck
npm test
```

```sh
forge build   # the fixture deploys the adapter from out/
BASE_RPC_URL=https://your-base-mainnet-rpc npm test
```

The fixture boots anvil, deploys the adapter, has the registry owner authorize it as a consumer, creates a listing, and funds the buyer with USDC and deliberately no ETH.

Do not use the stock anvil development accounts here. Those addresses carry EIP-7702 delegation code on Base, so on a fork they have a codesize, and both the store and USDC verify signatures with `SignatureChecker`, which routes any address with code to ERC-1271. An ordinary ECDSA signature from one of them is rejected and every settlement fails with `InvalidQuoteSigner`. The fixture derives its own keys and asserts the signers have no code.

To run the servers by hand against a fork:

```sh
RPC_URL=http://127.0.0.1:8545 NOTA_X402_ADAPTER=0x... FACILITATOR_PRIVATE_KEY=0x... npm run facilitator
```

```sh
RPC_URL=http://127.0.0.1:8545 NOTA_X402_ADAPTER=0x... SELLER_PRIVATE_KEY=0x... LISTING_ID=1 \
  NOTA_RECEIPT_STORE=0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88 \
  SETTLEMENT_TOKEN=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  PURCHASE_REF_REGISTRY=0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991 npm run resource-server
```

Nothing here is published to npm; the packages are workspace-local.
