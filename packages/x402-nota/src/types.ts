import type { Address, Hex } from "viem";

/// The seller-signed quote, exactly as `NotaX402Settlement.settleWithAuthorization` takes it.
export interface SignedReceiptQuote {
  listingId: bigint;
  buyer: Address;
  purchaseRef: Hex;
  amount: bigint;
  metadataHash: Hex;
  agentId: Hex;
  integratorFeeRecipient: Address;
  integratorFeeAmount: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
}

/// The EIP-3009 payload the buyer signs. `to` is always the adapter.
export interface ReceiveAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/// One line of the itemised purchase. `unitAmount` is in settlement-token base units.
export interface CheckoutItem {
  sku: string;
  name: string;
  quantity: number;
  unitAmount: string;
}

/**
 * The canonical checkout metadata document. `keccak256` over its JCS form is `quote.metadataHash`,
 * which the seller signs, so this is the itemisation a buyer can verify before paying.
 *
 * It MUST NOT carry secrets or buyer PII. In particular it must never carry `purchaseRefNonce`:
 * that is the redemption credential, and this document is published in the 402 response.
 */
export interface CheckoutMetadata {
  schema: "nota.checkout.v1";
  seller: string;
  listingId: string;
  resource: string;
  description: string;
  currency: string;
  items: CheckoutItem[];
  totalAmount: string;
  issuedAt: string;
  expiresAt: string;
}

/// JSON-safe forms. `bigint` does not survive `JSON.stringify`, so the wire uses decimal strings.
export interface SignedReceiptQuoteWire {
  listingId: string;
  buyer: Address;
  purchaseRef: Hex;
  amount: string;
  metadataHash: Hex;
  agentId: Hex;
  integratorFeeRecipient: Address;
  integratorFeeAmount: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ReceiveAuthorizationWire {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export const NOTA_EXTENSION_KIND = "nota.receipt.v1" as const;

/**
 * What a Nota 402 response carries alongside standard x402 payment requirements.
 *
 * This is the differentiator. Plain x402 tells an agent a price; this tells it what it is buying
 * (`metadata`), lets it check that the seller signed exactly that (`metadata.hash` against
 * `quote.metadataHash`), and names the one contract the payment authorization may be bound to
 * (`adapter`).
 *
 * It deliberately does NOT carry `purchaseRefNonce`. That value is the redemption credential; it
 * never appears in a 402 response, a settlement request, or settlement calldata.
 */
export interface NotaExtension {
  kind: typeof NOTA_EXTENSION_KIND;
  chainId: number;
  store: Address;
  settlementToken: Address;
  purchaseRefRegistry: Address;
  /// The only contract a buyer authorization may name as its payee.
  adapter: Address;
  /// Nota-aware relayer that will submit the settlement and pay the gas.
  facilitator: string;
  /// Listing seller. Not a member of the quote struct, but part of the signed EIP-712 payload.
  seller: Address;
  quote: SignedReceiptQuoteWire;
  sellerSignature: Hex;
  /// Address asserted to have produced `sellerSignature`; the zero address means the seller.
  claimedSigner: Address;
  metadata: {
    /// Inline document. Either this or `uri` is present; inline is preferred so the buyer can
    /// verify the commitment without a second network hop it would also have to trust.
    document?: CheckoutMetadata;
    uri?: string;
    /// Must equal `quote.metadataHash`. Present so a mismatch is a first-class, loggable failure
    /// rather than something a buyer has to notice by comparing two other fields.
    hash: Hex;
  };
}

/// Standard-shaped x402 payment requirements, with Nota hanging off `extensions`.
export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: Address;
  asset: Address;
  maxTimeoutSeconds: number;
}

export interface PaymentRequiredResponse {
  x402Version: 1;
  error: string;
  accepts: PaymentRequirements[];
  extensions: {
    [NOTA_EXTENSION_KIND]?: NotaExtension;
  };
}

/// What the client sends back once settlement has landed, in the `X-PAYMENT` header.
export interface PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: string;
  payload: {
    kind: typeof NOTA_EXTENSION_KIND;
    purchaseRef: Hex;
    adapter: Address;
    /// A hint for logs only. The resource server locates the settlement from chain state and
    /// never treats this as evidence.
    txHash?: Hex;
  };
}

/// Facilitator wire types.
export interface SettlementRequest {
  adapter: Address;
  quote: SignedReceiptQuoteWire;
  sellerSignature: Hex;
  claimedSigner: Address;
  authorization: ReceiveAuthorizationWire;
  buyerSignature: Hex;
}

export interface SettlementResponse {
  txHash: Hex;
  blockNumber: string;
  receiptId: string;
  purchaseRef: Hex;
  listingId: string;
  seller: Address;
  buyer: Address;
  amount: string;
}

export function quoteToWire(quote: SignedReceiptQuote): SignedReceiptQuoteWire {
  return {
    listingId: quote.listingId.toString(),
    buyer: quote.buyer,
    purchaseRef: quote.purchaseRef,
    amount: quote.amount.toString(),
    metadataHash: quote.metadataHash,
    agentId: quote.agentId,
    integratorFeeRecipient: quote.integratorFeeRecipient,
    integratorFeeAmount: quote.integratorFeeAmount.toString(),
    issuedAt: quote.issuedAt.toString(),
    expiresAt: quote.expiresAt.toString(),
  };
}

export function quoteFromWire(wire: SignedReceiptQuoteWire): SignedReceiptQuote {
  return {
    listingId: BigInt(wire.listingId),
    buyer: wire.buyer,
    purchaseRef: wire.purchaseRef,
    amount: BigInt(wire.amount),
    metadataHash: wire.metadataHash,
    agentId: wire.agentId,
    integratorFeeRecipient: wire.integratorFeeRecipient,
    integratorFeeAmount: BigInt(wire.integratorFeeAmount),
    issuedAt: BigInt(wire.issuedAt),
    expiresAt: BigInt(wire.expiresAt),
  };
}

export function authorizationToWire(
  authorization: ReceiveAuthorization,
): ReceiveAuthorizationWire {
  return {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    nonce: authorization.nonce,
  };
}

export function authorizationFromWire(
  wire: ReceiveAuthorizationWire,
): ReceiveAuthorization {
  return {
    from: wire.from,
    to: wire.to,
    value: BigInt(wire.value),
    validAfter: BigInt(wire.validAfter),
    validBefore: BigInt(wire.validBefore),
    nonce: wire.nonce,
  };
}
