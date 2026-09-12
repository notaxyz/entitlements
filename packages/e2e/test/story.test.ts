import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  hashCheckoutMetadata,
  NOTA_EXTENSION_KIND,
  type CheckoutMetadata,
} from "@nota/x402-nota";
import {
  createStory,
  recordQuery,
  StoryCancelled,
  storyTerminal,
} from "../src/story.js";
import { demoMode } from "../src/live-config.js";
import type { Fixture } from "../src/fixture.js";
import type { DemoStep } from "../src/connected-demo.js";
import type { Hex } from "viem";
import deployment from "../../../deployments/base.json";

const readline = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: readline.create }));

const ref = `0x${"12".repeat(32)}` as Hex;
const hash = `0x${"34".repeat(32)}` as Hex;
const steps: DemoStep[] = [
  { stage: "payment.required", status: 402, purchaseRef: ref },
  {
    stage: "payment.settled",
    status: 200,
    purchaseRef: ref,
    transactionHash: hash,
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
    transactionHash: hash,
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
function setup(mode: "fork" | "live" = "fork", pause = vi.fn(async () => {})) {
  const out: string[] = [];
  const fixture = {
    mode,
    listingId: 1n,
    seller: "0x0000000000000000000000000000000000000002",
    relayer: "0x0000000000000000000000000000000000000003",
    buyer: "0x0000000000000000000000000000000000000001",
    resourceUrl: "http://127.0.0.1:1234/reports/base-usdc-flows-2026-09",
    paymentAmount: 100_000n,
    publicClient: {
      getBalance: vi.fn(async () => (mode === "live" ? 123n : 0n)),
      getTransactionCount: vi.fn(async () => 3),
    },
    redemptionChain: { redeemedAt: vi.fn(async () => 0n) },
  } as unknown as Fixture;
  const story = createStory(fixture, pause, (line) => out.push(line));
  const document: CheckoutMetadata = {
    schema: "nota.checkout.v1",
    seller: "Nota",
    listingId: "1",
    resource: fixture.resourceUrl,
    description: "private-marker-never-render-arbitrary-metadata",
    currency: "USDC",
    items: [
      { sku: "report", name: "Report", quantity: 1, unitAmount: "100000" },
    ],
    totalAmount: "100000",
    issuedAt: "2026-09-12T00:00:00Z",
    expiresAt: "2026-09-12T00:15:00Z",
  };
  const committed = hashCheckoutMetadata(document);
  const body = {
    extensions: {
      [NOTA_EXTENSION_KIND]: {
        kind: NOTA_EXTENSION_KIND,
        metadata: { document, hash: committed },
        quote: {
          listingId: "1",
          amount: "100000",
          metadataHash: committed,
          issuedAt: "1",
          expiresAt: "9999999999",
          integratorFeeAmount: "0",
        },
      },
    },
  };
  const upstream = vi.fn(async () =>
    Response.json(body, { status: 402 }),
  ) as unknown as typeof fetch;
  const observe = () =>
    story.observeFetch(upstream)(fixture.resourceUrl, { method: "POST" });
  return { story, fixture, out, body, document, observe, pause, upstream };
}

describe("story presentation", () => {
  it("accepts both flag orders without changing the default or accepting bypass flags", () => {
    expect(demoMode(["--story"])).toBe("fork");
    expect(demoMode(["--live", "--story"])).toBe("live");
    expect(demoMode(["--story", "--live"])).toBe("live");
    for (const args of [
      ["--story", "--story"],
      ["--story=true"],
      ["--story", "--yes"],
    ])
      expect(() => demoMode(args)).toThrow();
  });
  it.each(["fork", "live"] as const)(
    "prints six acts and pauses, accurate balances and replay boundaries (%s)",
    async (mode) => {
      const s = setup(mode);
      await s.story.start();
      const response = await s.observe();
      expect(await response.json()).toEqual(s.body); // observer does not consume or alter response
      for (const step of steps) await s.story.onStep(step);
      await s.story.finish();
      expect(s.pause).toHaveBeenCalledTimes(6);
      expect(s.out.filter((line) => line.includes("ACT "))).toHaveLength(6);
      const output = s.out.join("\n");
      expect(output).toContain("3 → 3 (unchanged)");
      expect(output).toContain("1 × 0.1 USDC");
      expect(output).toContain(hashCheckoutMetadata(s.document));
      expect(output).toContain("NOT SIGNED YET");
      expect(output).toContain(
        "Authenticated wallet does not match the receipt buyer",
      );
      expect(output).toContain("BUYER_MISMATCH");
      expect(output).toContain("ALREADY_REDEEMED");
      expect(output).toContain("No second reverted transaction");
      expect(output).toContain("Mock wallet, not World verification");
      expect(output).not.toContain(s.document.description);
      expect(output).not.toMatch(/rawPurchaseRef|purchaseRefNonce/);
      expect(s.upstream).toHaveBeenCalledTimes(1); // no subgraph or duplicate checkout request
      if (mode === "live") {
        expect(s.out).toContain(`https://basescan.org/tx/${hash}`);
        expect(output).toContain("0.000000000000000123");
      } else {
        expect(output).not.toContain(`https://basescan.org/tx/${hash}`);
        expect(output).toContain(
          "separate, previously recorded Base mainnet purchase",
        );
        expect(output).toContain(
          deployment.publicDemo.transactions.settlement.url,
        );
        expect(output).toContain(
          recordQuery(deployment.publicDemo.purchaseRef as Hex),
        );
        expect(output).not.toContain(recordQuery(ref));
        expect(output).toContain("will not appear in the public Studio index");
      }
    },
  );
  it("awaits Enter instead of starting the next act immediately", async () => {
    let enter!: () => void;
    const s = setup(
      "fork",
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            enter = resolve;
          }),
      ),
    );
    await s.story.start();
    await s.observe();
    let done = false;
    const pending = s.story.onStep(steps[0]!).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(s.out.join("\n")).not.toContain("ACT 2");
    enter();
    await pending;
    expect(s.out.join("\n")).toContain("ACT 2");
  });
  it("never announces a verified offer for unchecked or tampered metadata", async () => {
    const s = setup();
    await expect(s.story.onStep(steps[0]!)).rejects.toThrow(
      "Offer must be checked",
    );
    s.document.items[0]!.unitAmount = "900000";
    await expect(s.observe()).rejects.toThrow("metadata verification failed");
    expect(s.pause).not.toHaveBeenCalled();
  });
  it("checks line-item totals even if the altered document has a matching hash", async () => {
    const s = setup();
    s.document.items[0]!.quantity = 2;
    const committed = hashCheckoutMetadata(s.document);
    s.body.extensions[NOTA_EXTENSION_KIND].metadata.hash = committed;
    s.body.extensions[NOTA_EXTENSION_KIND].quote.metadataHash = committed;
    await expect(s.observe()).rejects.toThrow("metadata verification failed");
  });
  it("only interpolates a validated public reference into the query", () => {
    expect(recordQuery(ref)).toContain(`purchaseRef: "${ref}"`);
    expect(() => recordQuery('" malicious' as Hex)).toThrow();
  });
});

