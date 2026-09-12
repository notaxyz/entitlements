import { createFacilitator } from "@nota/facilitator";
import {
  createResourceServer,
  fileQuoteStore,
  createRedemptionApp,
  MockAgentAuthorizer,
  ViemRedemptionChain,
} from "@nota/resource-server";
import {
  eip3009Abi,
  notaChain,
  notaReceiptStoreAbi,
  NOTA_RECEIPT_STORE,
  PURCHASE_REF_REGISTRY,
  USDC,
} from "@nota/x402-nota";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  isAddressEqual,
  keccak256,
  parseAbiItem,
  toHex,
  type Hex,
  type Address,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import type { Express } from "express";
import type { AuditRecord } from "../../resource-server/src/redemption/app.js";
import { redeemWithMockAgent } from "../../resource-server/src/redemption/client.js";
import {
  deployed,
  verifyDeployments,
} from "../../subgraph/checks/deployments.js";
import { close, listen, reservePort, type Fixture } from "./fixture.js";
import { LiveConfigError, type LiveConfig } from "./live-config.js";

// Verified against the deployed store ABI on Basescan, 2026-09-12.
export const listingCreatedEvent = parseAbiItem(
  "event ListingCreated(uint256 indexed listingId, address indexed seller, bytes32 indexed listingHash, uint256 unitPrice, uint8 mode)",
);
export type LiveTransactionKind = "listing" | "settlement" | "redemption";

export interface LiveFixture extends Fixture {
  mode: "live";
  listingTransactionHash: Hex;
  listingHash: Hex;
  stateDir: string;
}

/**
 * Read-only checks shared by the live run and `demo:preflight`: sends no transactions, writes no files.
 * Every failure is a fixed, credential-free LiveConfigError; RPC errors propagate unchanged.
 */
export async function preflightLive(config: LiveConfig) {
  const rpcUrl = config.rpcUrl;
  const chain = notaChain(8453, rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { retryCount: 0, timeout: 20_000 }),
  });
  if (existsSync(config.stateDir))
    throw new LiveConfigError(
      "LIVE_DEMO_STATE_DIR already exists; every live run needs a new directory",
    );
  if ((await publicClient.getChainId()) !== 8453)
    throw new LiveConfigError("BASE_RPC_URL is not a Base mainnet (8453) RPC");
  // The client trust configuration also pins these baseline addresses. Never silently mix deployments.
  if (
    !isAddressEqual(deployed.store, NOTA_RECEIPT_STORE) ||
    !isAddressEqual(deployed.registry, PURCHASE_REF_REGISTRY) ||
    !isAddressEqual(deployed.token, USDC)
  )
    throw new LiveConfigError("BASELINE_MANIFEST_MISMATCH");
  try {
    await verifyDeployments(publicClient, await publicClient.getBlockNumber());
  } catch (error) {
    // verifyDeployments throws fixed codes (e.g. DEPLOYMENT_CODE_MISMATCH); anything else is an RPC error.
    if (error instanceof Error && /^[A-Z_]+$/.test(error.message))
      throw new LiveConfigError(
        `Deployment verification failed: ${error.message}`,
      );
    throw error;
  }
  const roles = [
    ["seller", config.seller],
    ["buyer", config.buyer],
    ["relayer", config.relayer],
  ] as const;
  for (const [role, address] of roles) {
    const code = await publicClient.getCode({ address });
    if (code && code !== "0x")
      throw new LiveConfigError(
        `The ${role} wallet has contract code or an EIP-7702 delegation; use a plain EOA`,
      );
    const latest = await publicClient.getTransactionCount({
      address,
      blockTag: "latest",
    });
    const pending = await publicClient.getTransactionCount({
      address,
      blockTag: "pending",
    });
    if (latest !== pending)
      throw new LiveConfigError(
        `The ${role} wallet has pending transactions; wait for or reconcile them before running the demo`,
      );
  }
  for (const [role, address] of roles) {
    if (role === "buyer") continue;
    if ((await publicClient.getBalance({ address })) === 0n)
      throw new LiveConfigError(
        `The ${role} wallet has no Base ETH for gas`,
      );
  }
  const usdcBalance = (address: Address) =>
    publicClient.readContract({
      address: deployed.token,
      abi: eip3009Abi,
      functionName: "balanceOf",
      args: [address],
    });
  if ((await usdcBalance(config.buyer)) < config.amount)
    throw new LiveConfigError(
      "The buyer wallet holds less Base USDC than LIVE_DEMO_USDC_AMOUNT",
    );
  if (
    await publicClient.readContract({
      address: deployed.store,
      abi: notaReceiptStoreAbi,
      functionName: "purchasesPaused",
    })
  )
    throw new LiveConfigError("Nota store purchases are paused on-chain");
  return { chain, publicClient, usdcBalance };
}

