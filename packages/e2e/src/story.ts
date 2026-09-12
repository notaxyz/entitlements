import assert from "node:assert/strict";
import { createInterface } from "node:readline/promises";
import { formatEther, formatUnits, type Hex } from "viem";
import {
  extensionQuote,
  requireNotaExtension,
  verifyMetadataCommitment,
  type PaymentRequiredResponse,
} from "@nota/x402-nota";
import graph from "../../../deployments/subgraph-base.json";
import deployment from "../../../deployments/base.json";
import type { Fixture } from "./fixture.js";
import type { DemoStep } from "./connected-demo.js";

export class StoryCancelled extends Error {}

/** SIGINT is observed at a quiescent boundary, never by interrupting a broadcast. */
export function storyTerminal() {
  let cancelled = false;
  let stoppedAtBoundary = false;
  let active: ReturnType<typeof createInterface> | undefined;
  let abortWait: (() => void) | undefined;
  const cancel = () => {
    cancelled = true;
    abortWait?.();
  };
  process.on("SIGINT", cancel);
  return {
    stoppedAtBoundary: () => stoppedAtBoundary,
    check() {
      if (cancelled) {
        stoppedAtBoundary = true;
        throw new StoryCancelled();
      }
    },
    async pause() {
      if (cancelled) {
        stoppedAtBoundary = true;
        throw new StoryCancelled();
      }
      active = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      active.on("SIGINT", cancel);
      try {
        await new Promise<void>((resolve, reject) => {
          abortWait = () => reject(new StoryCancelled());
          active!.once("close", () => reject(new StoryCancelled()));
          void active!
            .question("\nPress Enter to continue (Ctrl-C to stop): ")
            .then(() => resolve(), reject);
        });
      } catch {
        stoppedAtBoundary = true;
        throw new StoryCancelled();
      } finally {
        abortWait = undefined;
        active.close();
        active = undefined;
      }
      if (cancelled) {
        stoppedAtBoundary = true;
        throw new StoryCancelled();
      }
    },
    close() {
      active?.close();
      process.off("SIGINT", cancel);
    },
  };
}

export function recordQuery(purchaseRef: Hex) {
  assert(/^0x[0-9a-fA-F]{64}$/.test(purchaseRef));
  return `{
  purchases(where: { purchaseRef: "${purchaseRef}" }) {
    purchaseRef buyer seller amount metadataHash
    settlements { kind emitter transactionHash blockNumber }
    redemptions { redemptionContract transactionHash redeemedAt }
  }
}`;
}