describe("story terminal lifecycle", () => {
  function fakeTerminal() {
    const terminal = new EventEmitter() as EventEmitter & {
      question: ReturnType<typeof vi.fn>;
      close: () => void;
    };
    let enter!: () => void;
    terminal.question = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          enter = resolve;
        }),
    );
    terminal.close = () => {
      terminal.emit("close");
    };
    readline.create.mockReturnValue(terminal);
    return { terminal, enter: () => enter() };
  }
  it("advances on Enter and restores the process signal listener", async () => {
    const count = process.listenerCount("SIGINT");
    const fake = fakeTerminal();
    const terminal = storyTerminal();
    try {
      const waiting = terminal.pause();
      fake.enter();
      await waiting;
      expect(terminal.stoppedAtBoundary()).toBe(false);
    } finally {
      terminal.close();
    }
    expect(process.listenerCount("SIGINT")).toBe(count);
  });
  it.each(["SIGINT", "close"])(
    "cancels a prompt cleanly on %s",
    async (event) => {
      const fake = fakeTerminal();
      const terminal = storyTerminal();
      try {
        const waiting = terminal.pause();
        fake.terminal.emit(event);
        await expect(waiting).rejects.toBeInstanceOf(StoryCancelled);
        expect(terminal.stoppedAtBoundary()).toBe(true);
      } finally {
        terminal.close();
      }
    },
  );
  it("defers a signal during work until a safe step boundary", () => {
    const terminal = storyTerminal();
    try {
      process.emit("SIGINT");
      expect(terminal.stoppedAtBoundary()).toBe(false);
      expect(() => terminal.check()).toThrow(StoryCancelled);
      expect(terminal.stoppedAtBoundary()).toBe(true);
    } finally {
      terminal.close();
    }
  });
});
