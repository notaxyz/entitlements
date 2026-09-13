# AI assistance and provenance

[Project overview](../README.md) · [Prompt artifacts](./PROMPTS.md)

Where and how AI tools were used during ETHOnline 2026, as far as this repository's
Git history establishes it (compiled 2026-09-13).

## Where AI was used

| When | Tool | What it helped with | Evidence and files |
| --- | --- | --- | --- |
| 2026-09-07 → 09-09 | Claude | x402 settlement adapter, ERC-1271 buyer signatures, accepted-consumer redemption, deterministic and fork tests, deployment script, shared x402 package, facilitator, resource server, buying client, quote-bound payment authorization, signed paid access, trust configuration, quote persistence and related docs | `Co-Authored-By: Claude` trailers on all 22 commits `e340f92` … `a3a6742`; `src/NotaX402Settlement.sol`, `src/EntitlementRedemption.sol` (accepted-consumer change), interfaces, mocks, `test/`, `script/DeployNotaX402Settlement.s.sol`, `packages/{x402-nota,facilitator,resource-server,client,e2e}` as introduced there |
| 2026-09-12 | Claude | Live-demo failure reporting and read-only preflight; recording the mainnet demo and Studio verification in the manifests | Trailers on `5b60732`, `76eb742`; live-demo files in `packages/e2e`, `package.json` (`demo:preflight`), both deployment manifests. The builder ran the transactions |
| 2026-09-13 | OpenAI Codex | Story mode: awaitable step callbacks, six-act presenter, CLI wiring, tests and README | `14864c8`; `packages/e2e/{src,scripts,test}` story files. Driven by the [story-mode prompt](./PROMPTS.md) |
| 2026-09-13 | Tool not recorded | Story-mode logging of known application HTTP routes and response statuses | `packages/e2e/src/{story.ts,fixture.ts,live-fixture.ts}` and story tests |
| 2026-09-13 | OpenAI Codex, then Claude Code | Documentation restructure: judge-facing README, pages under `documentation/`, environment comments, and checking claims against source and both manifests | README, `packages/README.md`, `REDEMPTION.md`, SECURITY, WORLD_FEEDBACK, `.env.example`, `documentation/*`; no contract, manifest or script changes |

## What the builder did

The builder defined requirements and scope, corrected trust-model claims, reviewed
changes before each commit, and ran every mainnet deployment and demo transaction
from their own terminal. Credentials and redemption bundles never appear in this
repository.

## Limits of this record

Commits without a trailer (the 2026-09-06 scaffold and redemption commits, and the
2026-09-10 → 09-12 endpoint, connected-demo, Graph and deployment commits other than
those listed) carry no AI attribution in Git; that is not a claim that no AI was
used. Model labels in trailers are Git attribution, not independently verified.
Earlier planning prompts are not archived in this repository; no spec-driven tool
(OpenSpec, Kiro, spec-kit) is claimed.
