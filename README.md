# Nota Entitlements

Nota Entitlements adds two things over Nota's deployed Base-mainnet protocol: one-time entitlement redemption, and an x402 settlement adapter that lets a buyer pay a signed quote with an EIP-3009 authorization. Neither contract has an owner, a pause switch, or an upgrade path, and neither holds funds between transactions.

**On-chain security property:** redemption requires a purchase reference consumed by the configured Nota store, can happen only once, and must be submitted by the listing seller.

`EntitlementRedemption` asks the deployed `NotaReceiptStore` to reconstruct the purchase-reference hash from the listing seller, listing ID, raw reference, and nonce. It then verifies with the deployed `PurchaseRefRegistry` that the configured store consumed the reference and records that purchase reference exactly once.

`listingId` is used to resolve and validate the seller, but it is not independently committed into `purchaseRef`. The redemption event therefore omits it. Indexers can join `EntitlementRedeemed` to the original `ReceiptPurchasedV2` event by `purchaseRef` to recover the authoritative listing.

The contract does **not** identify the buyer or the purchasing agent, and it does not enforce the policy that a stolen receipt alone is insufficient. Agent binding is a merchant-side policy enforced by the AgentKit-protected redemption endpoint planned for day three. That endpoint must authenticate the intended agent before submitting a seller-authorized on-chain redemption.

See [`SECURITY.md`](./SECURITY.md) for the exact trust boundary and non-guarantees.

## Continuity boundary

