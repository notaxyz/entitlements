import { keccak256, stringToBytes, type Hex } from "viem";

import { canonicalize } from "./jcs.js";
import type { CheckoutMetadata, SignedReceiptQuote } from "./types.js";

/// The commitment the seller signs: keccak256 over the JCS-canonicalized document.
export function hashCheckoutMetadata(document: CheckoutMetadata): Hex {
  return keccak256(stringToBytes(canonicalize(document)));
}

export interface MetadataVerificationInput {
  document: CheckoutMetadata;
  /// The hash the extension claims. Checked against both the document and the quote.
  declaredHash: Hex;
  quote: SignedReceiptQuote;
  /// The URL the agent actually asked for.
  resource: string;
}

export type MetadataVerification =
  | { ok: true; hash: Hex }
  | { ok: false; hash: Hex; problems: string[] };

/**
 * Everything a buyer can check about an itemised purchase before signing anything.
 *
 * The first check is the one that matters: recompute the commitment from the document and compare
 * it with what the seller signed. A document that does not hash to `quote.metadataHash` was not
 * the document the seller committed to, whatever it claims to say.
 *
 * The rest catch a seller who committed to a document that is internally inconsistent or that
 * describes a different purchase than the quote charges for -- signed, but still not what the
 * agent asked to buy.
 */
export function verifyMetadataCommitment(
  input: MetadataVerificationInput,
): MetadataVerification {
  const { document, declaredHash, quote, resource } = input;
  const problems: string[] = [];
  const hash = hashCheckoutMetadata(document);

  if (hash !== quote.metadataHash) {
    problems.push(
      `metadata document does not match the seller's commitment: recomputed ${hash}, quote commits to ${quote.metadataHash}`,
    );
  }

  if (declaredHash !== quote.metadataHash) {
    problems.push(
      `extension declares metadata hash ${declaredHash} but the signed quote commits to ${quote.metadataHash}`,
    );
  }

  if (document.schema !== "nota.checkout.v1") {
    problems.push(`unsupported metadata schema: ${document.schema}`);
  }

  let itemTotal = 0n;
  for (const [index, item] of document.items.entries()) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      problems.push(`item ${index} (${item.sku}) has a non-positive quantity`);
      continue;
    }
    itemTotal += BigInt(item.unitAmount) * BigInt(item.quantity);
  }

  const declaredTotal = BigInt(document.totalAmount);

  if (itemTotal !== declaredTotal) {
    problems.push(
      `itemisation does not add up: lines total ${itemTotal}, document states ${declaredTotal}`,
    );
  }

  if (declaredTotal !== quote.amount) {
    problems.push(
      `document total ${declaredTotal} does not match the amount being charged ${quote.amount}`,
    );
  }

  if (document.listingId !== quote.listingId.toString()) {
    problems.push(
      `document is for listing ${document.listingId} but the quote is for ${quote.listingId}`,
    );
  }

  if (document.resource !== resource) {
    problems.push(`document describes ${document.resource}, not the requested ${resource}`);
  }

  return problems.length === 0 ? { ok: true, hash } : { ok: false, hash, problems };
}
