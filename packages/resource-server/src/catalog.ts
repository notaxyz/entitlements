import type { CheckoutMetadata } from "@nota/x402-nota";

export interface CatalogEntry {
  id: string;
  description: string;
  /// Settlement-token base units. USDC has six decimals, so 10_000_000 is 10 USDC.
  amount: bigint;
  items: CheckoutMetadata["items"];
  body: unknown;
}

/// One paid resource. This is a single vertical path, not a general x402 server.
export const CATALOG: Record<string, CatalogEntry> = {
  "base-usdc-flows-2026-09": {
    id: "base-usdc-flows-2026-09",
    description: "Base USDC flow report, September 2026",
    amount: 10_000_000n,
    items: [
      {
        sku: "report-base-usdc-2026-09",
        name: "Base USDC flow report (September 2026)",
        quantity: 1,
        unitAmount: "9000000",
      },
      { sku: "csv-appendix", name: "CSV appendix", quantity: 2, unitAmount: "500000" },
    ],
    body: {
      report: "base-usdc-flows-2026-09",
      netInflowUsd: 412_800_000,
      topBridges: ["Base Bridge", "Across", "Stargate"],
      note: "Paid content. Returned only after a settled Nota receipt is found on chain.",
    },
  },
};
