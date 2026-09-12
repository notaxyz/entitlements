import { createFacilitator } from "@nota/facilitator";
import {
  createResourceServer,
  fileQuoteStore,
  createRedemptionApp,
  MockAgentAuthorizer,
  ViemRedemptionChain,
} from "@nota/resource-server";
import type { AuditRecord } from "../../resource-server/src/redemption/app.js";
import { redeemWithMockAgent } from "../../resource-server/src/redemption/client.js";
import type { RedemptionInput } from "../../resource-server/src/redemption/types.js";
import {
  NOTA_RECEIPT_STORE,
  PURCHASE_REF_REGISTRY,
  USDC,
  notaChain,
  notaReceiptStoreAbi,
  purchaseRefRegistryAbi,
  eip3009Abi,
} from "@nota/x402-nota";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const CHAIN_ID = 8453;

/**
 * Deterministic throwaway keys, derived from labels so runs are reproducible.
 *
 * The stock anvil development accounts are deliberately NOT used. Those addresses carry EIP-7702
 * delegation code on Base mainnet, so on a fork they have a non-empty codesize. Both the store and
 * USDC check signatures with `SignatureChecker`, which routes any address with code to ERC-1271 --
 * so an ordinary ECDSA signature from one of them is rejected, and every settlement fails with
 * `InvalidQuoteSigner`. `assertNoCode` below keeps that from silently coming back.
 */
const KEYS = {
  relayer: keccak256(toHex("nota-x402-e2e:relayer")),
  seller: keccak256(toHex("nota-x402-e2e:seller")),
  buyer: keccak256(toHex("nota-x402-e2e:buyer")),
  /// A wallet that never pays for anything, used to prove that knowing a purchase reference is
  /// not the same as being entitled to what it bought. Needs no ETH: it only signs a message.
  intruder: keccak256(toHex("nota-x402-e2e:intruder")),
} satisfies Record<string, Hex>;

/// FiatTokenV2_2 keeps balances in `balanceAndBlacklistStates` at storage slot 9 on Base.
const USDC_BALANCE_SLOT = 9n;

export interface Fixture {
  mode?: "fork" | "live";
  paymentAmount?: bigint;
  persistBuyerBundle?: (bundle: { rawPurchaseRef: string; purchaseRefNonce: Hex }) => Promise<void>;
  rpcUrl: string;
  chainId: number;
  adapter: Address;
  listingId: bigint;
  seller: Address;
  buyer: Address;
  buyerPrivateKey: Hex;
  intruderPrivateKey: Hex;
  resourceUrl: string;
  resourceBaseUrl: string;
  facilitatorUrl: string;
  redemption: Address;
  redemptionChain: ViemRedemptionChain;
  redemptionLogs: AuditRecord[];
  relayer: Address;
  redeem(input: RedemptionInput, attacker?: boolean): Promise<Response>;
  publicClient: PublicClient;
  usdcBalance(account: Address): Promise<bigint>;
  /// Tears the resource server down and starts a fresh one on the same port and state.
  restartResourceServer(): Promise<void>;
  stop(): Promise<void>;
}

export function baseRpcUrl(): string | undefined {
  const url = process.env.BASE_RPC_URL;
  return url && url.length > 0 ? url : undefined;
}

async function waitForRpc(url: string, child: ChildProcess, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let startupError = false;
  child.on("error", () => {
    startupError = true;
  });

  while (Date.now() < deadline) {
    if (startupError || child.exitCode !== null) throw new Error("Anvil failed to start");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return;
    } catch {
      // anvil is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`anvil did not become ready at ${url}`);
}

export function listen(app: Express, port = 0): Promise<{ url: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app).listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a TCP address");
      }
      resolve({ url: `http://127.0.0.1:${address.port}`, server });
    });
    server.once("error", reject);
  });
}

/// The resource server signs its own URL into the metadata document, so it has to know its port
/// before it starts. Reserve one, release it, and bind it.
export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a TCP address");
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
    probe.once("error", reject);
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // fetch keeps connections alive, and server.close() waits for them. Without this a restart
    // hangs until the agent's idle sockets time out.
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

