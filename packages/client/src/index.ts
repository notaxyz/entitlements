import {
  buildPaymentPayload,
  checkExtension,
  deriveAuthorizationNonce,
  encodePaymentPayload,
  extensionQuote,
  notaChain,
  quoteDigest,
  readTokenDomain,
  requireNotaExtension,
  signReceiveAuthorization,
  verifyMetadataCommitment,
  authorizationToWire,
  quoteToWire,
  type CheckoutMetadata,
  type NotaExtension,
  type PaymentRequiredResponse,
  type ReceiveAuthorization,
  type SettlementRequest,
  type SettlementResponse,
} from "@nota/x402-nota";
import {
  createPublicClient,
  createWalletClient,
  http,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

export interface AgentLogger {
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
}

const consoleLogger: AgentLogger = {
  info: (message, detail) => console.log(`[agent] ${message}`, detail ?? ""),
  warn: (message, detail) => console.warn(`[agent] ${message}`, detail ?? ""),
};

/// Thrown when the agent decides not to pay. Carries every reason, so a refusal is legible.
export class PaymentRefused extends Error {
  readonly problems: string[];

  constructor(message: string, problems: string[]) {
    super(`${message}: ${problems.join("; ")}`);
    this.name = "PaymentRefused";
    this.problems = problems;
  }
}

export interface AgentConfig {
  rpcUrl: string;
  chainId: number;
  /// The buyer key. It signs an authorization; it never sends a transaction and needs no ETH.
  privateKey: Hex;
  /// Ceiling this agent will pay for a resource, in settlement-token base units.
  maxAmount: bigint;
  authorizationTtlSeconds?: bigint;
  logger?: AgentLogger;
  fetchImpl?: typeof fetch;
}

export interface PaidResource<T = unknown> {
  resource: string;
  content: T;
  receipt: SettlementResponse;
  metadata: CheckoutMetadata;
  /// The redemption bundle, if the server chose to release it with the paid response.
  entitlement?: { listingId: string; rawPurchaseRef: string; purchaseRefNonce: Hex };
}

export async function payAndFetch<T = unknown>(
  resourceUrl: string,
  config: AgentConfig,
): Promise<PaidResource<T>> {
  const logger = config.logger ?? consoleLogger;
  const doFetch = config.fetchImpl ?? fetch;
  const buyer = privateKeyToAccount(config.privateKey);
  const chain = notaChain(config.chainId, config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({ account: buyer, chain, transport: http(config.rpcUrl) });

  logger.info(`requesting ${resourceUrl} as ${buyer.address}`);

  const unpaid = await doFetch(resourceUrl, { headers: { "x-payer": buyer.address } });

  if (unpaid.status !== 402) {
    throw new Error(`expected 402 from ${resourceUrl}, got ${unpaid.status}`);
  }

  const body = (await unpaid.json()) as PaymentRequiredResponse;
  const extension = requireNotaExtension(body);
  const quote = extensionQuote(extension);

  const structural = checkExtension(extension, {
    chainId: config.chainId,
    buyer: buyer.address,
    maxAmount: config.maxAmount,
    now: BigInt(Math.floor(Date.now() / 1000)),
  });

  if (structural.length > 0) {
    logger.warn("refusing to pay: the quote itself is not acceptable", structural);
    throw new PaymentRefused("quote rejected", structural);
  }

  const document = await resolveMetadata(extension, doFetch);

  // The check the whole extension exists for. x402 alone would have told this agent a price;
  // here it can confirm what that price is for, and that the seller signed exactly that.
  const verification = verifyMetadataCommitment({
    document,
    declaredHash: extension.metadata.hash,
    quote,
    resource: resourceUrl,
  });

  if (!verification.ok) {
    logger.warn(
      "REFUSING TO PAY: the itemised purchase does not match what the seller committed to",
      verification.problems,
    );
    throw new PaymentRefused("metadata commitment rejected", verification.problems);
  }

  logger.info(
    `verified purchase: ${document.description} for ${document.totalAmount} base units across ${document.items.length} line(s)`,
  );

  const tokenDomain = await readTokenDomain(
    publicClient,
    extension.settlementToken,
    config.chainId,
  );

  // Public payment-path entropy. Fresh per attempt so a cancelled authorization can be replaced,
  // and unrelated to the redemption purchaseRefNonce, which this agent has never seen.
  const paymentSalt = toHex(randomBytes(32));

  const digest = quoteDigest(quote, {
    chainId: config.chainId,
    store: extension.store,
    settlementToken: extension.settlementToken,
    purchaseRefRegistry: extension.purchaseRefRegistry,
    seller: extension.seller,
  });

  const authorization: ReceiveAuthorization = {
    from: buyer.address,
    to: extension.adapter,
    value: quote.amount,
    validAfter: 0n,
    validBefore:
      BigInt(Math.floor(Date.now() / 1000)) + (config.authorizationTtlSeconds ?? 600n),
    // Derived from the quote digest, not chosen at random. This is what makes the signature
    // spendable on this quote and no other: buyer, amount and payee all match across two
    // different sellers' quotes at the same price, but the digest does not.
    nonce: deriveAuthorizationNonce(digest, paymentSalt),
  };

  const buyerSignature = await signReceiveAuthorization(walletClient, authorization, tokenDomain);

  logger.info(`signed an authorization for ${quote.amount} to adapter ${extension.adapter}`);

  const settlement = await relay(
    extension,
    quote,
    authorization,
    buyerSignature,
    paymentSalt,
    doFetch,
  );

  logger.info(`facilitator settled in ${settlement.txHash}, receipt ${settlement.receiptId}`);

  const paid = await doFetch(resourceUrl, {
    headers: {
      "x-payer": buyer.address,
      "x-payment": encodePaymentPayload(
        buildPaymentPayload(
          body.accepts[0]?.network ?? "base",
          quote.purchaseRef,
          extension.adapter,
          settlement.txHash,
        ),
      ),
    },
  });

  if (!paid.ok) {
    const detail = await paid.text();
    throw new Error(`resource still withheld after settlement (${paid.status}): ${detail}`);
  }

  const payload = (await paid.json()) as PaidResource<T>;

  return { ...payload, receipt: settlement, metadata: document };
}

async function resolveMetadata(
  extension: NotaExtension,
  doFetch: typeof fetch,
): Promise<CheckoutMetadata> {
  if (extension.metadata.document) return extension.metadata.document;

  if (!extension.metadata.uri) {
    throw new PaymentRefused("metadata unavailable", [
      "extension carries neither an inline document nor a URI",
    ]);
  }

  const response = await doFetch(extension.metadata.uri);

  if (!response.ok) {
    throw new PaymentRefused("metadata unavailable", [
      `fetching ${extension.metadata.uri} returned ${response.status}`,
    ]);
  }

  // A fetched document is not more trusted than an inline one: it still has to hash to the
  // commitment the seller signed.
  return (await response.json()) as CheckoutMetadata;
}

async function relay(
  extension: NotaExtension,
  quote: ReturnType<typeof extensionQuote>,
  authorization: ReceiveAuthorization,
  buyerSignature: Hex,
  paymentSalt: Hex,
  doFetch: typeof fetch,
): Promise<SettlementResponse> {
  const request: SettlementRequest = {
    adapter: extension.adapter,
    quote: quoteToWire(quote),
    sellerSignature: extension.sellerSignature,
    claimedSigner: extension.claimedSigner,
    authorization: authorizationToWire(authorization),
    buyerSignature,
    paymentSalt,
  };

  const response = await doFetch(`${extension.facilitator}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`facilitator refused the settlement (${response.status}): ${detail}`);
  }

  return (await response.json()) as SettlementResponse;
}

export type { Address };
