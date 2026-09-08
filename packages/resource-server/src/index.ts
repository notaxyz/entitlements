import {
  buildPaymentPayload,
  decodePaymentPayload,
  hashCheckoutMetadata,
  NETWORK,
  NOTA_EXTENSION_KIND,
  notaChain,
  notaReceiptStoreAbi,
  purchaseRefRegistryAbi,
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
}

/**
 * A quote this server issued, kept so a later payment can be checked against what was actually
 * offered rather than against whatever the payer echoes back.
 *
 * `purchaseRefNonce` is the redemption credential. It is generated here, it is never placed in a
 * 402 response or a settlement request, and the only channel that ever carries it is the paid
 * resource response, delivered to the payer after their settlement has been found on chain.
 */
interface IssuedQuote {
  quote: SignedReceiptQuote;
  metadata: CheckoutMetadata;
  resource: string;
  rawPurchaseRef: string;
  purchaseRefNonce: Hex;
  catalogId: string;
}

export function createResourceServer(config: ResourceServerConfig): Express {
  const chain = notaChain(config.chainId, config.rpcUrl);
  const seller = privateKeyToAccount(config.sellerPrivateKey);
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({ account: seller, chain, transport: http(config.rpcUrl) });
  const quoteTtl = config.quoteTtlSeconds ?? 900n;

  const issued = new Map<Hex, IssuedQuote>();

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_request: Request, response: Response) => {
    response.json({ ok: true, seller: seller.address, listingId: config.listingId.toString() });
  });

  app.get("/reports/:id", async (request: Request, response: Response) => {
    const entry = CATALOG[request.params.id ?? ""];

    if (!entry) {
      response.status(404).json({ error: "no such report" });
      return;
    }

    const resource = `${config.baseUrl}/reports/${entry.id}`;
    const paymentHeader = request.header("x-payment");

    if (paymentHeader) {
      await serveIfPaid(paymentHeader, resource, response);
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
    } catch (error) {
      response.status(500).json({
        error: "could not issue a quote",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  function acceptsBlock(resource: string, description: string, amount: bigint) {
    return {
      scheme: "exact" as const,
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

    // The entitlement bundle. Both halves stay on this server: the raw reference is not secret,
    // but purchaseRefNonce is what makes the on-chain purchaseRef unguessable, and only its hash
    // ever goes on chain or into a payload.
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

    issued.set(purchaseRef, {
      quote,
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
   * Payment is established from chain state alone. The payload names a purchaseRef; everything
   * that decides whether the resource is served comes from the settlement event and the registry.
   * The transaction hash the client may include is used for logging and nothing else.
   */
  async function serveIfPaid(paymentHeader: string, resource: string, response: Response) {
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

    const record = issued.get(purchaseRef);

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

    const { quote } = record;
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
      // never in a settlement request, and never in calldata.
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
