import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseRpcUrl, startFixture, type Fixture } from "../src/fixture.js";
import { startLiveFixture, type LiveFixture } from "../src/live-fixture.js";
import { runConnectedDemo } from "../src/connected-demo.js";
import { collectLiveEvidence } from "../src/live-evidence.js";
import { deployed } from "../../subgraph/checks/deployments.js";

// Even when enabled, all transactions go ONLY to a disposable localhost Anvil fork.
// No actual CLI --live invocation, real wallet env, or repository manifest updates.
(baseRpcUrl() ? describe : describe.skip)(
  "live runner against recorded Base contracts on a disposable fork",
  () => {
    let fork: Fixture;
    let live: LiveFixture;
    let directory: string;
    const submitted: string[] = [];
    beforeAll(async () => {
      fork = await startFixture();
      directory = await mkdtemp(path.join(tmpdir(), "nota-live-path-fork-"));
      await fork.publicClient.request({
        method: "anvil_setIntervalMining" as never,
        params: [1] as never,
      });
      const sellerKey = keccak256(toHex("nota-x402-e2e:seller"));
      const buyerKey = keccak256(toHex("nota-x402-e2e:buyer"));
      const relayerKey = keccak256(toHex("nota-x402-e2e:relayer"));
      live = await startLiveFixture(
        {
          rpcUrl: fork.rpcUrl,
          sellerKey,
          buyerKey,
          relayerKey,
          seller: privateKeyToAccount(sellerKey).address,
          buyer: fork.buyer,
          relayer: fork.relayer,
          amount: 100_000n,
          stateDir: path.join(directory, "run"),
        },
        (kind, _hash) => submitted.push(kind),
      );
    });
    afterAll(async () => {
      await live?.stop();
      await fork?.stop();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    it("uses the recorded addresses, spends 0.10 fork USDC, observes advancing blocks and never mutates real manifests", async () => {
      expect(live.adapter).toBe(deployed.adapter);
      expect(live.redemption).toBe(deployed.redemption);
      const steps = await runConnectedDemo(live);
      const evidence = await collectLiveEvidence(live, steps);
      expect(submitted).toEqual(["listing", "settlement", "redemption"]);
      expect(evidence.amount).toBe("100000");
      expect(evidence.authentication.humanVerified).toBe(false);
      const bundle = JSON.parse(
        await readFile(path.join(live.stateDir, "buyer-bundle.json"), "utf8"),
      );
      expect(JSON.stringify(evidence)).not.toContain(bundle.rawPurchaseRef);
      expect(JSON.stringify(evidence)).not.toContain(bundle.purchaseRefNonce);
    });
  },
);
