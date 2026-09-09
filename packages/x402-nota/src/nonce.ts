import { encodeAbiParameters, hashTypedData, keccak256, stringToBytes, type Hex } from "viem";

import { signedQuoteTypedData, type QuoteSigningContext } from "./quote.js";
import type { SignedReceiptQuote } from "./types.js";

/// Mirrors `NotaX402Settlement.AUTHORIZATION_NONCE_DOMAIN`.
export const AUTHORIZATION_NONCE_DOMAIN: Hex = keccak256(
  stringToBytes("nota.x402.authorizationNonce.v1"),
);

/// The EIP-712 digest the store signs a quote over. Byte-identical to the store's own
/// `hashSignedReceiptQuote`, so it can be computed offline without an RPC round trip.
export function quoteDigest(quote: SignedReceiptQuote, context: QuoteSigningContext): Hex {
  const typedData = signedQuoteTypedData(quote, context);
  return hashTypedData({
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}

/**
 * The only EIP-3009 nonce the adapter will accept for this quote.
 *
 * This is what stops an observed authorization being lifted onto a different seller's quote for
 * the same amount: the buyer's signature covers the nonce, and the nonce commits to the whole
 * quote digest.
 *
 * `paymentSalt` is public payment-path entropy. It is not the redemption `purchaseRefNonce` and
 * must never be derived from it -- the salt travels in settlement calldata.
 */
export function deriveAuthorizationNonce(digest: Hex, paymentSalt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [AUTHORIZATION_NONCE_DOMAIN, digest, paymentSalt],
    ),
  );
}
