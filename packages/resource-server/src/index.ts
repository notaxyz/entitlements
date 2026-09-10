import {
  accessChallengeMessage,
  ACCESS_CHALLENGE_KIND,
  buildPaymentPayload,
  decodeAccessProof,
  decodePaymentPayload,
  type AccessChallenge,
  hashCheckoutMetadata,
  NETWORK,
  NOTA_EXTENSION_KIND,
  NOTA_SCHEME,
  notaChain,
  notaReceiptStoreAbi,
  purchaseRefRegistryAbi,
  quoteFromWire,
  quoteToWire,
  signQuote,
  x402ReceiptSettledEvent,
  type CheckoutMetadata,
  type NotaExtension,
  type PaymentRequiredResponse,
  type SignedReceiptQuote,
} from "@nota/x402-nota";
import express, { type Express, type Request, type Response } from "express";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddressEqual,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

import { CATALOG } from "./catalog.js";
import { memoryQuoteStore, type QuoteStore } from "./store.js";

export interface ResourceServerConfig {
  rpcUrl: string;
  chainId: number;
  store: Address;
  settlementToken: Address;
  purchaseRefRegistry: Address;
  adapter: Address;
  facilitatorUrl: string;
  /// Listing seller. Signs the quotes.
  sellerPrivateKey: Hex;
  listingId: bigint;
  /// Public origin, used to build the resource URL the metadata document commits to.
  baseUrl: string;
  /// First block to scan for settlements. The adapter's deployment block.
  fromBlock: bigint;
  quoteTtlSeconds?: bigint;
  accessChallengeTtlSeconds?: number;
  /**
   * Where issued quotes live. Defaults to memory, which loses paid purchases on restart; pass
   * `fileQuoteStore(path)` for anything that should survive one.
   */
  quoteStore?: QuoteStore;
}

