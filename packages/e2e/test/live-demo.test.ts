import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  encodeEventTopics,
  encodeAbiParameters,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  acquireLiveRunLock,
  demoMode,
  describeSafeCause,
  LIVE_CONFIRMATION,
  LiveConfigError,
  readLiveConfig,
  repoRoot,
  requireLiveConfirmation,
} from "../src/live-config.js";
import {
  listingCreatedEvent,
  listingIdFromReceipt,
} from "../src/live-fixture.js";
import {
  recordLiveEvidence,
  successfulDemoHashes,
  type LiveEvidence,
} from "../src/live-evidence.js";
import { deployed } from "../../subgraph/checks/deployments.js";
import type { DemoStep } from "../src/connected-demo.js";

const sellerKey = keccak256(toHex("live-demo-unit-test-seller"));
const buyerKey = keccak256(toHex("live-demo-unit-test-buyer"));
const seller = privateKeyToAccount(sellerKey).address;
const env = {
  BASE_RPC_URL: "https://example.invalid",
  SELLER_PRIVATE_KEY: sellerKey,
  BUYER_PRIVATE_KEY: buyerKey,
  LIVE_DEMO_USDC_AMOUNT: "0.10",
  LIVE_DEMO_STATE_DIR: path.join(repoRoot, "private-data/unit-live"),
};
const ref = keccak256(toHex("public-reference"));
const paymentHash = keccak256(toHex("payment-tx"));
const redemptionHash = keccak256(toHex("redemption-tx"));
const steps: DemoStep[] = [
  { stage: "payment.required", status: 402, purchaseRef: ref },
  {
    stage: "payment.settled",
    status: 200,
    purchaseRef: ref,
    transactionHash: paymentHash,
  },
  { stage: "access.authenticated", status: 200, purchaseRef: ref },
  { stage: "access.recovered", status: 200, purchaseRef: ref },
  {
    stage: "attacker.rejected",
    status: 403,
    purchaseRef: ref,
    code: "BUYER_MISMATCH",
    step: 6,
    transactionsSent: 0,
  },
  {
    stage: "buyer.redeemed",
    status: 201,
    purchaseRef: ref,
    transactionHash: redemptionHash,
    transactionsSent: 1,
  },
  {
    stage: "replay.rejected",
    status: 409,
    purchaseRef: ref,
    code: "ALREADY_REDEEMED",
    step: 5,
    transactionsSent: 0,
  },
];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("live demo safety gates and evidence", () => {
  it("reports malformed RPC configuration without leaking the entered URL", () => {
    for (const url of [
      "",
      "provider-secret-not-a-url",
      "BASE_RPC_URL=https://example.invalid/private-key",
      "http://example.invalid",
    ]) {
      try {
        readLiveConfig({ ...env, BASE_RPC_URL: url });
        throw new Error("Expected configuration rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(LiveConfigError);
        expect((error as Error).message).toBe(
          "Live mode requires an HTTPS Base RPC",
        );
      }
    }
  });
  it("names RPC rate limiting without leaking the provider URL", () => {
    const secretUrl = "https://base.example.invalid/v2/provider-secret";
    const rpc = Object.assign(new Error(`over rate limit ${secretUrl}`), {
      code: -32016,
    });
    const wrapped = Object.assign(new Error(`call failed ${secretUrl}`), {
      name: "ContractFunctionExecutionError",
      cause: Object.assign(new Error(secretUrl), { cause: rpc }),
    });
    expect(describeSafeCause(wrapped)).toMatch(/rate-limiting/);
    expect(describeSafeCause(wrapped)).not.toContain("provider-secret");
    expect(
      describeSafeCause(
        Object.assign(new Error(secretUrl), { name: "TimeoutError" }),
      ),
    ).toBe("Cause (error type only): TimeoutError");
  });
  it("blocks concurrent live invocations until the previous run is reconciled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nota-live-lock-"));
    dirs.push(root);
    const release = await acquireLiveRunLock(root);
    await expect(acquireLiveRunLock(root)).rejects.toBeInstanceOf(
      LiveConfigError,
    );
    await expect(acquireLiveRunLock(root)).rejects.toThrow(
      "live-demo.lock exists",
    );
    await release();
    const nextRelease = await acquireLiveRunLock(root);
    await nextRelease();
  });
  it("defaults to fork and requires the exact standalone --live flag", () => {
    expect(demoMode([])).toBe("fork");
    expect(demoMode(["--live"])).toBe("live");
    for (const args of [
      ["--yes"],
      ["--live=true"],
      ["--live", "--yes"],
      ["--live", "--live"],
    ])
      expect(() => demoMode(args)).toThrow();
  });
  it("requires exact interactive confirmation, with no piped bypass", () => {
    expect(() =>
      requireLiveConfirmation(LIVE_CONFIRMATION, true),
    ).not.toThrow();
    for (const answer of ["", "yes", "SPEND ON BASE "])
      expect(() => requireLiveConfirmation(answer, true)).toThrow();
    expect(() => requireLiveConfirmation(LIVE_CONFIRMATION, false)).toThrow();
  });
  it("the actual CLI refuses --live without a TTY before contacting any RPC", () => {
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "packages/e2e/scripts/connected-demo.ts", "--live"],
        {
          cwd: repoRoot,
          env: { ...process.env, ...env },
          input: "SPEND ON BASE\n",
          stdio: "pipe",
          timeout: 15_000,
        },
      );
      throw new Error("CLI should refuse piped confirmation");
    } catch (error) {
      const result = error as { status: number; stderr: Buffer };
      expect(result.status).toBe(1);
      expect(result.stderr.toString()).toContain("failed or was cancelled");
      expect(result.stderr.toString()).not.toContain(sellerKey);
      expect(result.stderr.toString()).not.toContain(buyerKey);
    }
  });
  it("requires explicit bounded USDC, distinct buyer and protected recovery location", () => {
    const config = readLiveConfig(env);
    expect(config.amount).toBe(100_000n);
    expect(config.relayerKey).toBe(sellerKey);
    for (const change of [
      { LIVE_DEMO_USDC_AMOUNT: "" },
      { LIVE_DEMO_USDC_AMOUNT: "0" },
      { LIVE_DEMO_USDC_AMOUNT: "10.000001" },
      { LIVE_DEMO_USDC_AMOUNT: "1e3" },
      { LIVE_DEMO_USDC_AMOUNT: "0.0000001" },
      { BUYER_PRIVATE_KEY: sellerKey },
      { RELAYER_PRIVATE_KEY: buyerKey },
      { BASE_RPC_URL: "http://127.0.0.1:8545" },
      { LIVE_DEMO_STATE_DIR: repoRoot },
      { LIVE_DEMO_STATE_DIR: path.join(repoRoot, "private-data/../outside") },
    ])
      expect(() => readLiveConfig({ ...env, ...change })).toThrow();
    expect(() =>
      readLiveConfig({ ...env, SELLER_PRIVATE_KEY: "secret-must-not-appear" }),
    ).toThrow("SELLER_PRIVATE_KEY");
  });
  it("selects the mined listing event, not a simulated nextListingId", () => {
    const listingHash = keccak256(toHex("listing"));
    const log = {
      address: deployed.store,
      topics: encodeEventTopics({
        abi: [listingCreatedEvent],
        eventName: "ListingCreated",
        args: { listingId: 999n, seller, listingHash },
      }) as Hex[],
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint8" }],
        [0n, 1],
      ),
    };
    expect(listingIdFromReceipt([log], seller, listingHash)).toBe(999n);
    expect(() =>
      listingIdFromReceipt(
        [{ ...log, address: deployed.adapter }],
        seller,
        listingHash,
      ),
    ).toThrow();
    expect(() =>
      listingIdFromReceipt([log, log], seller, listingHash),
    ).toThrow();
  });
  it("does not turn partial, reordered or failed scenarios into completion evidence", () => {
    expect(successfulDemoHashes(steps)).toEqual({
      purchaseRef: ref,
      settlement: paymentHash,
      redemption: redemptionHash,
    });
    for (const invalid of [
      steps.slice(0, 6),
      [steps[0]!, steps[2]!, steps[1]!, ...steps.slice(3)],
      steps.map((s, i) =>
        i === 4 ? { ...s, step: 5, code: "ALREADY_REDEEMED" } : s,
      ),
      steps.map((s, i) => (i === 6 ? { ...s, transactionsSent: 1 } : s)),
    ])
      expect(() => successfulDemoHashes(invalid)).toThrow();
  });
  it("updates both manifests, preserving historical Graph counts and World status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nota-live-evidence-"));
    dirs.push(root);
    await mkdir(path.join(root, "deployments"));
    for (const name of ["base.json", "subgraph-base.json"]) {
      // Start from the pre-demo state: the real manifests now hold the recorded Base demo.
      const manifest = JSON.parse(
        await readFile(path.join(repoRoot, "deployments", name), "utf8"),
      );
      delete manifest.publicDemo;
      manifest.scope.newPublicPurchaseAndRedemptionDemoRecorded = false;
      await writeFile(
        path.join(root, "deployments", name),
        JSON.stringify(manifest, null, 2) + "\n",
      );
    }
    const evidence = {
      chainId: 8453,
      adapter: deployed.adapter,
      redemptionContract: deployed.redemption,
      transactions: {
        settlement: { hash: paymentHash },
        redemption: { hash: redemptionHash },
      },
      authentication: { humanVerified: false },
    } as LiveEvidence;
    await recordLiveEvidence(evidence, root);
    for (const name of ["base.json", "subgraph-base.json"]) {
      const recorded = JSON.parse(
        await readFile(path.join(root, "deployments", name), "utf8"),
      );
      expect(recorded.scope.newPublicPurchaseAndRedemptionDemoRecorded).toBe(
        true,
      );
      expect(recorded.scope.worldRegistrationVerified).toBe(false);
      expect(recorded.publicDemo.transactions.settlement.hash).toBe(
        paymentHash,
      );
      if (name === "subgraph-base.json")
        expect(recorded.verification.indexedAdapterSettlementCount).toBe(0);
    }
    await expect(recordLiveEvidence(evidence, root)).rejects.toThrow(
      "Existing demo evidence",
    );
  });
});
