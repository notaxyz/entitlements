import type { Address, Hex } from "viem";

/**
 * Proof that the party asking for paid content controls the wallet that paid for it.
 *
 * A settled `purchaseRef` is public -- it is published in the 402 response and again in the
 * `X402ReceiptSettled` event -- so it identifies a purchase but proves nothing about who is
 * asking. Releasing content, and especially the redemption credential, needs the requester to
 * demonstrate control of the buyer key rather than merely name it.
 */
export const ACCESS_CHALLENGE_KIND = "nota.access.v1" as const;

export interface AccessChallenge {
  kind: typeof ACCESS_CHALLENGE_KIND;
  challenge: Hex;
  resource: string;
  purchaseRef: Hex;
  buyer: Address;
  expiresAt: number;
}

/**
 * The exact string the buyer signs. Built from the same helper on both sides so the two cannot
 * drift, and scoped to one resource, one purchase and one challenge so a signature captured
 * anywhere cannot be replayed against a different one.
 */
export function accessChallengeMessage(challenge: AccessChallenge): string {
  return [
    "Nota entitlement access",
    "",
    `resource: ${challenge.resource}`,
    `purchaseRef: ${challenge.purchaseRef}`,
    `buyer: ${challenge.buyer}`,
    `challenge: ${challenge.challenge}`,
    `expiresAt: ${challenge.expiresAt}`,
  ].join("\n");
}

export interface AccessProof {
  challenge: Hex;
  signature: Hex;
}

export function encodeAccessProof(proof: AccessProof): string {
  return Buffer.from(JSON.stringify(proof), "utf8").toString("base64");
}

export function decodeAccessProof(header: string): AccessProof {
  const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as AccessProof;

  if (typeof parsed?.challenge !== "string" || typeof parsed?.signature !== "string") {
    throw new Error("access proof is missing a challenge or signature");
  }

  return parsed;
}
