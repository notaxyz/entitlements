# Nota Entitlements

A receipt you can spend once — and only the wallet that paid for it can spend it.

A payment proves money moved. It does not say what was bought, and it does not entitle
anyone to collect it. When an agent buys a paid API resource over x402, nothing connects
the USDC transfer to what the seller agreed to deliver, or to who may later claim it.

This layer closes that. The buyer generates a redemption bundle and sends it privately at
checkout; the Nota store hashes it into a public purchase reference. The seller signs a
quote committing to that reference. The buyer pays USDC with an EIP-3009 authorization, so
a facilitator submits the transaction and the buyer needs no ETH. Later the buyer presents
the bundle, the endpoint checks that the presenting wallet is the one that paid, and the
seller submits a redemption the contract records exactly once.

## What that buys you

Three sequential attempts against **one** paid purchase:

| Attempt | Result | Transactions sent |
| --- | --- | --- |
| A different wallet, holding the correct bundle | `403 BUYER_MISMATCH` | none |
| The wallet that paid | `201 REDEEMED`, `EntitlementRedeemed` emitted | one, by the seller |
| That same wallet again | `409 ALREADY_REDEEMED` | none |

The attacker goes first, while the entitlement is still unredeemed, so the rejection
demonstrates buyer binding rather than replay protection. The replay is rejected by the
endpoint reading on-chain `redeemedAt` — it is not a reverted transaction.

## Deployments

