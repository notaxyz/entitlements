# Day 4 redemption service

Implemented: real signed-wallet authentication behind `AgentAuthorizer`, authoritative
settlement verification, buyer policy, seller submission, and deterministic tests.
Not implemented/verified: `WorldAgentKitAuthorizer`, AgentBook lookup, or human-backed
registration. Agents A and B remain pending in World. Mock mode is not World integration.

No Solidity changes are required. The service is separate from the paid-content server,
uses the existing `EntitlementRedemption` deployment, and shares the existing TypeScript
workspace dependencies. Nothing is deployed or broadcast merely by installing or testing.
Tests and the demo broadcast only to the local Anvil instance they start.

## Run the local demo

```sh
git submodule update --init --recursive
npm ci
npm run demo:redemption
```

Requires Node.js 20+ and Foundry/Anvil (CI pins 1.8.1). No RPC, live keys, phone app,
registration, or funding is needed. The fixture creates a new buyer-generated bundle,
binds the quote buyer to A, settles using real EIP-3009 signature verification in the
existing mock token, and redeems through the unchanged contract. Mock Nota dependencies
are explicitly not the deployed Base store; seller-signature compatibility is tested
by the existing fork suite, not claimed by this demo.

Order: B steals A's bundle and fails at step 6 while the purchase is still unredeemed;
A succeeds; A signs a new challenge and fails at step 5. No secrets are printed.

## Connect to a configured Base deployment or Base fork

Load secrets through a secure local environment or secret manager, not command-line
arguments. The script does not automatically load `.env`. Set:

| Variable | Meaning |
| --- | --- |
| `QUOTE_STORE_PATH` | Required absolute path to the merchant's issued-order file; same path as the resource server |
| `AGENT_AUTH_MODE=mock` | Explicit wallet-only development authentication |
| `BASE_RPC_URL` | Trusted Base RPC; defaults to local `127.0.0.1:8545` |
| `NOTA_RECEIPT_STORE` | Trusted receipt store address |
| `ENTITLEMENT_REDEMPTION` | Existing redemption deployment |
| `REDEMPTION_ADAPTERS` | Comma-separated trusted adapter emitters; empty allows store only |
| `SELLER_PRIVATE_KEY` | Dedicated listing-seller key; only this server may use it to write |
| `REDEMPTION_BASE_URL` | Public origin used in signed challenges, default `http://127.0.0.1:4022` |
| `REDEMPTION_PORT` | Loopback listening port, default 4022 |
| `REDEMPTION_CONFIRMATIONS` | Required confirmations, default 2; use 1 for automining local forks |

```sh
npm run redemption-server
```

Startup validates Base chain ID 8453 and deployment wiring. The registry is discovered
from the store; no separately supplied registry is trusted. Every configured adapter
must be accepted by the redemption deployment and wired to that store/registry.
An accepted contract consumer not on this server's emitter allowlist is not accepted
by the endpoint. Never point the local demo's mock dependency addresses at mainnet.

The resource server is the sole writer to `QUOTE_STORE_PATH`; redemption only reads.
Orders survive restarts, and the reader sees newly saved orders without restarting.
An otherwise valid paid reference that has no merchant-issued order is rejected.
Protect the persistent directory and backups: the file contains preimage bundles.
Do not share one file across unrelated merchants or deployments, or run multiple
writer processes against it. The local demo supplies fixture orders in memory and
does not need this environment variable.

Mock mode refuses `NODE_ENV=production`. There is no automatic World-to-mock downgrade.
The server binds to loopback. Remote operation needs HTTPS and the operational controls
in [SECURITY.md](../../SECURITY.md). Valid redemption requests spend seller ETH and
irreversibly publish the preimage in calldata. Tests do not launch the configured service.

## HTTP protocol

The redemption body uses decimal strings for uint256 values:

```json
{
  "listingId": "1",
  "purchaseTxHash": "0x<32-byte transaction hash>",
  "rawPurchaseRef": "<raw reference>",
  "purchaseRefNonce": "0x<32-byte nonce>"
}
```

1. Send `POST /v1/redemptions/challenge` with
   `{ "agentAddress": "0x...", "redemption": <body above> }`.
