import {
  notaChain,
  notaReceiptStoreAbi,
  notaX402SettlementAbi,
  purchaseRefRegistryAbi,
  x402ReceiptSettledEvent,
} from "@nota/x402-nota";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  isAddressEqual,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { receiptPurchasedV2Event, redemptionAbi } from "./abi.js";
import {
  RedemptionError,
  requireAddress,
  type RedemptionInput,
} from "./types.js";

export interface Settlement {
  emitter: Address;
  kind: "ReceiptPurchasedV2" | "X402ReceiptSettled";
  purchaseRef: Hex;
  listingId: bigint;
  seller: Address;
  buyer: Address;
}

export interface RedemptionResult {
  transactionHash: Hex;
  purchaseRef: Hex;
  seller: Address;
  redeemedAt: string;
}

export interface RedemptionChain {
  seller: Address;
  settlements(txHash: Hex): Promise<Settlement[]>;
  reconstruct(input: RedemptionInput): Promise<Hex>;
  consumedBy(purchaseRef: Hex): Promise<Address>;
  redeemedAt(purchaseRef: Hex): Promise<bigint>;
  submit(input: RedemptionInput, purchaseRef: Hex): Promise<RedemptionResult>;
}

interface ReceiptLog {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
}

/** Emitter allowlist is trusted configuration, never an address from the request. */
export function decodeSettlements(
  logs: readonly ReceiptLog[],
  store: Address,
  adapters: readonly Address[],
): Settlement[] {
  const result: Settlement[] = [];
  for (const log of logs) {
    const kind = isAddressEqual(log.address, store)
      ? "ReceiptPurchasedV2"
      : adapters.some((adapter) => isAddressEqual(log.address, adapter))
        ? "X402ReceiptSettled"
        : undefined;
    if (!kind) continue;
    try {
      const decoded = decodeEventLog({
        abi: [
          kind === "ReceiptPurchasedV2"
            ? receiptPurchasedV2Event
            : x402ReceiptSettledEvent,
        ],
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
        strict: true,
      });
      result.push({
        kind,
        emitter: log.address,
        purchaseRef: decoded.args.purchaseRef,
        listingId: decoded.args.listingId,
        seller: decoded.args.seller,
        buyer: decoded.args.buyer,
      });
    } catch {
      /* Other events or malformed data cannot count as a Nota settlement. */
    }
  }
  return result;
}

export interface ViemRedemptionConfig {
  rpcUrl: string;
  store: Address;
  redemption: Address;
  adapters: Address[];
  sellerPrivateKey: Hex;
  confirmations?: number;
}

/** Construct through connect(): validates deployment wiring before accepting requests. */
export class ViemRedemptionChain implements RedemptionChain {
  readonly seller: Address;
  private readonly publicClient;
  private readonly walletClient;
  private registry!: Address;
  private readonly confirmations: number;
  private submissionUncertain = false;