export async function startFixture(): Promise<Fixture> {
  const forkUrl = baseRpcUrl();
  if (!forkUrl) throw new Error("BASE_RPC_URL is not set");

  execFileSync("forge", ["build"], { cwd: REPO_ROOT, stdio: "pipe", timeout: 60_000 });
  const port = await reservePort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  const anvil: ChildProcess = spawn(
    "anvil",
    ["--fork-url", forkUrl, "--port", String(port), "--silent", "--chain-id", String(CHAIN_ID)],
    { stdio: "ignore" },
  );

  const services = new Set<Server>();
  let stateDir: string | undefined;
  async function start(app: Express, port = 0) {
    const service = await listen(app, port);
    services.add(service.server);
    return service;
  }
  async function stop() {
    await Promise.all([...services].map(close));
    services.clear();
    if (anvil.exitCode === null && anvil.signalCode === null && anvil.pid) {
      const exited = new Promise<void>((resolve) => anvil.once("exit", () => resolve()));
      anvil.kill();
      await exited;
    }
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
  }

  try {
    await waitForRpc(rpcUrl, anvil);

    const chain = notaChain(CHAIN_ID, rpcUrl);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const relayer = privateKeyToAccount(KEYS.relayer);
    const seller = privateKeyToAccount(KEYS.seller);
    const buyer = privateKeyToAccount(KEYS.buyer);

    const deployer = createWalletClient({ account: relayer, chain, transport: http(rpcUrl) });
    const sellerWallet = createWalletClient({ account: seller, chain, transport: http(rpcUrl) });

    // A signer with code is checked through ERC-1271 rather than ECDSA, which an ordinary key
    // cannot satisfy. Fail here with the reason rather than deep inside a reverted settlement.
    for (const [role, address] of [
      ["seller", seller.address],
      ["buyer", buyer.address],
    ] as const) {
      const code = await publicClient.getCode({ address });
      if (code && code !== "0x") {
        throw new Error(
          `${role} ${address} has code on this fork (${code.slice(0, 12)}...). ECDSA signatures ` +
            "from it are checked via ERC-1271 and will be rejected; use a key with no code.",
        );
      }
    }

    // The relayer pays gas; the seller pays gas to create its listing. The buyer gets nothing:
    // needing no ETH is the property this whole path exists to demonstrate.
    for (const address of [relayer.address, seller.address]) {
      await publicClient.request({
        method: "anvil_setBalance" as never,
        params: [address, toHex(100n * 10n ** 18n)] as never,
      });
    }

    // Deploy the adapter from the Foundry artifact, so the exact compiled contract under test in
    // the Solidity suites is the one this HTTP path settles through.
    const artifactPath = path.join(REPO_ROOT, "out/NotaX402Settlement.sol/NotaX402Settlement.json");
    let artifact: { abi: unknown[]; bytecode: { object: Hex } };
    try {
      artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    } catch {
      throw new Error(`missing ${artifactPath}; run \`forge build\` first`);
    }

    const deployHash = await deployer.deployContract({
      abi: artifact.abi as never,
      bytecode: artifact.bytecode.object,
      args: [NOTA_RECEIPT_STORE],
    });
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    const adapter = deployReceipt.contractAddress as Address;
    if (deployReceipt.status !== "success" || !adapter)
      throw new Error("Adapter deployment failed");

    const redemptionArtifact = JSON.parse(
      await readFile(
        path.join(REPO_ROOT, "out/EntitlementRedemption.sol/EntitlementRedemption.json"),
        "utf8",
      ),
    ) as typeof artifact;
    const redemptionDeployment = await publicClient.waitForTransactionReceipt({
      hash: await deployer.deployContract({
        abi: redemptionArtifact.abi as never,
        bytecode: redemptionArtifact.bytecode.object,
        args: [NOTA_RECEIPT_STORE, [adapter]],
      }),
    });
    const redemption = redemptionDeployment.contractAddress;
    if (redemptionDeployment.status !== "success" || !redemption)
      throw new Error("Redemption deployment failed");

    // The post-deploy step the adapter cannot perform for itself: the registry owner authorizes it
    // as a consumer. Without this every settlement reverts with UnauthorizedConsumer.
    const registryOwner = await publicClient.readContract({
      address: PURCHASE_REF_REGISTRY,
      abi: purchaseRefRegistryAbi,
      functionName: "owner",
    });

    await publicClient.request({
      method: "anvil_impersonateAccount" as never,
      params: [registryOwner] as never,
    });
    await publicClient.request({
      method: "anvil_setBalance" as never,
      params: [registryOwner, toHex(10n ** 18n)] as never,
    });

    const ownerWallet = createWalletClient({ chain, transport: http(rpcUrl) });
    const authorizeHash = await ownerWallet.writeContract({
      account: registryOwner,
      address: PURCHASE_REF_REGISTRY,
      abi: purchaseRefRegistryAbi,
      functionName: "setConsumerAuthorization",
      args: [adapter, true],
    });
    await publicClient.waitForTransactionReceipt({ hash: authorizeHash });
    await publicClient.request({
      method: "anvil_stopImpersonatingAccount" as never,
      params: [registryOwner] as never,
    });

    const listingHash = keccak256(toHex("nota-x402-e2e-listing"));

    // createListing assigns nextListingId and then increments it, so the id it will hand out is
    // whatever the counter reads beforehand.
    const listingId = await publicClient.readContract({
      address: NOTA_RECEIPT_STORE,
      abi: notaReceiptStoreAbi,
      functionName: "nextListingId",
    });

    const createHash = await sellerWallet.writeContract({
      address: NOTA_RECEIPT_STORE,
      abi: notaReceiptStoreAbi,
      functionName: "createListing",
      args: [listingHash, 0n, 1],
    });
    await publicClient.waitForTransactionReceipt({ hash: createHash });

    const listing = await publicClient.readContract({
      address: NOTA_RECEIPT_STORE,
      abi: notaReceiptStoreAbi,
      functionName: "getListing",
      args: [listingId],
    });

    if (listing.seller.toLowerCase() !== seller.address.toLowerCase()) {
      throw new Error(`listing ${listingId} is not owned by the test seller`);
    }

    // Fund the buyer with USDC by writing the balance slot directly.
    const balanceSlot = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [buyer.address, USDC_BALANCE_SLOT],
      ),
    );
    await publicClient.request({
      method: "anvil_setStorageAt" as never,
      params: [USDC, balanceSlot, pad(toHex(1_000_000_000n))] as never,
    });

    const facilitatorApp = createFacilitator({
      rpcUrl,
      chainId: CHAIN_ID,
      privateKey: KEYS.relayer,
      allowedAdapters: [adapter],
    });
    const facilitator = await start(facilitatorApp);

    const resourcePortNumber = await reservePort();
    const resourceBaseUrl = `http://127.0.0.1:${resourcePortNumber}`;
    stateDir = await mkdtemp(path.join(tmpdir(), "nota-x402-"));
    const quoteStorePath = path.join(stateDir, "issued-quotes.json");

    const resourceConfig = {
      rpcUrl,
      chainId: CHAIN_ID,
      store: NOTA_RECEIPT_STORE,
      settlementToken: USDC,
      purchaseRefRegistry: PURCHASE_REF_REGISTRY,
      adapter,
      facilitatorUrl: facilitator.url,
      sellerPrivateKey: KEYS.seller,
      listingId,
      baseUrl: resourceBaseUrl,
      fromBlock: deployReceipt.blockNumber,
    };

    // File-backed, so a restart in the middle of the suite behaves the way a restart in production
    // would rather than quietly passing on in-process state.
    let resource = await start(
      createResourceServer({ ...resourceConfig, quoteStore: fileQuoteStore(quoteStorePath) }),
      resourcePortNumber,
    );

    const redemptionChain = await ViemRedemptionChain.connect({
      rpcUrl,
      store: NOTA_RECEIPT_STORE,
      redemption,
      adapters: [adapter],
      sellerPrivateKey: KEYS.seller,
      confirmations: 1,
    });
    const redemptionPort = await reservePort();
    const redemptionBaseUrl = `http://127.0.0.1:${redemptionPort}`;
    const authorizer = new MockAgentAuthorizer({
      resource: `${redemptionBaseUrl}/v1/redemptions`,
      chainId: CHAIN_ID,
      redemptionContract: redemption,
    });
    const redemptionLogs: AuditRecord[] = [];
    await start(
      createRedemptionApp({
        authorizer,
        mockChallenges: authorizer,
        chain: redemptionChain,
        // Independent store instance, reading orders committed by the resource service.
        quoteStore: fileQuoteStore(quoteStorePath),
        logger: (record) => redemptionLogs.push(record),
      }),
      redemptionPort,
    );

    return {
      rpcUrl,
      chainId: CHAIN_ID,
      adapter,
      listingId,
      seller: seller.address,
      buyer: buyer.address,
      buyerPrivateKey: KEYS.buyer,
      intruderPrivateKey: KEYS.intruder,
      resourceBaseUrl,
      resourceUrl: `${resourceBaseUrl}/reports/base-usdc-flows-2026-09`,
      facilitatorUrl: facilitator.url,
      redemption,
      redemptionChain,
      redemptionLogs,
      relayer: relayer.address,
      redeem: (input, attacker = false) =>
        redeemWithMockAgent(
          redemptionBaseUrl,
          privateKeyToAccount(attacker ? KEYS.intruder : KEYS.buyer),
          input,
          { chainId: CHAIN_ID, redemptionContract: redemption },
        ),
      publicClient: publicClient as PublicClient,
      async usdcBalance(account: Address) {
        return publicClient.readContract({
          address: USDC,
          abi: eip3009Abi,
          functionName: "balanceOf",
          args: [account],
        });
      },
      async restartResourceServer() {
        await close(resource.server);
        services.delete(resource.server);
        resource = await start(
          createResourceServer({ ...resourceConfig, quoteStore: fileQuoteStore(quoteStorePath) }),
          resourcePortNumber,
        );

        // fetch pools keep-alive sockets per origin, and the ones pointing at the old process are
        // now dead. The first request through each picks one up and fails; these absorb that so the
        // test exercises the restart rather than a stale socket.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const ok = await fetch(`${resourceBaseUrl}/health`).then(
            (response) => response.ok,
            () => false,
          );
          if (ok) return;
        }

        throw new Error("resource server did not come back after restart");
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