| Network | Contract | Address |
| --- | --- | --- |
| Base mainnet | `NotaX402Settlement` | [`0x59D3076857972372ecc2E845a7e57A83BB9ddDC8`](https://basescan.org/address/0x59D3076857972372ecc2E845a7e57A83BB9ddDC8#code) |
| Base mainnet | `EntitlementRedemption` | [`0xDE4F712fa5B5be32766C34885b334F1D8e573882`](https://basescan.org/address/0xDE4F712fa5B5be32766C34885b334F1D8e573882#code) |
| Arbitrum Sepolia | `NotaX402Settlement` | [`0x9e5c2e8E4d38f555f487d3682456Be7c616F00A8`](https://sepolia.arbiscan.io/address/0x9e5c2e8E4d38f555f487d3682456Be7c616F00A8#code) |
| Arbitrum Sepolia | `EntitlementRedemption` | [`0x8718D0d64F14cB9ef5ecd0c0EAC403b32dC26eEE`](https://sepolia.arbiscan.io/address/0x8718D0d64F14cB9ef5ecd0c0EAC403b32dC26eEE#code) |

Neither contract is a proxy, an upgrade, or an admin over the store. Neither has an owner,
a pause switch, or an upgrade path. Redemption moves no funds. Transaction hashes, block
hashes, constructor arguments, compiler settings and bytecode hashes are in
[`deployments/`](./deployments).

Both chains build on the pre-existing Nota receipt store and its consume-once registry,
which this repository neither vendors nor modifies — see [BASELINE.md](./BASELINE.md).

## It has run for real, twice

**Base mainnet, 2026-09-12.** A 0.10 USDC purchase, the three outcomes above, no
transaction sent by the buyer:
[settlement](https://basescan.org/tx/0xa5ad9c2e638590a3aa5ef29ca7d5fa99cd98d48f697640ae1b7e506f7473384e) ·
[redemption](https://basescan.org/tx/0x59207b64629b4bff88e5198fc66045bb9bd1429dc3c6b7296f4a2d61a4905194) ·
[evidence](./deployments/base.json)

**Arbitrum Sepolia, 2026-10-03.** The same flow against the live testnet deployment:
[settlement](https://sepolia.arbiscan.io/tx/0x7b03f5038eb99896f56f89b05ab806a65784c161f27129e95298af21d504679f) ·
[redemption](https://sepolia.arbiscan.io/tx/0x47d4782e216f13ba0c9531e469f726c4677f51c322f2f711620d3942873744e7) ·
[how to verify or reproduce it](./documentation/ARBITRUM_SEPOLIA_DEMO.md)

Settlement and redemption are separate transactions joined by `purchaseRef`, which is also
how [the event index](./documentation/INDEXING.md) joins them.

## Quickstart

Node.js 22 (minimum 20.19) and Foundry 1.8.1, matching [CI](./.github/workflows/test.yml).
Clone with submodules — a source ZIP omits the Solidity dependencies, and `npm ci` alone
does not populate them. Already cloned? Run `git submodule update --init --recursive`.

```sh
git clone --recurse-submodules https://github.com/notaxyz/entitlements.git
cd entitlements
npm ci
forge build
npm run typecheck
npm test
```

`npm test` runs the deterministic Solidity, HTTP and local-Anvil suites with no external
RPC. The Base fork suites, which check compatibility against the deployed store, registry
and USDC, skip unless `BASE_RPC_URL` is set.

## Running the demo

```sh
npm run demo:redemption                    # local chain, mock dependencies, no RPC
npm run demo:connected -- --story          # disposable Base fork, needs BASE_RPC_URL
npm run demo:arb-sepolia                   # live Arbitrum Sepolia, needs the services up
```

The fork demo spends nothing real: it forks the deployed Base contracts locally, deploys
the two new ones locally, and every transaction hash in it belongs to the fork. The
separately recorded mainnet purchase above is the real one.

Running against a live chain needs three services and their configuration —
[manual-service setup](./packages/README.md#manual-service-configuration) for the
environment, [ARBITRUM_SEPOLIA_DEMO.md](./documentation/ARBITRUM_SEPOLIA_DEMO.md) for a
worked example, [OPERATIONS.md](./documentation/OPERATIONS.md) for the operator
procedures and recovery constraints.

Scripts do not load `.env`. Export configuration from your shell or secret manager, and
keep keys and bundles out of command history and recordings.

## Limitations

- **Authentication is a mock wallet seam.** It verifies real EOA signatures and proves
  control of the paying wallet. It is not World ID or an AgentBook lookup, and responses
  report `humanVerified: false`. `WorldAgentKitAuthorizer` and AgentBook resolution are
  not implemented.
- **The bundle is not buyer-exclusive.** The merchant receives it at checkout, the
  configured RPC sees it during canonical hashing, and redemption publishes it in
  calldata. It is a commitment, not a long-lived secret.
- **Buyer matching is endpoint policy.** The contract checks the seller, accepted
  consumption and replay. It does not check the buyer, so a seller can bypass the endpoint
  and redeem directly.
- **Unsettled refs can be griefed.** Consumption does not check which seller issued a ref, so
  anyone who learns an unsettled one can consume it and deny the buyer's purchase: on any
  deployment, through a self-purchase at the minimum price, or for gas through `attestReceipt` where deployed ([notaxyz/contracts#8](https://github.com/notaxyz/contracts/issues/8)).
- **Replay protection is per redemption deployment.** A new accepted-consumer set needs a
  new deployment with empty state, so migration must account for entitlements already
  redeemed against an older address.
- **No claim is made that redemption constitutes fulfillment.** The resource is delivered
  before redemption, and redemption neither revokes it nor proves anything off-chain
  happened.
- **The backend is a development milestone.** Mock mode refuses `NODE_ENV=production`. It
  supports EOA signatures only, keeps challenges in memory, and runs a single-process
  seller writer. Durable coordination and abuse controls come before production.
- **Source verification is not an audit.** Upstream controls also remain: store pause
  state can stop new purchases, and the registry owner can revoke adapter consumption.

[SECURITY.md](./SECURITY.md) has the full assumptions, logging restrictions and
non-guarantees.

## Repository

| Path | What it is |
| --- | --- |
| [`src/`](./src) | The two contracts and minimal interfaces to the existing deployments |
| [`packages/x402-nota`](./packages/x402-nota) | Shared ABIs, quote types, metadata hashing, nonce derivation, trust config |
| [`packages/client`](./packages/client) | The buying agent: verifies terms against trusted config, signs, retrieves |
| [`packages/resource-server`](./packages/resource-server) | Buyer-bound quotes, authenticated access, and the redemption service |
| [`packages/facilitator`](./packages/facilitator) | Submits allowlisted adapter settlements and pays gas |
| [`packages/subgraph`](./packages/subgraph) | Event index joining settlements to redemptions |
| [`runs/`](./runs) | Unedited console captures of recorded runs |

The wire scheme is `nota-exact`, not generic x402 `exact`: this is a Nota-aware settlement
path with an adapter allowlist, not a generalized facilitator. See
[packages/README.md](./packages/README.md) for the paid-resource protocol and
[ARCHITECTURE.md](./documentation/ARCHITECTURE.md) for the call sequences, accounting and
signature boundaries.

## License

Apache-2.0
