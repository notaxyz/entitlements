import { startFixture } from "../src/fixture.js";
import { runConnectedDemo } from "../src/connected-demo.js";
import { createInterface } from "node:readline/promises";
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acquireLiveRunLock,
  demoMode,
  LIVE_CONFIRMATION,
  LiveConfigError,
  readLiveConfig,
  repoRoot,
  requireLiveConfirmation,
  describeSafeCause,
} from "../src/live-config.js";
import { preflightLive, startLiveFixture } from "../src/live-fixture.js";
import {
  collectLiveEvidence,
  recordLiveEvidence,
} from "../src/live-evidence.js";

async function main() {
  if (demoMode(process.argv.slice(2)) === "live") return runLive();
  if (!process.env.BASE_RPC_URL) throw new Error("Missing fork source");
  console.info(
    "BASE FORK ONLY: real deployed Nota/USDC dependencies, new contracts deployed locally. No public-chain transactions.",
  );
  console.info(
    "AUTHENTICATION: mock-wallet signatures, humanVerified=false. No World ID or AgentBook verification.",
  );
  console.info(
    "BUNDLE: buyer-generated before checkout, shared privately with merchant/configured RPC; excluded from payment messages and logs.",
  );
  const fixture = await startFixture();
  try {
    await runConnectedDemo(fixture, (step) =>
      console.info(JSON.stringify(step)),
    );
    console.info(
      "PASS: one purchase, attacker rejected before redemption, buyer redeemed once, replay rejected. Buyer sent no transactions and held zero ETH.",
    );
    console.info(
      "All displayed transaction hashes belong to the disposable local fork, not Base mainnet.",
    );
  } finally {
    await fixture.stop();
  }
}

async function runLive() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new LiveConfigError(
      "Interactive terminal required; run directly, without a pipe or output redirection",
    );
  const config = readLiveConfig(process.env);
  const manifests = await Promise.all(
    ["base.json", "subgraph-base.json"].map(async (name) =>
      JSON.parse(
        await readFile(path.join(repoRoot, "deployments", name), "utf8"),
      ),
    ),
  ).catch(() => {
    throw new LiveConfigError(
      "Cannot read deployments/base.json or deployments/subgraph-base.json; check that both files exist and contain valid JSON",
    );
  });
  if (manifests.some((m) => m.publicDemo))
    throw new LiveConfigError(
      "Demo already recorded; review before another paid run",
    );
  // Read-only: surface configuration, balance and RPC problems before confirmation and the run lock.
  await preflightLive(config);
  console.info(
    JSON.stringify({
      mode: "BASE MAINNET — REAL FUNDS",
      seller: config.seller,
      buyer: config.buyer,
      relayer: config.relayer,
      amountUSDCBaseUnits: config.amount.toString(),
      adapter: manifests[0].notaX402Settlement.address,
      redemption: manifests[0].entitlementRedemption.address,
    }),
  );
  console.info(
    "AUTHENTICATION: mock-wallet signatures, humanVerified=false; not World ID or AgentBook verification.",
  );
  console.info(
    "Creates one listing, transfers the specified real USDC via EIP-3009, and redeems once. Seller/relayer pay gas. No contract deployments. Use dedicated wallets; send no other wallet transactions during this run.",
  );
  console.info(
    "Buyer generates the preimage bundle. It is shared with merchant/RPC and revealed in redemption calldata, never logged. Private recovery files remain in LIVE_DEMO_STATE_DIR.",
  );
  console.info(
    "On failure, reconcile printed hashes and private recovery files before retrying. A fresh run is a NEW purchase, not a resume.",
  );
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    requireLiveConfirmation(
      await terminal.question(`Type ${LIVE_CONFIRMATION} to proceed: `),
      true,
    );
  } finally {
    terminal.close();
  }
  // Retain this lock on ANY incomplete live run, including uncertain send outcomes.
  const releaseRunLock = await acquireLiveRunLock();
  const fixture = await startLiveFixture(config, (kind, hash) => {
    const record = {
      kind,
      transactionHash: hash,
      url: `https://basescan.org/tx/${hash}`,
    };
    console.info(JSON.stringify(record));
    appendFileSync(
      path.join(config.stateDir, "transactions.jsonl"),
      JSON.stringify(record) + "\n",
      { mode: 0o600 },
    );
  });
  try {
    const steps = await runConnectedDemo(fixture, (step) =>
      console.info(
        JSON.stringify({
          ...step,
          ...(step.transactionHash
            ? { url: `https://basescan.org/tx/${step.transactionHash}` }
            : {}),
        }),
      ),
    );
    const evidence = await collectLiveEvidence(fixture, steps);
    await writeFile(
      path.join(config.stateDir, "public-evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await recordLiveEvidence(evidence);
    await releaseRunLock();
    console.info(
      "PASS (Base): purchase, access recovery, attacker rejection, buyer redemption and replay verified. Both manifests updated; buyer sent no transactions. New Graph event parity remains pending. Review before committing.",
    );
  } finally {
    await fixture.stop();
  }
}

main().catch((error) => {
  if (error instanceof LiveConfigError) console.error(error.message);
  // An RPC or failed assertion may contain calldata/bundles. Never print the original error.
  else if (describeSafeCause(error)) console.error(describeSafeCause(error));
  console.error(
    "Connected demo failed or was cancelled; no completion claim. Check configuration, funds, RPC and private recovery files. Reconcile submitted hashes before retrying a live purchase. Keys, bundles and provider details suppressed.",
  );
  process.exitCode = 1;
});
