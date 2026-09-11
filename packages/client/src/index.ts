import {
  accessChallengeMessage,
  buildPaymentPayload,
  encodeAccessProof,
  type AccessChallenge,
  checkExtension,
  checkTrustedDeployment,
  deriveAuthorizationNonce,
  encodePaymentPayload,
  extensionQuote,
  notaChain,
  notaReceiptStoreAbi,
  notaX402SettlementAbi,
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
  type TrustedDeployment,
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
import { assertPrivateCheckoutUrl, createRedemptionBundle, type RedemptionBundle } from "./bundle.js";
export { createRedemptionBundle, type RedemptionBundle } from "./bundle.js";

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
  /**
   * The deployment this agent trusts, configured out of band.
   *
   * Required, and deliberately so. Without it the 402 response would be self-certifying: hash
   * checks only prove a document matches a quote, not that the quote came from Nota or that the
   * adapter being authorized is Nota's.
   */
  trusted: TrustedDeployment;
  authorizationTtlSeconds?: bigint;
  logger?: AgentLogger;
  fetchImpl?: typeof fetch;
  /// Called before checkout/payment; await durable private storage here for crash recovery.
  /// Without this callback the buyer's copy is in memory until payAndFetch returns.
  onBundleCreated?: (bundle: Readonly<RedemptionBundle>) => Promise<void>;
}

export interface PaidResource<T = unknown> {
  resource: string;
  content: T;
  receipt: SettlementResponse;
  metadata: CheckoutMetadata;
  /// payAndFetch returns the locally generated bundle; refetch may recover a merchant-held copy.
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

  assertPrivateCheckoutUrl(resourceUrl);
  const bundle = createRedemptionBundle();
  if (config.onBundleCreated) {
    try {
      await config.onBundleCreated(Object.freeze({ ...bundle }));
    } catch {
      throw new Error("Could not retain buyer redemption bundle; checkout not started");
    }
  }
  logger.info(`requesting ${resourceUrl} as ${buyer.address}`);