The receipt protocol predates ETHOnline 2026. Its baseline is [`notaxyz/contracts@238cb210`](https://github.com/notaxyz/contracts/tree/238cb210e1342892c122b794563b1db99bd4b891), including seller-signed EIP-712 quotes, USDC settlement, `ReceiptPurchasedV2`, and global one-time purchase-reference consumption.

[`BASELINE.md`](./BASELINE.md) records the timestamped boundary, deployed addresses, and the work introduced here. This repository does not vendor or modify Nota's existing contracts.

## Base mainnet dependencies

| Contract | Address |
| --- | --- |
| `NotaReceiptStore` | [`0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88`](https://basescan.org/address/0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88) |
| `PurchaseRefRegistry` | [`0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991`](https://basescan.org/address/0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991) |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |

Both constructors accept only the receipt-store address and discover the purchase-reference registry — and, for the adapter, the settlement token — from that store.

## x402 settlement adapter

[`NotaX402Settlement`](./src/NotaX402Settlement.sol) settles a seller-signed Nota quote from a buyer's EIP-3009 `ReceiveWithAuthorization` instead of an `approve` + `transferFrom`. The buyer signs a payment authorization off-chain and never sends a transaction, so a facilitator can submit the settlement and the buyer needs no ETH.

**On-chain security property:** settlement requires both a valid seller-authorized quote and a buyer authorization bound to that exact quote — same payer, same amount, and this adapter as the recipient — and consumes the quote's purchase reference exactly once.

The adapter reproduces none of the store's fee math. It calls `validateSignedReceiptPurchase`, which runs the same validation path as `purchaseSignedReceipt`, and pays out the exact `protocolFee` / `integratorFee` / `sellerNet` breakdown that view returns. Those three legs sum to the gross by construction, so the adapter never retains a balance. Zero-value legs are skipped: the deployed store runs a zero protocol fee with a zero fee recipient, so paying that leg unconditionally would transfer to `address(0)`.

Two behaviours are the adapter's own rather than the store's:

- **Unbound quotes are rejected.** The store treats `quote.buyer == address(0)` as "any wallet may pay" and skips its buyer check entirely. An EIP-3009 authorization must name one payer, so the adapter requires a bound quote.
- **`purchasesPaused` is checked directly.** It is the only check `purchaseSignedReceipt` performs that `validateSignedReceiptPurchase` does not repeat. The adapter checks it so the store owner's kill switch still covers this settlement path.

The adapter calls `receiveWithAuthorization`, never `transferWithAuthorization`. The token requires `msg.sender == to`, so a signed authorization naming this adapter is executable only through this adapter; an observer who sees it in the mempool cannot execute the transfer standalone.

### Adapter receipt ids are not store receipt ids

`X402ReceiptSettled.receiptId` comes from `nextAdapterReceiptId`, a counter local to this contract. It is unrelated to `NotaReceiptStore.nextReceiptId`, and a settlement through the adapter does not advance the store's counter. Adapter receipt `7` and store receipt `7` are different records in different id spaces. The only identifier that joins the two systems is `purchaseRef`; index on that, never on the id.

The adapter also does not emit `ReceiptPurchasedV2`. That event belongs to the store and cannot be emitted from here.

### Required post-deploy step

The adapter consumes purchase references in the shared registry, and **the registry owner must authorize it before it can settle anything**:

```sh
cast send 0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991 \
  "setConsumerAuthorization(address,bool)" <adapter address> true
```

That is an owner transaction on the deployed mainnet registry, not something this repository can perform. Until it lands, every `settleWithAuthorization` call reverts with `UnauthorizedConsumer(<adapter address>)`. [`script/DeployNotaX402Settlement.s.sol`](./script/DeployNotaX402Settlement.s.sol) prints the exact call after deploying, and `test_RevertsWhenAdapterIsNotAnAuthorizedConsumer` pins the failure mode so it cannot be forgotten quietly.

```sh
forge script script/DeployNotaX402Settlement.s.sol --rpc-url "$BASE_RPC_URL" --broadcast
```

### Entitlement redemption does not yet cover adapter settlements

`PurchaseRefRegistry.consume` records the calling module as the consumer, so a reference settled through the adapter is attributed to the adapter, not to the store. `EntitlementRedemption` requires `consumedBy(purchaseRef) == address(STORE)` and therefore rejects it with `EntitlementNotPaid`. Purchases settled through x402 cannot currently be redeemed through the day-one entitlement contract. Closing that gap is a day-three decision and is deliberately not patched into the deployed-behaviour-compatible `EntitlementRedemption`; see [`SECURITY.md`](./SECURITY.md).

## Development

The project uses Foundry and Solidity 0.8.24. Clone with submodules; the adapter uses OpenZeppelin's `SafeERC20` and `ReentrancyGuard`.

```sh
git submodule update --init --recursive
```

```sh
forge build
forge test
```

Deterministic unit tests run against minimal mock store and registry contracts, so CI exercises the entitlement behavior without external infrastructure. Separate integration suites fork Base mainnet and call the deployed contracts; only those suites skip when `BASE_RPC_URL` is absent.

The x402 suite is fork-only by design: it signs real EIP-712 quotes against the deployed store's domain and real EIP-3009 authorizations against deployed USDC, and it pranks the registry owner to authorize the adapter in `setUp`. Both domain separators are rebuilt from what the deployed contracts report rather than hardcoded, and the USDC one is checked against the token's own `DOMAIN_SEPARATOR`.

```sh
BASE_RPC_URL=https://your-base-mainnet-rpc forge test --match-path test/NotaX402SettlementFork.t.sol
```

Receipt #1 supplies the consumed reference used for deployed-contract compatibility testing without committing its redemption preimage bundle:

```text
listing:      1
purchaseRef:  0x5333d780992fdf98c143083b765392aeaa27cb393a034235026f57f202806770
```

Copy `.env.example` to `.env` or export these variables in your shell:

```sh
BASE_RPC_URL=https://your-base-mainnet-rpc
RECEIPT_1_RAW_PURCHASE_REF=your-raw-reference
RECEIPT_1_PURCHASE_REF_NONCE=0x...
```

Bundle-dependent integration tests skip when either receipt variable is absent. The remaining fork tests still exercise caller authorization, unpaid references, and nonexistent listings against the live deployment.

Never commit `.env` or a redemption preimage bundle.

## World demo requirements

Receipt #1 proves compatibility only. The final World demo must create a new purchase whose buyer agent generates the redemption preimage bundle. Its signed quote must bind `buyer` to the AgentKit wallet; an unbound buyer must not be used for the demo flow.

## License

Apache-2.0