  private constructor(private config: ViemRedemptionConfig) {
    requireAddress(config.store);
    requireAddress(config.redemption);
    config.adapters.forEach(requireAddress);
    this.confirmations = config.confirmations ?? 2;
    if (!Number.isSafeInteger(this.confirmations) || this.confirmations < 1)
      throw new Error("Invalid confirmations");
    const chain = notaChain(8453, config.rpcUrl);
    const account = privateKeyToAccount(config.sellerPrivateKey);
    this.seller = account.address;
    this.publicClient = createPublicClient({
      chain,
      transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 0 }),
    });
    this.walletClient = createWalletClient({
      account,
      chain,
      transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 0 }),
    });
  }

  static async connect(
    config: ViemRedemptionConfig,
  ): Promise<ViemRedemptionChain> {
    const chain = new ViemRedemptionChain(config);
    await chain.validateDeployment();
    return chain;
  }

  private async validateDeployment() {
    if ((await this.publicClient.getChainId()) !== 8453)
      throw new Error("Redemption requires Base chain ID 8453");
    for (const address of [
      this.config.store,
      this.config.redemption,
      ...this.config.adapters,
    ]) {
      const code = await this.publicClient.getCode({ address });
      if (!code || code === "0x")
        throw new Error("Missing configured contract code");
    }
    this.registry = await this.publicClient.readContract({
      address: this.config.store,
      abi: notaReceiptStoreAbi,
      functionName: "PURCHASE_REF_REGISTRY",
    });
    requireAddress(this.registry);
    const registryCode = await this.publicClient.getCode({
      address: this.registry,
    });
    if (!registryCode || registryCode === "0x")
      throw new Error("Missing registry contract code");
    const redemptionStore = await this.publicClient.readContract({
      address: this.config.redemption,
      abi: redemptionAbi,
      functionName: "STORE",
    });
    const redemptionRegistry = await this.publicClient.readContract({
      address: this.config.redemption,
      abi: redemptionAbi,
      functionName: "PURCHASE_REF_REGISTRY",
    });
    if (
      !isAddressEqual(redemptionStore, this.config.store) ||
      !isAddressEqual(redemptionRegistry, this.registry)
    ) {
      throw new Error("Redemption deployment wiring mismatch");
    }
    for (const consumer of [this.config.store, ...this.config.adapters]) {
      if (
        !(await this.publicClient.readContract({
          address: this.config.redemption,
          abi: redemptionAbi,
          functionName: "isAcceptedConsumer",
          args: [consumer],
        }))
      )
        throw new Error(
          "Settlement consumer not accepted by redemption deployment",
        );
    }
    for (const address of this.config.adapters) {
      const store = await this.publicClient.readContract({
        address,
        abi: notaX402SettlementAbi,
        functionName: "STORE",
      });
      const registry = await this.publicClient.readContract({
        address,
        abi: notaX402SettlementAbi,
        functionName: "PURCHASE_REF_REGISTRY",
      });
      const token = await this.publicClient.readContract({
        address,
        abi: notaX402SettlementAbi,
        functionName: "SETTLEMENT_TOKEN",
      });
      const storeToken = await this.publicClient.readContract({
        address: this.config.store,
        abi: notaReceiptStoreAbi,
        functionName: "SETTLEMENT_TOKEN",
      });
      if (
        !isAddressEqual(store, this.config.store) ||
        !isAddressEqual(registry, this.registry) ||
        !isAddressEqual(token, storeToken)
      ) {
        throw new Error("Adapter deployment wiring mismatch");
      }
    }
  }

  async settlements(txHash: Hex): Promise<Settlement[]> {
    let receipt;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) {
        throw new RedemptionError(
          "PURCHASE_NOT_MINED",
          2,
          409,
          "Purchase transaction is missing or pending",
        );
      }
      throw error;
    }
    if (receipt.status !== "success")
      throw new RedemptionError(
        "PURCHASE_REVERTED",
        2,
        422,
        "Purchase transaction reverted",
      );
    const head = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const block = await this.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (
      block.hash !== receipt.blockHash ||
      head < receipt.blockNumber + BigInt(this.confirmations - 1)
    ) {
      throw new RedemptionError(
        "PURCHASE_UNCONFIRMED",
        2,
        409,
        "Purchase needs more confirmations or was reorganized",
      );
    }
    const settlements = decodeSettlements(
      receipt.logs,
      this.config.store,
      this.config.adapters,
    );
    if (!settlements.length)
      throw new RedemptionError(
        "NO_NOTA_SETTLEMENT",
        2,
        422,
        "No trusted Nota settlement in this transaction",
      );
    return settlements;
  }

  async reconstruct(input: RedemptionInput): Promise<Hex> {
    // hashPurchaseRef itself checks listing existence and seller; never duplicate its preimage.
    return this.publicClient.readContract({
      address: this.config.store,
      abi: notaReceiptStoreAbi,
      functionName: "hashPurchaseRef",
      args: [
        this.seller,
        BigInt(input.listingId),
        input.rawPurchaseRef,
        input.purchaseRefNonce,
      ],
    });
  }

  async consumedBy(purchaseRef: Hex) {
    const consumed = await this.publicClient.readContract({
      address: this.registry,
      abi: purchaseRefRegistryAbi,
      functionName: "isConsumed",
      args: [purchaseRef],
    });
    if (!consumed)
      throw new RedemptionError(
        "REFERENCE_UNCONSUMED",
        4,
        422,
        "Purchase reference has not been consumed",
      );
    return this.publicClient.readContract({
      address: this.registry,
      abi: purchaseRefRegistryAbi,
      functionName: "consumedBy",
      args: [purchaseRef],
    });
  }

  async redeemedAt(purchaseRef: Hex) {
    return this.publicClient.readContract({
      address: this.config.redemption,
      abi: redemptionAbi,
      functionName: "redeemedAt",
      args: [purchaseRef],
    });
  }

  async submit(
    input: RedemptionInput,
    purchaseRef: Hex,
  ): Promise<RedemptionResult> {
    if (this.submissionUncertain)
      throw new RedemptionError(
        "SELLER_RECONCILIATION_REQUIRED",
        7,
        503,
        "Seller submission is paused until an uncertain transaction is reconciled",
      );
    const { request } = await this.publicClient.simulateContract({
      account: this.walletClient.account,
      address: this.config.redemption,
      abi: redemptionAbi,
      functionName: "redeemEntitlement",
      args: [
        BigInt(input.listingId),
        input.rawPurchaseRef,
        input.purchaseRefNonce,
      ],
    });
    // A send timeout can hide a successful broadcast. Fail closed across later submissions;
    // do not retry blindly and spend more seller gas. Operator reconciliation is required.
    this.submissionUncertain = true;
    let hash: Hex;
    let receipt;
    try {
      hash = await this.walletClient.writeContract(request);
      receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        confirmations: this.confirmations,
        timeout: 45_000,
      });
    } catch {
      throw new RedemptionError(
        "SUBMISSION_UNCERTAIN",
        7,
        503,
        "Submission outcome is uncertain; seller reconciliation required",
      );
    }
    if (receipt.status !== "success") {
      this.submissionUncertain = false;
      throw new RedemptionError(
        "REDEMPTION_REVERTED",
        7,
        409,
        "Redemption transaction reverted",
      );
    }
    for (const log of receipt.logs) {
      if (!isAddressEqual(log.address, this.config.redemption)) continue;
      try {
        const event = decodeEventLog({
          abi: redemptionAbi,
          eventName: "EntitlementRedeemed",
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (
          event.args.purchaseRef !== purchaseRef ||
          !isAddressEqual(event.args.seller, this.seller) ||
          event.args.redeemedAt === 0n
        )
          continue;
        this.submissionUncertain = false;
        return {
          transactionHash: receipt.transactionHash,
          purchaseRef,
          seller: this.seller,
          redeemedAt: event.args.redeemedAt.toString(),
        };
      } catch {
        /* Success requires the matching event, not merely a successful transaction. */
      }
    }
    throw new RedemptionError(
      "REDEMPTION_EVENT_MISSING",
      7,
      502,
      "Confirmed transaction lacks the expected redemption event; reconcile before restarting",
    );
  }
}
