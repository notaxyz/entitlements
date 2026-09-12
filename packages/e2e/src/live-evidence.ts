import assert from "node:assert/strict";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decodeEventLog, isAddressEqual, type Hex } from "viem";
import { x402ReceiptSettledEvent } from "@nota/x402-nota";
import { redemptionAbi } from "../../resource-server/src/redemption/abi.js";
import { deployed } from "../../subgraph/checks/deployments.js";
import { listingIdFromReceipt, type LiveFixture } from "./live-fixture.js";
import { repoRoot } from "./live-config.js";
import type { DemoStep } from "./connected-demo.js";

export function successfulDemoHashes(steps: DemoStep[]) {
  const expected = [
    ["payment.required", 402],
    ["payment.settled", 200],
    ["access.authenticated", 200],
    ["access.recovered", 200],
    ["attacker.rejected", 403],
    ["buyer.redeemed", 201],
    ["replay.rejected", 409],
  ];
  assert.deepEqual(
    steps.map((s) => [s.stage, s.status]),
    expected,
  );
  assert.equal(new Set(steps.map((s) => s.purchaseRef)).size, 1);
  assert.match(steps[0]!.purchaseRef, /^0x[0-9a-fA-F]{64}$/);
  const attack = steps[4]!;
  const replay = steps[6]!;
  assert.equal(attack.code, "BUYER_MISMATCH");
  assert.equal(attack.step, 6);
  assert.equal(attack.transactionsSent, 0);
  assert.equal(replay.code, "ALREADY_REDEEMED");
  assert.equal(replay.step, 5);
  assert.equal(replay.transactionsSent, 0);
  assert.equal(steps[5]!.transactionsSent, 1);
  const settlement = steps[1]!.transactionHash;
  const redemption = steps[5]!.transactionHash;
  assert.match(settlement ?? "", /^0x[0-9a-fA-F]{64}$/);
  assert.match(redemption ?? "", /^0x[0-9a-fA-F]{64}$/);
  assert.notEqual(settlement, redemption);
  return {
    purchaseRef: steps[0]!.purchaseRef,
    settlement: settlement!,
    redemption: redemption!,
  };
}

/** Recheck public receipts after the entire live HTTP flow, before recording completion. */
export async function collectLiveEvidence(f: LiveFixture, steps: DemoStep[]) {
  assert.equal(f.mode, "live");
  assert.equal(await f.publicClient.getChainId(), 8453);
  const hashes = successfulDemoHashes(steps);
  const transactions = {} as Record<
    "listing" | "settlement" | "redemption",
    { hash: Hex; url: string; blockNumber: string; blockHash: Hex }
  >;
  for (const [kind, hash, sender, to] of [
    ["listing", f.listingTransactionHash, f.seller, deployed.store],
    ["settlement", hashes.settlement, f.relayer, f.adapter],
    ["redemption", hashes.redemption, f.seller, f.redemption],
  ] as const) {
    const receipt = await f.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: 120_000,
    });
    assert.equal(receipt.status, "success");
    assert(isAddressEqual(receipt.from, sender));
    assert(receipt.to && isAddressEqual(receipt.to, to));
    assert.equal(
      (await f.publicClient.getBlock({ blockNumber: receipt.blockNumber }))
        .hash,
      receipt.blockHash,
    );
    if (kind === "listing") {
      assert.equal(
        listingIdFromReceipt(receipt.logs, f.seller, f.listingHash),
        f.listingId,
      );
    } else {
      const matches = receipt.logs
        .filter((log) => isAddressEqual(log.address, to))
        .flatMap((log) => {
          try {
            return [
              decodeEventLog({
                abi:
                  kind === "settlement"
                    ? [x402ReceiptSettledEvent]
                    : redemptionAbi,
                data: log.data,
                topics: log.topics,
                strict: true,
              }),
            ];
          } catch {
            return [];
          }
        });
      assert.equal(matches.length, 1);
      const event = matches[0]!;
      assert.equal(event.args.purchaseRef, hashes.purchaseRef);
      assert(isAddressEqual(event.args.seller, f.seller));
      if (event.eventName === "X402ReceiptSettled") {
        assert.equal(kind, "settlement");
        assert(isAddressEqual(event.args.buyer, f.buyer));
        assert.equal(event.args.listingId, f.listingId);
        assert.equal(event.args.amount, f.paymentAmount);
      } else {
        assert.equal(kind, "redemption");
        assert(event.args.redeemedAt > 0n);
      }
    }
    transactions[kind] = {
      hash,
      url: `https://basescan.org/tx/${hash}`,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
    };
  }
  return {
    network: "base",
    chainId: 8453,
    recordedAt: new Date().toISOString(),
    listingId: f.listingId.toString(),
    purchaseRef: hashes.purchaseRef,
    seller: f.seller,
    buyer: f.buyer,
    relayer: f.relayer,
    adapter: f.adapter,
    redemptionContract: f.redemption,
    amount: f.paymentAmount!.toString(),
    tokenSymbol: "USDC",
    transactions,
    authentication: {
      mode: "mock-wallet",
      humanVerified: false,
      worldRegistrationVerified: false,
    },
    scenarios: {
      attacker: {
        status: 403,
        code: "BUYER_MISMATCH",
        step: 6,
        transactionsSent: 0,
      },
      buyer: { status: 201 },
      replay: {
        status: 409,
        code: "ALREADY_REDEEMED",
        step: 5,
        transactionsSent: 0,
      },
    },
    buyerTransactionsSent: 0,
    indexVerification:
      "pending: independently compare these new events with the Studio index",
  };
}

export type LiveEvidence = Awaited<ReturnType<typeof collectLiveEvidence>>;

export async function recordLiveEvidence(
  evidence: LiveEvidence,
  root = repoRoot,
): Promise<void> {
  assert.equal(evidence.chainId, 8453);
  const names = ["base.json", "subgraph-base.json"];
  const originals = await Promise.all(
    names.map((name) => readFile(path.join(root, "deployments", name), "utf8")),
  );
  const manifests = originals.map((value) => JSON.parse(value));
  assert(
    isAddressEqual(manifests[0].notaX402Settlement.address, evidence.adapter),
  );
  assert(
    isAddressEqual(
      manifests[0].entitlementRedemption.address,
      evidence.redemptionContract,
    ),
  );
  const staged: string[] = [];
  try {
    for (const [index, manifest] of manifests.entries()) {
      assert.equal(manifest.chainId, 8453);
      assert.equal(
        typeof manifest.scope.newPublicPurchaseAndRedemptionDemoRecorded,
        "boolean",
      );
      if (manifest.publicDemo)
        throw new Error(
          "Existing demo evidence must be reviewed before replacement",
        );
      manifest.publicDemo = evidence;
      manifest.scope.newPublicPurchaseAndRedemptionDemoRecorded = true;
      const temporary = path.join(
        root,
        "deployments",
        `${names[index]}.${randomUUID()}.tmp`,
      );
      staged.push(temporary);
      await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    }
    for (const [index, name] of names.entries())
      assert.equal(
        await readFile(path.join(root, "deployments", name), "utf8"),
        originals[index],
        "Manifest changed during recording",
      );
    // Atomic per file, not across both files. Public evidence is saved before this call so
    // a disk failure between renames can be reconciled without another paid purchase.
    for (const [index, name] of names.entries())
      await rename(staged[index]!, path.join(root, "deployments", name));
  } finally {
    await Promise.all(staged.map((file) => unlink(file).catch(() => {})));
  }
}
