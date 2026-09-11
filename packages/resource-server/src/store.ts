import type { CheckoutMetadata, SignedReceiptQuoteWire } from "@nota/x402-nota";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Hex } from "viem";

/**
 * A quote this server issued, in serializable form.
 *
 * `purchaseRefNonce` is the redemption credential, so anything storing this holds a secret. A
 * file-backed store writes it with owner-only permissions; a real deployment should keep it
 * wherever it keeps its other secrets.
 */
export interface IssuedQuoteRecord {
  purchaseRef: Hex;
  quote: SignedReceiptQuoteWire;
  metadata: CheckoutMetadata;
  resource: string;
  rawPurchaseRef: string;
  purchaseRefNonce: Hex;
  catalogId: string;
  /// Missing on historical records, which used merchant-generated bundles.
  bundleSource?: "buyer" | "merchant";
}

export interface QuoteStore {
  get(purchaseRef: Hex): Promise<IssuedQuoteRecord | undefined>;
  put(record: IssuedQuoteRecord): Promise<void>;
}

export function memoryQuoteStore(): QuoteStore {
  const records = new Map<Hex, IssuedQuoteRecord>();

  return {
    async get(purchaseRef) {
      return structuredClone(records.get(purchaseRef.toLowerCase() as Hex));
    },
    async put(record) {
      const key = record.purchaseRef.toLowerCase() as Hex;
      const snapshot = structuredClone(record);
      const existing = records.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
        throw new Error("Cannot replace an issued order");
      }
      records.set(key, snapshot);
    },
  };
}

// Serialize all instances for the same resolved path in this process. This is NOT a
// cross-process writer lock: run one resource-server writer, with read-only redemption workers.
const writes = new Map<string, Promise<void>>();

export function configuredQuoteStore(filePath: string | undefined): QuoteStore {
  if (!filePath || !path.isAbsolute(filePath)) {
    throw new Error(
      "QUOTE_STORE_PATH must be an absolute path to persistent issued orders",
    );
  }
  return fileQuoteStore(filePath);
}

/**
 * A quote survives a restart, because a buyer's settlement does.
 *
 * Losing this state strands paid purchases: the reference is consumed on chain, the money has
 * moved, and the only copy of the redemption credential and the metadata the quote committed to
 * was in memory. A record is therefore written before the signed quote is handed out, not after
 * payment arrives.
 *
 * The whole file is rewritten per record, which is fine at the scale this demo runs at and is not
 * what a production seller backend should do.
 */
export function fileQuoteStore(filePath: string): QuoteStore {
  const target = path.resolve(filePath);

  async function readRecords(): Promise<Map<string, IssuedQuoteRecord>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
      if (!Array.isArray(parsed)) throw new Error();
      const records = new Map<string, IssuedQuoteRecord>();
      for (const record of parsed as IssuedQuoteRecord[]) {
        if (
          !record ||
          typeof record.purchaseRef !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(record.purchaseRef) ||
          records.has(record.purchaseRef.toLowerCase())
        ) throw new Error();
        records.set(record.purchaseRef.toLowerCase(), record);
      }
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      // JSON parse errors can include the document, which contains redemption secrets.
      throw new Error("Issued order storage unavailable");
    }
  }

  return {
    async get(purchaseRef) {
      // No cached snapshot: a separate redemption process must see newly committed orders.
      return (await readRecords()).get(purchaseRef.toLowerCase());
    },
    async put(record) {
      const snapshot = structuredClone(record);
      const result = (writes.get(target) ?? Promise.resolve()).then(async () => {
        const records = await readRecords();
        const key = snapshot.purchaseRef.toLowerCase();
        const existing = records.get(key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
          throw new Error("Cannot replace an issued order");
        }
        records.set(key, snapshot);
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          // Readers see the previous complete snapshot until rename succeeds. Failed writes
          // never enter a memory cache or cause a quote to be handed out as persisted.
          await writeFile(
            temporary,
            JSON.stringify([...records.values()], null, 2),
            { mode: 0o600, flag: "wx" },
          );
          await rename(temporary, target);
        } catch {
          throw new Error("Could not persist issued order");
        } finally {
          await unlink(temporary).catch(() => {});
        }
      });
      const tail = result.catch(() => {});
      writes.set(target, tail);
      try {
        await result;
      } finally {
        if (writes.get(target) === tail) writes.delete(target);
      }
    },
  };
}
