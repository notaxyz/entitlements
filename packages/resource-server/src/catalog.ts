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
  "arbitrum-sepolia-sample-report": {
    id: "arbitrum-sepolia-sample-report",
    description: "Arbitrum Sepolia sample report (illustrative testnet content)",
    amount: 250_000n,
    items: [
      {
        sku: "report-arbitrum-sepolia-sample",
        name: "Arbitrum Sepolia sample report",
        quantity: 1,
        unitAmount: "200000",
      },
      { sku: "csv-appendix", name: "CSV appendix", quantity: 2, unitAmount: "25000" },
    ],
    body: {
      report: "arbitrum-sepolia-sample-report",
      sampleValues: { transfers: 1_234, uniqueWallets: 56 },
      note: "Illustrative testnet content. Sample values, not market data. Returned only after a settled Nota receipt is found on chain.",
    },
  },
};