/** Only call after the CLI has received explicit interactive confirmation. No deployments or funding tricks. */
export async function startLiveFixture(
  config: LiveConfig,
  onTransaction: (kind: LiveTransactionKind, hash: Hex) => void,
): Promise<LiveFixture> {
  const rpcUrl = config.rpcUrl;
  const { chain, publicClient, usdcBalance } = await preflightLive(config);

  // Never reuse a prior live run's directory. Preserve it on success AND failure for reconciliation.
  await mkdir(path.dirname(config.stateDir), { recursive: true, mode: 0o700 });
  await mkdir(config.stateDir, { mode: 0o700 });
  const save = (name: string, value: unknown) =>
    writeFile(
      path.join(config.stateDir, name),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  await save("run.json", {
    status: "started",
    chainId: 8453,
    seller: config.seller,
    buyer: config.buyer,
    relayer: config.relayer,
    amount: config.amount.toString(),
    adapter: deployed.adapter,
    redemption: deployed.redemption,
  });

  const services = new Set<Server>();
  const start = async (app: Express, port = 0) => {
    const service = await listen(app, port);
    services.add(service.server);
    return service;
  };
  const stop = async () => {
    await Promise.all([...services].map(close));
    services.clear();
  };
  try {
    // Validate redemption configuration and bind local sockets before creating a paid on-chain listing.
    const redemptionChain = await ViemRedemptionChain.connect({
      rpcUrl,
      store: deployed.store,
      redemption: deployed.redemption,
      adapters: [deployed.adapter],
      sellerPrivateKey: config.sellerKey,
      confirmations: 2,
      onTransactionSubmitted: (hash) => onTransaction("redemption", hash),
    });
    const facilitator = await start(
      createFacilitator({
        rpcUrl,
        chainId: 8453,
        privateKey: config.relayerKey,
        allowedAdapters: [deployed.adapter],
        confirmations: 2,
        onTransactionSubmitted: (hash) => onTransaction("settlement", hash),
      }),
    );
    const resourcePort = await reservePort();
    const resourceBaseUrl = `http://127.0.0.1:${resourcePort}`;
    const redemptionPort = await reservePort();
    const redemptionBaseUrl = `http://127.0.0.1:${redemptionPort}`;

    const sellerWallet = createWalletClient({
      account: privateKeyToAccount(config.sellerKey),
      chain,
      transport: http(rpcUrl, { retryCount: 0 }),
    });
    const listingHash = keccak256(toHex(randomBytes(32)));
    const simulated = await publicClient.simulateContract({
      account: sellerWallet.account,
      address: deployed.store,
      abi: notaReceiptStoreAbi,
      functionName: "createListing",
      args: [listingHash, 0n, 1],
    });
    const listingTransactionHash = await sellerWallet.writeContract(
      simulated.request,
    );
    onTransaction("listing", listingTransactionHash);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: listingTransactionHash,
      confirmations: 2,
      timeout: 120_000,
    });
    if (receipt.status !== "success")
      throw new Error("LISTING_CREATION_REVERTED");
    // The global nextListingId may change between simulation and mining. Use our mined event.
    const listingId = listingIdFromReceipt(
      receipt.logs,
      config.seller,
      listingHash,
    );
    const listing = await publicClient.readContract({
      address: deployed.store,
      abi: notaReceiptStoreAbi,
      functionName: "getListing",
      args: [listingId],
    });
    if (
      !isAddressEqual(listing.seller, config.seller) ||
      listing.listingHash !== listingHash ||
      !listing.active ||
      listing.mode !== 1
    )
      throw new Error("LISTING_MISMATCH");
    await save("listing.json", {
      listingId: listingId.toString(),
      listingHash,
      transactionHash: listingTransactionHash,
      resourceBaseUrl,
      redemptionBaseUrl,
    });

    const quotePath = path.join(config.stateDir, "issued-orders.json");
    const id = "base-usdc-flows-2026-09";
    const resourceConfig = {
      rpcUrl,
      chainId: 8453,
      store: deployed.store,
      settlementToken: deployed.token,
      purchaseRefRegistry: deployed.registry,
      adapter: deployed.adapter,
      facilitatorUrl: facilitator.url,
      sellerPrivateKey: config.sellerKey,
      listingId,
      baseUrl: resourceBaseUrl,
      // This new order cannot precede its listing; avoid an unnecessary historical log scan.
      fromBlock: receipt.blockNumber,
      catalog: {
        [id]: {
          id,
          description: "Nota connected demo report (illustrative content)",
          amount: config.amount,
          items: [
            {
              sku: id,
              name: "Demo report",
              quantity: 1,
              unitAmount: config.amount.toString(),
            },
          ],
          body: {
            report: id,
            note: "Illustrative demo content, not live financial data",
          },
        },
      },
    };
    let resource = await start(
      createResourceServer({
        ...resourceConfig,
        quoteStore: fileQuoteStore(quotePath),
      }),
      resourcePort,
    );
    const authorizer = new MockAgentAuthorizer({
      resource: `${redemptionBaseUrl}/v1/redemptions`,
      chainId: 8453,
      redemptionContract: deployed.redemption,
    });
    const redemptionLogs: AuditRecord[] = [];
    await start(
      createRedemptionApp({
        authorizer,
        mockChallenges: authorizer,
        chain: redemptionChain,
        quoteStore: fileQuoteStore(quotePath),
        logger: (record) => redemptionLogs.push(record),
      }),
      redemptionPort,
    );
    const intruderPrivateKey = generatePrivateKey();
    return {
      mode: "live",
      rpcUrl,
      chainId: 8453,
      adapter: deployed.adapter,
      redemption: deployed.redemption,
      listingId,
      listingHash,
      listingTransactionHash,
      seller: config.seller,
      buyer: config.buyer,
      relayer: config.relayer,
      buyerPrivateKey: config.buyerKey,
      intruderPrivateKey,
      paymentAmount: config.amount,
      stateDir: config.stateDir,
      publicClient: publicClient as PublicClient,
      usdcBalance,
      resourceBaseUrl,
      resourceUrl: `${resourceBaseUrl}/reports/${id}`,
      facilitatorUrl: facilitator.url,
      redemptionChain,
      redemptionLogs,
      persistBuyerBundle: (bundle) => save("buyer-bundle.json", bundle),
      redeem: (input, attacker = false) =>
        redeemWithMockAgent(
          redemptionBaseUrl,
          privateKeyToAccount(attacker ? intruderPrivateKey : config.buyerKey),
          input,
          { chainId: 8453, redemptionContract: deployed.redemption },
        ),
      async restartResourceServer() {
        await close(resource.server);
        services.delete(resource.server);
        resource = await start(
          createResourceServer({
            ...resourceConfig,
            quoteStore: fileQuoteStore(quotePath),
          }),
          resourcePort,
        );
        for (let attempt = 0; attempt < 5; attempt++) {
          if (
            await fetch(`${resourceBaseUrl}/health`).then(
              (r) => r.ok,
              () => false,
            )
          )
            return;
        }
        throw new Error("RESOURCE_RESTART_FAILED");
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function listingIdFromReceipt(
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
  seller: Address,
  listingHash: Hex,
): bigint {
  const matches: bigint[] = [];
  for (const log of logs) {
    if (!isAddressEqual(log.address, deployed.store)) continue;
    try {
      const event = decodeEventLog({
        abi: [listingCreatedEvent],
        data: log.data,
        topics: [...log.topics] as [Hex, ...Hex[]],
        strict: true,
      });
      if (
        isAddressEqual(event.args.seller, seller) &&
        event.args.listingHash === listingHash &&
        event.args.mode === 1 &&
        event.args.unitPrice === 0n
      )
        matches.push(event.args.listingId);
    } catch {
      /* unrelated log */
    }
  }
  if (matches.length !== 1)
    throw new Error("LISTING_EVENT_MISSING_OR_AMBIGUOUS");
  return matches[0]!;
}