export function createResourceServer(config: ResourceServerConfig): Express {
  const chain = notaChain(config.chainId, config.rpcUrl);
  const seller = privateKeyToAccount(config.sellerPrivateKey);
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({ account: seller, chain, transport: http(config.rpcUrl) });
  const quoteTtl = config.quoteTtlSeconds ?? 900n;

  const issued = config.quoteStore ?? memoryQuoteStore();
  /// Outstanding access challenges, single-use and short-lived.
  const challenges = new Map<Hex, AccessChallenge>();
  const challengeTtl = config.accessChallengeTtlSeconds ?? 120;

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  const safe = (handler: (request: Request, response: Response) => Promise<void>) =>
    (request: Request, response: Response) => {
      void handler(request, response).catch(() => {
        // Storage/RPC errors may contain the preimage bundle. Never expose diagnostics.
        response.status(503).json({ error: "could not safely process the request" });
      });
    };

  app.get("/health", (_request: Request, response: Response) => {
    response.json({ ok: true, seller: seller.address, listingId: config.listingId.toString() });
  });

  /**
   * Issues a single-use challenge for a settled purchase. Anyone may ask for one -- it grants
   * nothing. Only a signature over it, from the wallet the settlement records as the buyer,
   * releases the content.
   */
  app.post("/access/challenge", safe(async (request: Request, response: Response) => {
    const purchaseRef = (request.body as { purchaseRef?: Hex })?.purchaseRef;
    const record = purchaseRef ? await issued.get(purchaseRef) : undefined;

    if (!purchaseRef || !record) {
      response.status(404).json({ error: "no quote was issued for that purchase reference" });
      return;
    }

    const challenge: AccessChallenge = {
      kind: ACCESS_CHALLENGE_KIND,
      challenge: toHex(randomBytes(32)),
      resource: record.resource,
      purchaseRef,
      buyer: quoteFromWire(record.quote).buyer,
      expiresAt: Math.floor(Date.now() / 1000) + challengeTtl,
    };

    challenges.set(challenge.challenge, challenge);
    response.json(challenge);
  }));

  app.get("/reports/:id", safe(async (request: Request, response: Response) => {
    const entry = CATALOG[request.params.id ?? ""];

    if (!entry) {
      response.status(404).json({ error: "no such report" });
      return;
    }

    const resource = `${config.baseUrl}/reports/${entry.id}`;
    const paymentHeader = request.header("x-payment");

    if (paymentHeader) {
      await serveIfPaid(paymentHeader, request.header("x-payment-auth"), resource, response);
      return;
    }

    const payer = request.header("x-payer") as Address | undefined;

    if (!payer) {
      // A Nota quote binds a specific buyer, and the adapter rejects unbound quotes outright, so
      // the server cannot issue one until the agent says who is paying.
      response.status(402).json({
        x402Version: 1,
        error: `declare a payer address in X-PAYER to receive a bound ${NOTA_EXTENSION_KIND} quote`,
        accepts: [acceptsBlock(resource, entry.description, entry.amount)],
        extensions: {},
      } satisfies PaymentRequiredResponse);
      return;
    }

    try {
      response.status(402).json(await buildPaymentRequired(payer, resource, entry.id));
    } catch {
      response.status(500).json({
        error: "could not issue a quote",
      });
    }
  }));

  function acceptsBlock(resource: string, description: string, amount: bigint) {
    return {
      scheme: NOTA_SCHEME,
      network: NETWORK,
      maxAmountRequired: amount.toString(),
      resource,
      description,
      mimeType: "application/json",
      payTo: seller.address,
      asset: config.settlementToken,
      maxTimeoutSeconds: 120,
    };
  }

  async function buildPaymentRequired(
    payer: Address,
    resource: string,
    catalogId: string,
  ): Promise<PaymentRequiredResponse> {
    const entry = CATALOG[catalogId]!;

    // The entitlement bundle stays on this server until authenticated paid delivery. The raw
    // reference is not necessarily secret; purchaseRefNonce makes purchaseRef unguessable.
    // Payment publishes only the hash. Later redemption publishes the bundle in calldata.
    const rawPurchaseRef = `nota_x402_${randomBytes(12).toString("hex")}`;
    const purchaseRefNonce = toHex(randomBytes(32));

    const purchaseRef = await publicClient.readContract({
      address: config.store,
      abi: notaReceiptStoreAbi,
      functionName: "hashPurchaseRef",
      args: [seller.address, config.listingId, rawPurchaseRef, purchaseRefNonce],
    });

    // The store checks `issuedAt <= block.timestamp`, so the quote is stamped from chain time
    // rather than wall clock. A block is always at or behind the wall clock, and stamping a quote
    // a few seconds into the chain's future makes it permanently invalid.
    const latestBlock = await publicClient.getBlock();
    const issuedAt = latestBlock.timestamp;
    const expiresAt = issuedAt + quoteTtl;

    const metadata: CheckoutMetadata = {
      schema: "nota.checkout.v1",
      seller: "Nota Research",
      listingId: config.listingId.toString(),
      resource,
      description: entry.description,
      currency: "USDC",
      // Cloned: the catalog entry is shared across requests and the document is signed over.
      items: entry.items.map((item) => ({ ...item })),
      totalAmount: entry.amount.toString(),
      issuedAt: new Date(Number(issuedAt) * 1000).toISOString(),
      expiresAt: new Date(Number(expiresAt) * 1000).toISOString(),
    };

    const quote: SignedReceiptQuote = {
      listingId: config.listingId,
      buyer: payer,
      purchaseRef,
      amount: entry.amount,
      metadataHash: hashCheckoutMetadata(metadata),
      agentId: `0x${"00".repeat(32)}`,
      integratorFeeRecipient: "0x0000000000000000000000000000000000000000",
      integratorFeeAmount: 0n,
      issuedAt,
      expiresAt,
    };

    const sellerSignature = await signQuote(walletClient, quote, {
      chainId: config.chainId,
      store: config.store,
      settlementToken: config.settlementToken,
      purchaseRefRegistry: config.purchaseRefRegistry,
      seller: seller.address,
    });

    // Persisted before the signed quote leaves this process. A settlement is irreversible, so a
    // crash between handing out a quote and recording it would strand a paid purchase.
    await issued.put({
      purchaseRef,
      quote: quoteToWire(quote),
      metadata,
      resource,
      rawPurchaseRef,
      purchaseRefNonce,
      catalogId,
    });

    const extension: NotaExtension = {
      kind: NOTA_EXTENSION_KIND,
      chainId: config.chainId,
      store: config.store,
      settlementToken: config.settlementToken,
      purchaseRefRegistry: config.purchaseRefRegistry,
      adapter: config.adapter,
      facilitator: config.facilitatorUrl,
      seller: seller.address,
      quote: quoteToWire(quote),
      sellerSignature,
      claimedSigner: "0x0000000000000000000000000000000000000000",
      metadata: { document: metadata, hash: quote.metadataHash },
    };

    return {
      x402Version: 1,
      error: "payment required",
      accepts: [acceptsBlock(resource, entry.description, entry.amount)],
      extensions: { [NOTA_EXTENSION_KIND]: extension },
    };
  }

  /**
   * Verifies control of the buyer wallet against a challenge this server issued. `purchaseRef` is
   * public, so it says which purchase is being claimed and nothing about who is claiming it.
   *
   * The signature is checked with `verifyMessage`, which falls back to ERC-1271, so a smart-wallet
   * buyer authenticates the same way it paid.
   */
  async function authenticateBuyer(
    proofHeader: string | undefined,
    purchaseRef: Hex,
    resource: string,
    buyer: Address,
  ): Promise<string | undefined> {
    if (!proofHeader) return "missing X-PAYMENT-AUTH; request a challenge from /access/challenge";

    let proof: ReturnType<typeof decodeAccessProof>;
    try {
      proof = decodeAccessProof(proofHeader);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }

    const challenge = challenges.get(proof.challenge);

    if (!challenge) return "unknown or already-used challenge";

    // Single use, whatever the outcome. A challenge that has been answered once is spent.
    challenges.delete(proof.challenge);

    if (challenge.expiresAt < Math.floor(Date.now() / 1000)) return "challenge expired";
    if (challenge.purchaseRef !== purchaseRef) return "challenge is for a different purchase";
    if (challenge.resource !== resource) return "challenge is for a different resource";

    const valid = await publicClient.verifyMessage({
      address: buyer,
      message: accessChallengeMessage(challenge),
      signature: proof.signature,
    });

    return valid ? undefined : `signature does not prove control of ${buyer}`;
  }

  /**
   * Payment is established from chain state alone. The payload names a purchaseRef; everything
   * that decides whether the resource is served comes from the settlement event and the registry.
   * The transaction hash the client may include is used for logging and nothing else.
   *
   * Establishing that a purchase was paid is separate from establishing who is asking. Both are
   * required before any content or credential leaves this server.
   */
  async function serveIfPaid(
    paymentHeader: string,
    proofHeader: string | undefined,
    resource: string,
    response: Response,
  ) {
    let purchaseRef: Hex;

    try {
      purchaseRef = decodePaymentPayload(paymentHeader).payload.purchaseRef;
    } catch (error) {
      response.status(400).json({
        error: "malformed payment payload",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const record = await issued.get(purchaseRef);

    if (!record || record.resource !== resource) {
      response.status(402).json({ error: "no quote was issued for that purchase reference" });
      return;
    }

    const logs = await publicClient.getLogs({
      address: config.adapter,
      event: x402ReceiptSettledEvent,
      fromBlock: config.fromBlock,
      toBlock: "latest",
    });

    const settlement = logs.find((log) => log.args.purchaseRef === purchaseRef);

    if (!settlement) {
      response
        .status(402)
        .json({ error: "no settlement found on chain for that purchase reference" });
      return;
    }

    const settled = settlement.args;

    const quote = quoteFromWire(record.quote);
    const problems: string[] = [];

    if (!isAddressEqual(settled.seller!, seller.address)) {
      problems.push(`settlement paid ${settled.seller!}, not this seller`);
    }
    if (!isAddressEqual(settled.buyer!, quote.buyer)) {
      problems.push(`settlement buyer ${settled.buyer!} is not the quoted buyer`);
    }
    if (settled.amount! !== quote.amount) {
      problems.push(`settlement paid ${settled.amount!}, quote was for ${quote.amount}`);
    }
    if (settled.metadataHash! !== quote.metadataHash) {
      problems.push("settlement commits to different metadata than the issued quote");
    }
    if (settled.listingId! !== quote.listingId) {
      problems.push(`settlement is for listing ${settled.listingId!}`);
    }

    // The event can only follow a successful consume, but reading the registry has a second
    // contract confirm the reference is globally spent and attributed to this adapter.
    const consumedBy = await publicClient.readContract({
      address: config.purchaseRefRegistry,
      abi: purchaseRefRegistryAbi,
      functionName: "consumedBy",
      args: [purchaseRef],
    });

    if (!isAddressEqual(consumedBy, config.adapter)) {
      problems.push(`purchase reference was consumed by ${consumedBy}, not the expected adapter`);
    }

    if (problems.length > 0) {
      response.status(402).json({ error: "settlement does not match the issued quote", problems });
      return;
    }

    // Paid is not the same as authorised. purchaseRef is public, so without this anyone who saw
    // the settlement event could take both the content and the redemption credential.
    const authFailure = await authenticateBuyer(
      proofHeader,
      purchaseRef,
      resource,
      settled.buyer!,
    );

    if (authFailure) {
      response.status(401).json({
        error: "not authenticated as the buyer of this purchase",
        detail: authFailure,
      });
      return;
    }

    const entry = CATALOG[record.catalogId]!;

    response.json({
      resource: record.resource,
      content: entry.body,
      receipt: {
        receiptId: settled.receiptId!.toString(),
        purchaseRef,
        txHash: settlement.transactionHash,
        blockNumber: settlement.blockNumber.toString(),
        seller: settled.seller!,
        buyer: settled.buyer!,
        amount: settled.amount!.toString(),
      },
      // Handed over only here: after settlement, over the paid response, to the payer who funded
      // it. This is what makes the entitlement theirs to redeem. It is never in a 402 response,
      // never in a settlement request, and never in settlement calldata. Redemption later
      // publishes the bundle in its own calldata.
      entitlement: {
        listingId: quote.listingId.toString(),
        rawPurchaseRef: record.rawPurchaseRef,
        purchaseRefNonce: record.purchaseRefNonce,
      },
    });
  }

  return app;
}

export { buildPaymentPayload, CATALOG };
export { fileQuoteStore, memoryQuoteStore, type QuoteStore } from "./store.js";
export { createRedemptionApp, type RedemptionAppConfig } from "./redemption/app.js";
export { MockAgentAuthorizer, type AgentAuthorizer } from "./redemption/authorizer.js";
export { ViemRedemptionChain, type RedemptionChain } from "./redemption/chain.js";
