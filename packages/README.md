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

### `X-PAYER`

A Nota quote binds one buyer, and the adapter rejects unbound quotes outright, so the server cannot issue a quote until it knows who is paying. The agent declares its address in `X-PAYER` on the first request. A request without it gets a 402 carrying the standard `accepts` block and no Nota extension.

### The redemption credential

`purchaseRefNonce` is what makes the on-chain `purchaseRef` unguessable, and it is the credential that redeems the entitlement later. **It appears in no 402 response, no settlement request, and no calldata** — only its hash reaches the chain. The extension payload has no field it could go in, and an end-to-end test asserts it is absent from the 402 body.

The one channel that carries it is the paid resource response, after settlement, to the payer that funded it — which is what makes the entitlement theirs to redeem. Redemption itself is not wired up here.

## Verification is from chain state

The resource server does not trust the payment payload. It reads `X402ReceiptSettled` from the adapter for the purchase reference it issued, then checks the seller, buyer, amount, listing, and metadata commitment against the quote it actually offered, and confirms with `PurchaseRefRegistry` that the reference was consumed by the expected adapter. The transaction hash a client may include is used for logging and never as evidence.

## Running it

Deterministic tests need nothing. The end-to-end suite forks Base and skips without `BASE_RPC_URL`, the same way the Solidity fork suites do.

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