/** Presentation-only observer: no extra checkout, signature, transaction, or index query. */
export function createStory(
  f: Fixture,
  pause: () => Promise<void>,
  print: (line: string) => void = console.info,
  check: () => void = () => {},
) {
  let beforeEth: bigint;
  let beforeNonce: number;
  let offerVerified = false;
  let offerHash: Hex | undefined;
  let offerItems: { quantity: number; unitAmount: string }[] = [];
  let purchaseRef: Hex | undefined;
  const titles = [
    "THE OFFER",
    "THE PAYMENT",
    "THE ENTITLEMENT",
    "THE ATTACKER",
    "THE REDEMPTION",
    "THE RECORD",
  ];
  const card = (n: number) =>
    print(`\n${"─".repeat(68)}\n\nACT ${n} — ${titles[n - 1]}\n`);
  const line = (label: string, value: string) =>
    print(`  ${label.padEnd(22)} ${value}`);
  const advance = async (n: number) => {
    await pause();
    check();
    card(n);
  };
  const tx = (hash: Hex) =>
    print(
      f.mode === "live"
        ? `https://basescan.org/tx/${hash}`
        : `Local fork transaction: ${hash}`,
    );
  return {
    async start() {
      check();
      beforeEth = await f.publicClient.getBalance({ address: f.buyer });
      beforeNonce = await f.publicClient.getTransactionCount({
        address: f.buyer,
      });
      card(1);
      line(
        "Network",
        f.mode === "live"
          ? "BASE MAINNET — real funds"
          : "LOCAL BASE FORK — test funds, local transactions",
      );
      line("Purchase", "Illustrative Base USDC flows report (2026-09)");
      line(
        "Timing",
        "Advance the offer within 15 minutes; expired quotes fail closed.",
      );
    },
    // Scope this wrapper to the CLI run and restore global fetch in finally. It observes
    // the same 402; runConnectedDemo's only change remains awaiting its existing callbacks.
    observeFetch(upstream: typeof fetch): typeof fetch {
      return async (input, init) => {
        const response = await upstream(input, init);
        if (
          String(input) === f.resourceUrl &&
          init?.method === "POST" &&
          response.status === 402
        ) {
          const extension = requireNotaExtension(
            (await response.clone().json()) as PaymentRequiredResponse,
          );
          const document = extension.metadata.document;
          assert(document, "Story requires inline offer metadata");
          assert(
            verifyMetadataCommitment({
              document,
              declaredHash: extension.metadata.hash,
              quote: extensionQuote(extension),
              resource: f.resourceUrl,
            }).ok,
            "Story metadata verification failed",
          );
          offerVerified = true;
          offerHash = extension.metadata.hash;
          // Render only selected public values, never arbitrary metadata text or bundles.
          offerItems = document.items.map(({ quantity, unitAmount }) => ({
            quantity,
            unitAmount,
          }));
        }
        return response;
      };
    },
    async onStep(step: DemoStep) {
      check();
      purchaseRef = step.purchaseRef;
      switch (step.stage) {
        case "payment.required":
          assert(offerVerified, "Offer must be checked before narration");
          line(
            "Response",
            "HTTP 402 — payment required, with itemized purchase terms",
          );
          line("Buyer A", f.buyer);
          line("Listing", f.listingId.toString());
          for (const [index, item] of offerItems.entries()) {
            line(
              `Item ${index + 1}`,
              `${item.quantity} × ${formatUnits(BigInt(item.unitAmount), 6)} USDC`,
            );
          }
          line(
            "Amount",
            `${formatUnits(f.paymentAmount ?? 10_000_000n, 6)} USDC`,
          );
          line("Metadata hash", offerHash!);
          line(
            "Checks",
            "Hash MATCHED · item total MATCHED · quote bound to buyer A",
          );
          line("Payment signature", "NOT SIGNED YET");
          line(
            "Next",
            "Client verifies bundle commitment and seller quote before signing.",
          );
          await advance(2);
          break;
        case "payment.settled": {
          const afterEth = await f.publicClient.getBalance({
            address: f.buyer,
          });
          const afterNonce = await f.publicClient.getTransactionCount({
            address: f.buyer,
          });
          assert.equal(afterEth, beforeEth);
          assert.equal(afterNonce, beforeNonce);
          line("Buyer ETH before", formatEther(beforeEth));
          line("Buyer ETH after", formatEther(afterEth));
          line("Buyer tx count", `${beforeNonce} → ${afterNonce} (unchanged)`);
          line(
            "USDC payment",
            `${formatUnits(f.paymentAmount ?? 10_000_000n, 6)} USDC`,
          );
          line("Gas payer", f.relayer);
          line(
            "Settlement",
            "EIP-3009 signed; facilitator relayed; adapter settled. Relayer paid gas.",
          );
          assert(step.transactionHash);
          tx(step.transactionHash);
          line(
            "What this proves",
            "The buyer paid without sending a transaction. The relayer paid gas.",
          );
          await advance(3);
          break;
        }
        case "access.authenticated":
          line("Access", "Buyer authenticated and received the paid resource.");
          break;
        case "access.recovered":
          assert.equal(
            await f.redemptionChain.redeemedAt(step.purchaseRef),
            0n,
          );
          line("Purchase reference", step.purchaseRef);
          line("On-chain state", "PAID · redeemedAt = 0 (not redeemed)");
          line(
            "Recovery",
            "Server restarted · same buyer-generated bundle recovered · no second payment",
          );
          line(
            "Policy",
            "Bundle AND buyer wallet authorization required. Mock wallet, not World verification.",
          );
          await advance(4);
          break;
        case "attacker.rejected":
          line("Attack", "Agent B presents agent A's exact stolen bundle");
          line("Agent B", "HTTP 403 — BUYER_MISMATCH (policy step 6)");
          line(
            "Why rejected",
            "Authenticated wallet does not match the receipt buyer",
          );
          line(
            "Transactions sent",
            "0 — possession of the preimage is not authorization.",
          );
          line(
            "Enforced by",
            "Merchant endpoint — possession alone is not buyer authorization",
          );
          await advance(5);
          break;
        case "buyer.redeemed":
          line(
            "Agent A",
            "Policy passed; seller submitted; EntitlementRedeemed emitted.",
          );
          line("Purchase reference", step.purchaseRef);
          line("Seller / submitter", f.seller);
          assert(step.transactionHash);
          tx(step.transactionHash);
          break;
        case "replay.rejected":
          line(
            "Replay",
            "HTTP 409 — ALREADY_REDEEMED (step 5), 0 transactions sent.",
          );
          line(
            "Evidence",
            "Redeemed once on-chain · endpoint reads redeemedAt and blocks the retry",
          );
          line(
            "Boundary",
            "No second reverted transaction is submitted in this demo.",
          );
          await advance(6);
      }
    },
    async finish() {
      check();
      assert(purchaseRef);
      line("Walkthrough reference", purchaseRef);
      const publicDemo = deployment.publicDemo;
      const queryRef =
        f.mode === "live" ? purchaseRef : (publicDemo.purchaseRef as Hex);
      if (f.mode !== "live") {
        print(
          "\nFORK ONLY: this reference is local and will not appear in the public Studio index.",
        );
        print(
          "\nPUBLIC EVIDENCE — a separate, previously recorded Base mainnet purchase\n",
        );
        line(
          "Mainnet amount",
          `${formatUnits(BigInt(publicDemo.amount), 6)} USDC`,
        );
        line("Mainnet listing", publicDemo.listingId);
        line("Settlement on Base", "Open the confirmed transaction:");
        print(publicDemo.transactions.settlement.url);
        line("Redemption on Base", "Open the confirmed transaction:");
        print(publicDemo.transactions.redemption.url);
      }
      line("Query endpoint", graph.studio.queryUrl);
      line("Query purchaseRef", queryRef);
      print(`\n${recordQuery(queryRef)}\n`);
      line(
        "Look for",
        "Buyer · seller · amount · metadata hash · matching settlement/redemption transactions",
      );
      line(
        "Index boundary",
        "Queryable evidence, not an authorization decision or proof of off-chain delivery",
      );
      print(
        f.mode === "live"
          ? "Paste in Studio; allow indexing to catch up. No query was executed or index result claimed."
          : "Paste this MAINNET query in Studio. This demo does not execute it or claim a fresh verification.",
      );
      await pause();
      check();
    },
  };
}