2. Verify the challenge's exact origin, chain, contract, address, request digest,
   expiration, and mock label. Sign its `message` using the agent's EOA wallet.
3. Send `POST /v1/redemptions` with the original body and `X-NOTA-AGENT-AUTH` set to
   base64-encoded JSON `{ "challengeId": "...", "signature": "0x..." }`.

The checked client helper `src/redemption/client.ts::redeemWithMockAgent` does these
steps without sending its private key. Each attempt needs a fresh challenge, including
attempts expected to fail. No requester-supplied `buyer` or `humanId` is accepted.
This header is mock-only, not an AgentKit header. The `AgentAuthorizer` interface also
receives the `agentkit` header for a future verified World implementation.

Verification order after body syntax validation:

1. Authenticate the agent. Today: EOA signature; future World: validated AgentKit
   challenge plus successful AgentBook lookup, with no mock fallback.
2. Require successful, confirmed Base transaction and a trusted Nota settlement event.
3. Reconstruct through the store's helper; match the event by `purchaseRef`, and match
   listing and seller separately. Load the issued order and compare reference, buyer,
   listing, amount, and metadata commitment. Either store or adapter receipt type works.
4. Require consumption by the matched settlement emitter.
5. Require `redeemedAt[purchaseRef] == 0`.
6. Require authenticated agent address == recorded buyer address.
7. Simulate, submit with seller key, confirm, and verify `EntitlementRedeemed` fields.

Response examples (omitting request IDs):

| Case | HTTP | Code | Step |
| --- | --- | --- | --- |
| Valid buyer and bundle | 201 | `REDEEMED` (transaction hash and event fields) | 7 |
| Stolen bundle, different authenticated agent | 403 | `BUYER_MISMATCH` | 6 |
| Already redeemed | 409 | `ALREADY_REDEEMED` | 5 |
| Bundle not matching purchase | 422 | `PREIMAGE_MISMATCH` | 3 |
| No merchant-issued order | 422 | `ORDER_NOT_FOUND` | 3 |
| Receipt differs from issued order | 422 | `ORDER_MISMATCH` | 3 |
| Order storage unavailable or malformed | 503 | `VERIFICATION_UNAVAILABLE` | 3 |
| Missing/invalid/expired/reused challenge | 401 | `AGENT_AUTH_FAILED` | 1 |
| Missing/pending transaction | 409 | `PURCHASE_NOT_MINED` | 2 |
| RPC/verification unavailable | 503 | `VERIFICATION_UNAVAILABLE` | Current step |
| Uncertain broadcast/confirmation | 503 | `SUBMISSION_UNCERTAIN` | 7 |

Mock successes include `authentication: "mock-wallet", humanVerified: false`.
All audit records are allowlisted; `BUYER_MISMATCH` and step 6 appear in both response
and logs. Responses never include the supplied bundle. Do not log entire requests,
challenges, proof headers, or RPC error objects in hosting/monitoring infrastructure.

## Submission recovery and deployment scope

Run one dedicated seller writer. A bounded in-process queue serializes checks through
confirmation. An uncertain broadcast/receipt or missing expected event blocks later
submissions; the endpoint does not blindly retry. Reconcile seller pending/mined
transactions and on-chain redemption state before restarting. Process restart is
not an automatic recovery strategy. Durable submission journals, multi-instance locks,
rate limiting, and production operational hardening remain out of scope for this milestone.

## Swapping in World

Implement `AgentAuthorizer.authorize(req)` to validate the AgentKit signature/message,
bind its challenge to this request and deployment, enforce nonce freshness, and resolve
the verified signing wallet in the confirmed AgentBook registry. Return that wallet
and the verified human ID. Do not trust an address/header supplied without proof, or
substitute human-ID equality for wallet equality: two wallets backed by the same human
still must not redeem each other's purchases. Wire the real challenge protocol and
client, remove the mock challenge route, and test live registration and verification.
This is not just changing an environment flag; that adapter has not yet been built.

A read-only lookup of a pre-registered address is not authentication. Pre-registered
sandbox agents help only if we can legitimately sign challenges as those agents.
