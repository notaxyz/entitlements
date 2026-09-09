import {
  authorizationFromWire,
  deriveAuthorizationNonce,
  notaChain,
  notaReceiptStoreAbi,
  notaX402SettlementAbi,
  quoteFromWire,
  type SettlementRequest,
  type SettlementResponse,
} from "@nota/x402-nota";
import express, { type Express, type Request, type Response } from "express";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface FacilitatorConfig {
  rpcUrl: string;
  chainId: number;
  /// Key that pays the gas. The buyer never sends a transaction and needs no ETH.
  privateKey: Hex;
  /**
   * Adapters this facilitator will submit to. This is a Nota-aware relayer, not a general
   * transaction service: without an allowlist it would relay calls to any contract that happened
   * to expose a matching selector.
   */
  allowedAdapters: Address[];
}

class SettlementRejected extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("; "));
    this.name = "SettlementRejected";
    this.problems = problems;
  }
}

export function createFacilitator(config: FacilitatorConfig): Express {
  const chain = notaChain(config.chainId, config.rpcUrl);
  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(config.rpcUrl) });

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_request: Request, response: Response) => {
    response.json({
      ok: true,
      relayer: account.address,
      chainId: config.chainId,
      allowedAdapters: config.allowedAdapters,
    });
  });

  app.post("/settle", async (request: Request, response: Response) => {
    try {
      const body = request.body as SettlementRequest;
      const result = await settle(body);
      response.json(result);
    } catch (error) {
      if (error instanceof SettlementRejected) {
        response.status(400).json({ error: "settlement rejected", problems: error.problems });
        return;
      }

      response.status(502).json({
        error: "settlement failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  async function settle(body: SettlementRequest): Promise<SettlementResponse> {
    const quote = quoteFromWire(body.quote);
    const authorization = authorizationFromWire(body.authorization);
    const problems: string[] = [];

    if (!config.allowedAdapters.some((adapter) => isAddressEqual(adapter, body.adapter))) {
      problems.push(`${body.adapter} is not an adapter this facilitator settles through`);
    }

    // The adapter enforces all three on-chain. Checking them here turns a reverted transaction
    // the relayer paid for into a free 400.
    if (!isAddressEqual(authorization.to, body.adapter)) {
      problems.push(`authorization pays ${authorization.to}, not the adapter ${body.adapter}`);
    }
    if (!isAddressEqual(authorization.from, quote.buyer)) {
      problems.push(`authorization payer ${authorization.from} is not the quote buyer ${quote.buyer}`);
    }
    if (authorization.value !== quote.amount) {
      problems.push(`authorization value ${authorization.value} is not the quote amount ${quote.amount}`);
    }

    if (problems.length > 0) throw new SettlementRejected(problems);

    // The adapter re-derives this and rejects a mismatch. Checking it here first turns the most
    // likely caller mistake into a free 400 with the expected nonce in it, rather than a revert
    // the relayer paid for.
    const storeAddress = await publicClient.readContract({
      address: body.adapter,
      abi: notaX402SettlementAbi,
      functionName: "STORE",
    });
    const digest = await publicClient.readContract({
      address: storeAddress,
      abi: notaReceiptStoreAbi,
      functionName: "hashSignedReceiptQuote",
      args: [quote],
    });
    const expectedNonce = deriveAuthorizationNonce(digest, body.paymentSalt);

    if (authorization.nonce !== expectedNonce) {
      throw new SettlementRejected([
        `authorization nonce ${authorization.nonce} is not bound to this quote (expected ${expectedNonce})`,
      ]);
    }

    const args = [
      quote,
      body.sellerSignature,
      body.claimedSigner,
      authorization,
      body.buyerSignature,
      body.paymentSalt,
    ] as const;

    // Simulating first means a quote the chain would reject costs the relayer nothing and comes
    // back to the agent as a readable error rather than a failed transaction.
    const { request: simulated } = await publicClient.simulateContract({
      account,
      address: body.adapter,
      abi: notaX402SettlementAbi,
      functionName: "settleWithAuthorization",
      args,
    });

    const txHash = await walletClient.writeContract(simulated);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== "success") {
      throw new Error(`settlement transaction ${txHash} reverted`);
    }

    for (const log of receipt.logs) {
      if (!isAddressEqual(log.address, body.adapter)) continue;

      try {
        const event = decodeEventLog({
          abi: notaX402SettlementAbi,
          data: log.data,
          topics: log.topics,
        });

        if (event.eventName !== "X402ReceiptSettled") continue;

        return {
          txHash,
          blockNumber: receipt.blockNumber.toString(),
          receiptId: event.args.receiptId.toString(),
          purchaseRef: event.args.purchaseRef,
          listingId: event.args.listingId.toString(),
          seller: event.args.seller,
          buyer: event.args.buyer,
          amount: event.args.amount.toString(),
        };
      } catch {
        // Not an event from this ABI; keep looking.
      }
    }

    throw new Error(`settlement ${txHash} emitted no X402ReceiptSettled event`);
  }

  return app;
}