  let unpaid: Response;
  try {
    unpaid = await doFetch(resourceUrl, {
      method: "POST",
      redirect: "error",
      headers: { "x-payer": buyer.address, "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
  } catch {
    // Transport errors can include the request body. Never propagate them to a logger.
    throw new Error("Buyer bundle checkout request failed");
  }

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

  // Before anything is verified against the response, check the response against what this agent
  // independently believes Nota to be. Everything downstream is a check of internal consistency,
  // which a hostile endpoint can satisfy trivially.
  const trustProblems = checkTrustedDeployment(extension, config.trusted);

  if (trustProblems.length > 0) {
    logger.warn("REFUSING TO PAY: the 402 names contracts this agent does not trust", trustProblems);
    throw new PaymentRefused("untrusted deployment", trustProblems);
  }

  const wiringProblems = await checkAdapterWiring(publicClient, extension.adapter, config.trusted);

  if (wiringProblems.length > 0) {
    logger.warn("REFUSING TO PAY: the adapter is not wired to the trusted deployment", wiringProblems);
    throw new PaymentRefused("untrusted adapter", wiringProblems);
  }

  // Independently verify the seller's quote commits to the buyer's own bundle before
  // signing any payment. The configured RPC receives the preimage in this eth_call.
  let reconstructed: Hex;
  try {
    reconstructed = await publicClient.readContract({
      address: config.trusted.store,
      abi: notaReceiptStoreAbi,
      functionName: "hashPurchaseRef",
      args: [extension.seller, quote.listingId, bundle.rawPurchaseRef, bundle.purchaseRefNonce],
    });
  } catch {
    throw new PaymentRefused("bundle verification unavailable", ["canonical hash lookup failed"]);
  }
  if (reconstructed.toLowerCase() !== quote.purchaseRef.toLowerCase()) {
    throw new PaymentRefused("buyer bundle commitment rejected", ["quote references a different bundle"]);
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

  // The seller signature has not been checked yet -- recomputing a hash proves nothing about who
  // signed. The trusted store runs the same validation the settlement will, so a forged
  // signature, an inactive listing or a spent purchase reference is caught before signing rather
  // than after the authorization is already in a facilitator's hands.
  try {
    await publicClient.readContract({
      address: config.trusted.store,
      abi: notaReceiptStoreAbi,
      functionName: "validateSignedReceiptPurchase",
      args: [quote, extension.sellerSignature, buyer.address, extension.claimedSigner],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    logger.warn("REFUSING TO PAY: the store rejected this quote", detail);
    throw new PaymentRefused("quote rejected by the trusted store", [detail ?? "unknown reason"]);
  }

  const tokenDomain = await readTokenDomain(
    publicClient,
    config.trusted.settlementToken,
    config.chainId,
  );

  // Public payment-path entropy. Fresh per attempt so a cancelled authorization can be replaced,
  // and unrelated to the buyer's private redemption purchaseRefNonce.
  const paymentSalt = toHex(randomBytes(32));

  const digest = quoteDigest(quote, {
    chainId: config.trusted.chainId,
    store: config.trusted.store,
    settlementToken: config.trusted.settlementToken,
    purchaseRefRegistry: config.trusted.purchaseRefRegistry,
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

  // Paying does not by itself entitle anyone to the content: purchaseRef is public. The server
  // challenges, and this proves control of the wallet that actually paid.
  const proof = await proveBuyerControl(resourceUrl, quote.purchaseRef, buyer.address, doFetch, (message) =>
    walletClient.signMessage({ account: buyer, message }),
  );

  const paid = await doFetch(resourceUrl, {
    headers: {
      "x-payer": buyer.address,
      "x-payment-auth": proof,
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
    throw new Error(`resource still withheld after settlement (${paid.status})`);
  }

  const payload = (await paid.json()) as PaidResource<T>;

  return {
    ...payload,
    receipt: settlement,
    metadata: document,
    entitlement: { listingId: quote.listingId.toString(), ...bundle },
  };
}

/**
 * Re-read a resource already paid for, without paying again.
 *
 * The purchase reference alone is not a bearer token -- it is public -- so this repeats the
 * challenge-and-sign step. Only the wallet that settled the purchase can do it.
 */
export async function refetchPaidResource<T = unknown>(
  resourceUrl: string,
  purchaseRef: Hex,
  adapter: Address,
  config: AgentConfig,
): Promise<PaidResource<T>> {
  const doFetch = config.fetchImpl ?? fetch;
  const buyer = privateKeyToAccount(config.privateKey);
  const chain = notaChain(config.chainId, config.rpcUrl);
  const walletClient = createWalletClient({ account: buyer, chain, transport: http(config.rpcUrl) });

  const proof = await proveBuyerControl(resourceUrl, purchaseRef, buyer.address, doFetch, (message) =>
    walletClient.signMessage({ account: buyer, message }),
  );

  const response = await doFetch(resourceUrl, {
    headers: {
      "x-payment-auth": proof,
      "x-payment": encodePaymentPayload(buildPaymentPayload("base", purchaseRef, adapter)),
    },
  });

  if (!response.ok) {
    throw new Error(`resource withheld (${response.status}): ${await response.text()}`);
  }

  return (await response.json()) as PaidResource<T>;
}

/// Confirms on chain that the adapter is bound to the trusted store, token and registry, so a
/// look-alike contract at a trusted-looking address cannot pass on its own say-so.
async function checkAdapterWiring(
  publicClient: ReturnType<typeof createPublicClient>,
  adapter: Address,
  trusted: TrustedDeployment,
): Promise<string[]> {
  const problems: string[] = [];

  try {
    const [store, token, registry] = await Promise.all([
      publicClient.readContract({ address: adapter, abi: notaX402SettlementAbi, functionName: "STORE" }),
      publicClient.readContract({
        address: adapter,
        abi: notaX402SettlementAbi,
        functionName: "SETTLEMENT_TOKEN",
      }),
      publicClient.readContract({
        address: adapter,
        abi: notaX402SettlementAbi,
        functionName: "PURCHASE_REF_REGISTRY",
      }),
    ]);

    if (store.toLowerCase() !== trusted.store.toLowerCase()) {
      problems.push(`adapter settles through store ${store}, not the trusted ${trusted.store}`);
    }
    if (token.toLowerCase() !== trusted.settlementToken.toLowerCase()) {
      problems.push(`adapter pays in ${token}, not the trusted ${trusted.settlementToken}`);
    }
    if (registry.toLowerCase() !== trusted.purchaseRefRegistry.toLowerCase()) {
      problems.push(`adapter consumes in ${registry}, not the trusted ${trusted.purchaseRefRegistry}`);
    }
  } catch (error) {
    problems.push(
      `could not read the adapter's wiring: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    );
  }

  return problems;
}

async function proveBuyerControl(
  resourceUrl: string,
  purchaseRef: Hex,
  buyer: Address,
  doFetch: typeof fetch,
  sign: (message: string) => Promise<Hex>,
): Promise<string> {
  const origin = new URL(resourceUrl).origin;
  const response = await doFetch(`${origin}/access/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ purchaseRef }),
  });

  if (!response.ok) {
    throw new Error(`could not obtain an access challenge (${response.status})`);
  }

  const challenge = (await response.json()) as AccessChallenge;

  if (challenge.purchaseRef !== purchaseRef) {
    throw new PaymentRefused("access challenge rejected", [
      `challenge is for ${challenge.purchaseRef}, not the purchase just settled`,
    ]);
  }

  if (challenge.buyer.toLowerCase() !== buyer.toLowerCase()) {
    throw new PaymentRefused("access challenge rejected", [
      `challenge names ${challenge.buyer}, not this agent`,
    ]);
  }

  return encodeAccessProof({
    challenge: challenge.challenge,
    signature: await sign(accessChallengeMessage(challenge)),
  });
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
