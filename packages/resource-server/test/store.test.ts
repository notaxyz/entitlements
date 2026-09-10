import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex, zeroAddress, zeroHash } from "viem";
import { configuredQuoteStore, fileQuoteStore } from "../src/store.js";
import { issuedOrder } from "./issued-order.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    rename: vi.fn(real.rename),
    writeFile: vi.fn(real.writeFile),
  };
});

const realFs =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const order = (id: number) =>
  issuedOrder(
    {
      purchaseRef: keccak256(toHex(`order ${id}`)),
      listingId: "1",
      buyer: "0x1111111111111111111111111111111111111111",
      amount: "1000000",
      metadataHash: zeroHash,
      agentId: zeroHash,
      integratorFeeRecipient: zeroAddress,
      integratorFeeAmount: "0",
      issuedAt: "1000",
      expiresAt: "2000",
    },
    `RAW_BUNDLE_${id}`,
    keccak256(toHex(`SECRET_NONCE_${id}`)),
  );

describe("persistent issued orders", () => {
  let directory: string;
  let filename: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), "nota-order-store-"));
    filename = path.join(directory, "issued-orders.json");
  });
  afterEach(async () => {
    vi.mocked(fs.rename).mockReset().mockImplementation(realFs.rename);
    vi.mocked(fs.writeFile).mockReset().mockImplementation(realFs.writeFile);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("requires explicit absolute storage configuration, never silently defaults to memory", () => {
    for (const value of [undefined, "", "relative.json"]) {
      expect(() => configuredQuoteStore(value)).toThrow("QUOTE_STORE_PATH");
    }
    expect(() => configuredQuoteStore(filename)).not.toThrow();
  });

  it("survives a fresh process reading the committed order", async () => {
    const record = order(1);
    await fileQuoteStore(filename).put(record);
    const moduleUrl = new URL("../src/store.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict';
       import { fileQuoteStore } from ${JSON.stringify(moduleUrl)};
       const record = await fileQuoteStore(process.argv[1]).get(process.argv[2]);
       assert.equal(record?.quote.amount, '1000000');
       assert.equal(record?.rawPurchaseRef, 'RAW_BUNDLE_1');
       assert.equal(record?.purchaseRefNonce, process.argv[3]);
       console.log('restored');`,
      filename,
      record.purchaseRef,
      record.purchaseRefNonce,
    ]);
    expect(stdout.trim()).toBe("restored");
    expect((await fs.stat(filename)).mode & 0o777).toBe(0o600);
  });

  it("does not cache a miss or an old snapshot in a separate reader", async () => {
    const writer = fileQuoteStore(filename);
    const reader = fileQuoteStore(filename);
    const first = order(1);
    const second = order(2);
    expect(await reader.get(first.purchaseRef)).toBeUndefined();
    await writer.put(first);
    expect(await reader.get(first.purchaseRef)).toEqual(first);
    await writer.put(second);
    expect(await reader.get(second.purchaseRef)).toEqual(second);
  });

  it("serializes concurrent writes across instances without dropping any orders", async () => {
    const stores = [fileQuoteStore(filename), fileQuoteStore(filename)];
    const orders = Array.from({ length: 40 }, (_, id) => order(id));
    await Promise.all(orders.map((record, id) => stores[id % 2]!.put(record)));
    const restored = fileQuoteStore(filename);
    for (const record of orders)
      expect(await restored.get(record.purchaseRef)).toEqual(record);
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toHaveLength(40);
    expect(await fs.readdir(directory)).toEqual(["issued-orders.json"]);
  });

  it("keeps pending data invisible until atomic rename commits it", async () => {
    const store = fileQuoteStore(filename);
    await store.put(order(1));
    let release!: () => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => {
      started();
      await paused;
      return realFs.rename(...args);
    });
    const pending = store.put(order(2));
    try {
      await reached;
      expect(await store.get(order(2).purchaseRef)).toBeUndefined();
      expect(await store.get(order(1).purchaseRef)).toEqual(order(1));
    } finally {
      release();
      await pending;
    }
    expect(await store.get(order(2).purchaseRef)).toEqual(order(2));
  });

  it.each(["writeFile", "rename"] as const)(
    "recovers from %s failure without publishing failed records",
    async (method) => {
      const store = fileQuoteStore(filename);
      await store.put(order(1));
      vi.mocked(fs[method]).mockRejectedValueOnce(
        new Error(order(2).rawPurchaseRef),
      );
      await expect(store.put(order(2))).rejects.toThrow(
        "Could not persist issued order",
      );
      expect(await store.get(order(2).purchaseRef)).toBeUndefined();
      await store.put(order(3));
      const restored = fileQuoteStore(filename);
      expect(await restored.get(order(1).purchaseRef)).toEqual(order(1));
      expect(await restored.get(order(2).purchaseRef)).toBeUndefined();
      expect(await restored.get(order(3).purchaseRef)).toEqual(order(3));
      expect(await fs.readdir(directory)).toEqual(["issued-orders.json"]);
    },
  );

  it("fails closed on corruption without echoing secrets or replacing the damaged file", async () => {
    const contents = `BROKEN ${order(1).rawPurchaseRef} ${order(1).purchaseRefNonce}`;
    await fs.writeFile(filename, contents, { mode: 0o600 });
    const store = fileQuoteStore(filename);
    await expect(store.get(order(1).purchaseRef)).rejects.toThrow(
      /^Issued order storage unavailable$/,
    );
    await expect(store.put(order(2))).rejects.toThrow(
      /^Issued order storage unavailable$/,
    );
    expect(await fs.readFile(filename, "utf8")).toBe(contents);
  });

  it("does not allow overwriting an issued order or mutation through a returned object", async () => {
    const record = order(1);
    const store = fileQuoteStore(filename);
    await store.put(record);
    await store.put(record); // Idempotent writes are safe.
    const returned = (await store.get(record.purchaseRef))!;
    returned.quote.amount = "1";
    await expect(store.put(returned)).rejects.toThrow(
      "Cannot replace an issued order",
    );
    expect(await store.get(record.purchaseRef)).toEqual(record);
  });
});
