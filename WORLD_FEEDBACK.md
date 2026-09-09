# World AgentKit integration feedback

Working notes recorded during Day 4 integration, not reconstructed after the demo.
No wallet private keys, World ID proofs, or redemption preimage bundles belong here.

## 2026-09-09 — registration discovery

- Started from repository commit `a3a6742`. Contracts are frozen; this work targets
  the backend authorization seam and redemption endpoint.
- Registration of buyer agent A and attacker agent B is a prerequisite requested
  by the project. Neither registration has been completed or verified yet. No
  backend implementation has been written during this integration attempt.
- No World sandbox configuration or designated agent wallet addresses were found
  in the repository's environment example. Asked for the granted sandbox's portal
  or registration configuration; access being granted does not identify its URL.
- Documentation disagreement: the [integration guide](https://docs.world.org/agents/agent-kit/integrate)
  says registration defaults to World Chain and AgentBook lookup uses World Chain.
  The [CLI registration guide](https://github.com/worldcoin/agentkit/blob/main/cli/REGISTRATION.md)
  still describes Base as the default with a different AgentBook address. This
  makes choosing the correct registry for registration and verification confusing.
  Published CLI `@worldcoin/agentkit-cli@0.2.0 --llms` subsequently confirmed
  World Chain registration; its advertised options are `--auto`, `--manual`, and
  an `API_URL` relay override. It does not advertise a sandbox/network selector.
- The public registration instructions require a World App verification step.
  A sandbox-specific proof flow has not yet been identified. A mock signature or
  test identity must not be represented as a verified human registration.
- Opening [AgentBook](https://www.agentbook.world/) in the in-app browser initially
  displayed a Vercel Security Checkpoint instead of registration controls. No
  checkpoint bypass was attempted.
- The SDK's low-level signature/message validation and AgentBook lookup appear
  suitable for our existing Express backend. The default free-trial/payment hooks
  are not the redemption policy: an authenticated agent must still match the
  authoritative settlement buyer before the seller submits redemption.
- The published CLI help ran successfully, but npm emitted a deprecation warning
  for its `@worldcoin/idkit-core@2.1.0` dependency. No proof or registration was
  submitted by the help command.
- Existing backend baseline: `npm run typecheck` passed; `npm test` ran 9 passing
  tests and skipped 12 fork integration tests without `BASE_RPC_URL`. These are
  existing tests, not evidence of Day 4 authorization behavior.

## Registration evidence

| Role | Wallet | Network / AgentBook | Registration transaction | Verified lookup |
| --- | --- | --- | --- | --- |
| A — buyer | Pending | Pending | Pending | Not checked |
| B — attacker | Pending | Pending | Pending | Not checked |

## Current integration status

The 2026-09-09 discovery status above is historical. On 2026-09-10 the project owner
explicitly authorized building against mock authentication without waiting for registration.

## 2026-09-10 — mock-backed implementation

- Implemented the `AgentAuthorizer` seam, `MockAgentAuthorizer`, and a separate
  `POST /v1/redemptions` service. Mock authentication verifies actual EOA challenge
  signatures and returns a synthetic `mock:wallet:...` ID. It is not a human proof,
  AgentBook resolution, or a World registration. Both World registration rows remain pending.
- The challenge binds the request body digest, endpoint, chain, redemption contract,
  wallet, expiry and single-use nonce. This is important integration work left for a
  real World adapter too; merely reading an AgentBook address is not authentication.
- Confirmed the deployed `ReceiptPurchasedV2` layout through Basescan. Its receipt ID
  is unindexed and purchase reference is indexed; the adapter event differs. Backend
  decoding supports each event from its trusted emitter and joins by `purchaseRef`.
- The mock-mode server requires explicit opt-in and refuses production mode. No
  automatic fallback is wired into a failed World authentication attempt.
- Local Anvil tests demonstrated the three scenarios against the unchanged redemption
  and adapter contracts, using existing mock Nota/token dependencies: B rejected at
  step 6 with no transaction, A emitted `EntitlementRedeemed`, A replay rejected at
  step 5 with no new transaction. The bundle was freshly generated on the buyer side
  and the quote buyer was bound to A. This is not a Base-mainnet or World-verified demo.
- The first local fixture purchase correctly reverted because its metadata commitment
  was zero; supplied a nonzero fixture commitment and reran successfully. No contract
  changes were needed.
- World integration remains partial at the architecture/documentation stage:
  `WorldAgentKitAuthorizer` and live AgentBook verification are not implemented.
  A real implementation still needs correct registry configuration, signed challenge
  validation, replay/request binding, and authenticated live tests—not just an env flag.
- Verification run: TypeScript typecheck passed; `npm test` passed 59 tests,
  with only the 12 existing Base-fork tests skipped without an external RPC. This
  includes real wallet signatures, local on-chain event assertions, stolen-bundle
  rejection, log redaction, and a lost-broadcast-response regression that prevents
  automatic resubmission. `npm run demo:redemption` and Solidity regressions passed.
- Repeated the suite and demo with CI's Foundry 1.8.1 toolchain. Its asynchronous
  mining exposed a fixture assumption in the lost-response test; the test now waits
  for the acknowledged transaction's receipt before checking state. All 59 tests
  passed again; Solidity tests and `forge fmt --check` also passed on 1.8.1.

## Message for World / ETHOnline sponsor channel

**Draft only. No message has been posted by this implementation session, and no
response or lack of response is claimed.** Record the actual posting date and link
when sent, then append their answer here.

> Hi — I have World ID Sandbox access for the ETHOnline AgentKit Continuity bounty
> and am blocked on agent registration. Two questions:
>
> 1. The public CLI (`@worldcoin/agentkit-cli@0.2.0`) requires World App verification
> and advertises only `--auto`, `--manual`, and an `API_URL` relay override. How do
> we register sandbox test agents? Is there a sandbox AgentBook address and CLI
> configuration, or does registration go through the sandbox app itself?
>
> 2. The integration docs say registration and AgentBook lookup use World Chain,
> while the CLI registration README still says Base with a different registry
> address. Which registry should we verify against for agents buying receipts on
> Base? Can an agent sign/pay on Base while its registration resolves on World Chain?
>
> I need two agents: a legitimate buyer and an attacker whose stolen redemption
> bundle must be rejected. If registration is unavailable, are there pre-registered
> sandbox agents with a supported way for us to sign test challenges as them?
>
> The endpoint is implemented behind an authorization interface with working
> wallet-signature tests; we're explicitly not presenting the mock as a verified
> human registration. Repo: https://github.com/notaxyz/entitlements

### Follow-up evidence

- Posted date / channel / message link: not recorded.
- World response: not recorded.
- Sandbox registry and network confirmed by World: not recorded.
- Registration transactions and authenticated A/B lookups: pending.
