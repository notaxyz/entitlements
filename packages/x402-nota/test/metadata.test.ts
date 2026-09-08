import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/jcs.js";
import { hashCheckoutMetadata, verifyMetadataCommitment } from "../src/metadata.js";
import type { CheckoutMetadata, SignedReceiptQuote } from "../src/types.js";

const RESOURCE = "https://resource.example/reports/base-usdc-flows-2026-09";

function metadata(): CheckoutMetadata {
  return {
    schema: "nota.checkout.v1",
    seller: "Nota Research",
    listingId: "1",
    resource: RESOURCE,
    description: "Base USDC flow report, September 2026",
    currency: "USDC",
    items: [
      { sku: "report-base-usdc-2026-09", name: "Flow report", quantity: 1, unitAmount: "9000000" },
      { sku: "csv-appendix", name: "CSV appendix", quantity: 2, unitAmount: "500000" },
    ],
    totalAmount: "10000000",
    issuedAt: "2026-09-08T00:00:00Z",
    expiresAt: "2026-09-08T01:00:00Z",
  };
}

function quote(overrides: Partial<SignedReceiptQuote> = {}): SignedReceiptQuote {
  return {
    listingId: 1n,
    buyer: "0x00000000000000000000000000000000000000B0",
    purchaseRef: `0x${"11".repeat(32)}`,
    amount: 10_000_000n,
    metadataHash: hashCheckoutMetadata(metadata()),
    agentId: `0x${"00".repeat(32)}`,
    integratorFeeRecipient: "0x0000000000000000000000000000000000000000",
    integratorFeeAmount: 0n,
    issuedAt: 1_700_000_000n,
    expiresAt: 1_700_003_600n,
    ...overrides,
  };
}

describe("canonicalize", () => {
  it("sorts object keys by UTF-16 code unit", () => {
    expect(canonicalize({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}');
  });

  it("is insensitive to insertion order but sensitive to content", () => {
    const left = canonicalize({ x: [1, { b: true, a: null }], y: "z" });
    const right = canonicalize({ y: "z", x: [1, { a: null, b: true }] });

    expect(left).toBe(right);
    expect(left).not.toBe(canonicalize({ y: "z", x: [1, { a: null, b: false }] }));
  });

  it("drops undefined properties and rejects non-finite numbers", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalize({ a: Number.NaN })).toThrow(TypeError);
  });

  it("produces a stable hash regardless of key order", () => {
    const reordered = { ...metadata() };
    expect(hashCheckoutMetadata(reordered)).toBe(hashCheckoutMetadata(metadata()));
  });
});

describe("verifyMetadataCommitment", () => {
  const base = { declaredHash: hashCheckoutMetadata(metadata()), resource: RESOURCE };

  it("accepts a document that matches the commitment", () => {
    const result = verifyMetadataCommitment({ ...base, document: metadata(), quote: quote() });
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered document", () => {
    const tampered = metadata();
    tampered.items[0]!.name = "Something else entirely";

    const result = verifyMetadataCommitment({ ...base, document: tampered, quote: quote() });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems[0]).toMatch(
      /does not match the seller's commitment/,
    );
  });

  it("rejects an itemisation that does not add up to the total", () => {
    const inconsistent = metadata();
    inconsistent.items[1]!.quantity = 3;

    const result = verifyMetadataCommitment({
      ...base,
      document: inconsistent,
      declaredHash: hashCheckoutMetadata(inconsistent),
      quote: quote({ metadataHash: hashCheckoutMetadata(inconsistent) }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.join(" ")).toMatch(/itemisation does not add up/);
  });

  it("rejects a signed document that describes a different price than it charges", () => {
    const cheaper = metadata();
    cheaper.items = [
      { sku: "report", name: "Flow report", quantity: 1, unitAmount: "1000000" },
    ];
    cheaper.totalAmount = "1000000";

    const result = verifyMetadataCommitment({
      ...base,
      document: cheaper,
      declaredHash: hashCheckoutMetadata(cheaper),
      quote: quote({ metadataHash: hashCheckoutMetadata(cheaper) }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.join(" ")).toMatch(
      /does not match the amount being charged/,
    );
  });

  it("rejects a document describing a different resource", () => {
    const result = verifyMetadataCommitment({
      ...base,
      document: metadata(),
      quote: quote(),
      resource: "https://resource.example/reports/something-else",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.join(" ")).toMatch(/document describes/);
  });
});
