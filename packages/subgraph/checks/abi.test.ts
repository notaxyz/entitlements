import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  receiptPurchasedV2Event,
  redemptionAbi,
} from "../../resource-server/src/redemption/abi.js";
import { x402ReceiptSettledEvent } from "../../x402-nota/src/abi.js";

// Check the exact event layouts used by the existing receipt decoder, including
// indexed flags. AssemblyScript mapping tests run separately under Matchstick.
describe("subgraph event ABI parity", () => {
  for (const [name, event] of [
    ["NotaReceiptStore", receiptPurchasedV2Event],
    ["NotaX402Settlement", x402ReceiptSettledEvent],
    [
      "EntitlementRedemption",
      redemptionAbi.find((item) => item.type === "event"),
    ],
  ] as const) {
    it(`${name} matches the backend decoder`, () => {
      const abi = JSON.parse(
        readFileSync(new URL(`../abis/${name}.json`, import.meta.url), "utf8"),
      );
      expect(abi).toEqual([event]);
    });
  }
});
