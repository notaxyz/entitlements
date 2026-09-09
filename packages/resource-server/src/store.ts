import type { CheckoutMetadata, SignedReceiptQuoteWire } from "@nota/x402-nota";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
}

export interface QuoteStore {
  get(purchaseRef: Hex): Promise<IssuedQuoteRecord | undefined>;
  put(record: IssuedQuoteRecord): Promise<void>;
}

export function memoryQuoteStore(): QuoteStore {
  const records = new Map<Hex, IssuedQuoteRecord>();

  return {
    async get(purchaseRef) {
      return records.get(purchaseRef);
    },
    async put(record) {
      records.set(record.purchaseRef, record);
    },
  };
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
  const records = new Map<Hex, IssuedQuoteRecord>();
  let loaded: Promise<void> | undefined;

  async function load() {
    try {
      const raw = await readFile(filePath, "utf8");
      for (const record of JSON.parse(raw) as IssuedQuoteRecord[]) {
        records.set(record.purchaseRef, record);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async function ready() {
    loaded ??= load();
    await loaded;
  }

  return {
    async get(purchaseRef) {
      await ready();
      return records.get(purchaseRef);
    },
    async put(record) {
      await ready();
      records.set(record.purchaseRef, record);

      await mkdir(path.dirname(filePath), { recursive: true });

      // Written to a sibling and renamed so a crash mid-write cannot truncate the only copy of a
      // redemption credential.
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify([...records.values()], null, 2), { mode: 0o600 });
      await rename(temporary, filePath);
    },
  };
}
