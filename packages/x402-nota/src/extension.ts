import { isAddressEqual, type Address, type Hex } from "viem";

import {
  NOTA_EXTENSION_KIND,
  quoteFromWire,
  type NotaExtension,
  type PaymentPayload,
  type PaymentRequiredResponse,
  type SignedReceiptQuote,
} from "./types.js";

export class NotaExtensionError extends Error {
  readonly problems: string[];

  constructor(message: string, problems: string[] = []) {
    super(problems.length > 0 ? `${message}: ${problems.join("; ")}` : message);
    this.name = "NotaExtensionError";
    this.problems = problems;
  }
}

/// Pull the Nota extension out of a 402 body, failing loudly rather than returning undefined.
export function requireNotaExtension(body: PaymentRequiredResponse): NotaExtension {
  const extension = body.extensions?.[NOTA_EXTENSION_KIND];

  if (!extension) {
    throw new NotaExtensionError(
      `402 response carries no ${NOTA_EXTENSION_KIND} extension; this client only settles Nota quotes`,
    );
  }

  if (extension.kind !== NOTA_EXTENSION_KIND) {
    throw new NotaExtensionError(`unexpected extension kind ${extension.kind}`);
  }

  return extension;
}

export interface ExtensionExpectations {
  chainId: number;
  buyer: Address;
  /// Largest amount, in base units, this agent is willing to pay for the resource.
  maxAmount: bigint;
  /// Wall-clock seconds, for the quote-expiry check.
  now: bigint;
}

/**
 * Structural checks on the extension itself, before any metadata or signing work.
 *
 * The buyer binding is the important one. An unbound quote (`buyer` zero) is one the adapter
 * rejects outright, and a quote bound to somebody else is one this agent must not fund.
 */
export function checkExtension(
  extension: NotaExtension,
  expectations: ExtensionExpectations,
): string[] {
  const quote = quoteFromWire(extension.quote);
  const problems: string[] = [];

  if (extension.chainId !== expectations.chainId) {
    problems.push(`quote is for chain ${extension.chainId}, expected ${expectations.chainId}`);
  }

  if (quote.buyer === "0x0000000000000000000000000000000000000000") {
    problems.push("quote is unbound (buyer is the zero address); refusing to fund it");
  } else if (!isAddressEqual(quote.buyer, expectations.buyer)) {
    problems.push(`quote is bound to ${quote.buyer}, not to this agent (${expectations.buyer})`);
  }

  if (quote.amount > expectations.maxAmount) {
    problems.push(`quote charges ${quote.amount}, above this agent's limit ${expectations.maxAmount}`);
  }

  if (quote.expiresAt <= expectations.now) {
    problems.push(`quote expired at ${quote.expiresAt} (now ${expectations.now})`);
  }

  if (!extension.metadata.document && !extension.metadata.uri) {
    problems.push("extension carries neither an inline metadata document nor a URI to one");
  }

  return problems;
}

export function extensionQuote(extension: NotaExtension): SignedReceiptQuote {
  return quoteFromWire(extension.quote);
}

export function encodePaymentPayload(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function decodePaymentPayload(header: string): PaymentPayload {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new NotaExtensionError("X-PAYMENT header is not base64-encoded JSON");
  }

  const payload = parsed as PaymentPayload;

  if (payload?.payload?.kind !== NOTA_EXTENSION_KIND) {
    throw new NotaExtensionError("X-PAYMENT header does not carry a Nota settlement payload");
  }

  return payload;
}

export function buildPaymentPayload(
  network: string,
  purchaseRef: Hex,
  adapter: Address,
  txHash?: Hex,
): PaymentPayload {
  return {
    x402Version: 1,
    scheme: "exact",
    network,
    payload: { kind: NOTA_EXTENSION_KIND, purchaseRef, adapter, txHash },
  };
}
