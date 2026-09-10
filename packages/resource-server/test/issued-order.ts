import type { SignedReceiptQuoteWire } from "@nota/x402-nota";
import type { Hex } from "viem";
import type { IssuedQuoteRecord } from "../src/store.js";

/** Fixture order known before settlement; never inferred from the transaction under test. */
export function issuedOrder(
  quote: SignedReceiptQuoteWire,
  rawPurchaseRef: string,
  purchaseRefNonce: Hex,
): IssuedQuoteRecord {
  const resource = "http://localhost/reports/test";
  return {
    purchaseRef: quote.purchaseRef,
    quote,
    rawPurchaseRef,
    purchaseRefNonce,
    resource,
    catalogId: "test",
    metadata: {
      schema: "nota.checkout.v1",
      seller: "Test merchant",
      listingId: quote.listingId,
      resource,
      description: "Test order",
      currency: "USDC",
      items: [],
      totalAmount: quote.amount,
      issuedAt: new Date(Number(quote.issuedAt) * 1000).toISOString(),
      expiresAt: new Date(Number(quote.expiresAt) * 1000).toISOString(),
    },
  };
}
