# Nota Entitlements

Nota Entitlements adds one-time redemption to receipts purchased through Nota's deployed Base-mainnet protocol. It holds no funds and has no owner, pause switch, or upgrade path.

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

The constructor accepts only the receipt-store address and discovers the purchase-reference registry from that store.

## Development

The project uses Foundry and Solidity 0.8.24.

```sh
forge build
forge test
```

Deterministic unit tests run against minimal mock store and registry contracts, so CI exercises the complete behavior without external infrastructure. A separate integration suite forks Base mainnet and calls the deployed contracts; only that suite skips when `BASE_RPC_URL` is absent.

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
