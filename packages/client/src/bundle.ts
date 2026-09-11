import { randomBytes } from "node:crypto";
import { toHex, type Hex } from "viem";

export interface RedemptionBundle {
  rawPurchaseRef: string;
  purchaseRefNonce: Hex;
}

export function createRedemptionBundle(): RedemptionBundle {
  return {
    rawPurchaseRef: `nota_x402_${randomBytes(12).toString("hex")}`,
    purchaseRefNonce: toHex(randomBytes(32)),
  };
}

export function assertPrivateCheckoutUrl(resourceUrl: string): void {
  const url = new URL(resourceUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  ) {
    throw new Error(
      "Buyer bundle checkout requires HTTPS (HTTP is allowed only on loopback)",
    );
  }
}
