import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  notaChain,
  notaReceiptStoreAbi,
  notaX402SettlementAbi,
  purchaseRefRegistryAbi,
  receiveAuthorizationTypedData,
  signedQuoteTypedData,
} from "@nota/x402-nota";
import { MockAgentAuthorizer } from "../src/redemption/authorizer.js";
import {
  createRedemptionApp,
  type AuditRecord,
} from "../src/redemption/app.js";
import { ViemRedemptionChain } from "../src/redemption/chain.js";
import { redeemWithMockAgent } from "../src/redemption/client.js";
import type { RedemptionInput } from "../src/redemption/types.js";

const root = new URL("../../../", import.meta.url);
const keys = {
  buyer: keccak256(toHex("nota-day4-anvil:buyer")),
  attacker: keccak256(toHex("nota-day4-anvil:attacker")),
  seller: keccak256(toHex("nota-day4-anvil:seller")),
  relayer: keccak256(toHex("nota-day4-anvil:relayer")),
};

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  return address.port;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Local EVM only. Existing mock Nota dependencies; unchanged real adapter and redemption. */
export async function startRedemptionFixture() {
  // Missing Anvil/Forge is a test failure, not a skip. CI installs the pinned toolchain.
  execFileSync("forge", ["build"], {
    cwd: fileURLToPath(root),
    stdio: "pipe",
    timeout: 60_000,
  });
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn(
    "anvil",
    ["--port", String(port), "--chain-id", "8453", "--silent"],
    { stdio: "ignore" },
  );
  let startupError: Error | undefined;
  anvil.on("error", (error) => {
    startupError = error;
  });
  let server: Server | undefined;
  const stop = async () => {
    if (server) await close(server);
    if (anvil.exitCode === null && anvil.pid) {
      const exited = new Promise<void>((resolve) =>
        anvil.once("exit", () => resolve()),
      );
      anvil.kill("SIGTERM");
      await exited;
    }
  };
  try {
    const chain = notaChain(8453, rpcUrl);
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, { retryCount: 0, timeout: 2000 }),
      pollingInterval: 20,
    });
    const deadline = Date.now() + 10_000;
    while (true) {
      if (startupError) throw startupError;
      try {
        await publicClient.getChainId();
        break;
      } catch {
        if (Date.now() > deadline || anvil.exitCode !== null)
          throw new Error("Anvil failed to start");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const buyer = privateKeyToAccount(keys.buyer);
    const attacker = privateKeyToAccount(keys.attacker);
    const seller = privateKeyToAccount(keys.seller);
    const relayer = privateKeyToAccount(keys.relayer);
    const wallet = createWalletClient({
      account: relayer,
      chain,
      transport: http(rpcUrl),
    });
    const sellerWallet = createWalletClient({
      account: seller,
      chain,
      transport: http(rpcUrl),
    });
    // Only relayer and seller receive native currency. Buyer and attacker hold zero ETH.
    for (const address of [relayer.address, seller.address]) {
      await publicClient.request({
        method: "anvil_setBalance" as never,
        params: [address, toHex(100n * 10n ** 18n)] as never,
      });
    }
    async function mined(hash: Hex) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new Error("Fixture transaction reverted");
      return receipt;
    }
    async function deploy(file: string, args: unknown[] = []) {
      const artifact = JSON.parse(
        await readFile(new URL(`out/${file}.json`, root), "utf8"),
      ) as { abi: Abi; bytecode: { object: Hex } };
      const receipt = await mined(
        await wallet.deployContract({
          abi: artifact.abi,
          bytecode: artifact.bytecode.object,
          args,
        }),
      );
      if (!receipt.contractAddress) throw new Error("Deployment failed");
      return receipt.contractAddress;
    }
    const registry = await deploy("MockNota.sol/MockPurchaseRefRegistry");
    const token = await deploy("MockEIP3009Token.sol/MockEIP3009Token");
    const store = await deploy("MockNota.sol/MockSignedQuoteStore", [
      registry,
      token,
    ]);
    const adapter = await deploy("NotaX402Settlement.sol/NotaX402Settlement", [
      store,
    ]);
    const redemption = await deploy(
      "EntitlementRedemption.sol/EntitlementRedemption",
      [store, [adapter]],
    );
    await mined(
      await wallet.writeContract({
        address: registry,
        abi: purchaseRefRegistryAbi,
        functionName: "setConsumerAuthorization",
        args: [adapter, true],
      }),
    );
    await mined(
      await sellerWallet.writeContract({
        address: store,
        abi: notaReceiptStoreAbi,
        functionName: "createListing",
        args: [zeroHash, 1_000_000n, 1],
      }),
    );
    const tokenMockAbi = parseAbi([
      "function mint(address to, uint256 value)",
      "function balanceOf(address account) view returns (uint256)",
    ]);
    await mined(
      await wallet.writeContract({
        address: token,
        abi: tokenMockAbi,
        functionName: "mint",
        args: [buyer.address, 10_000_000n],
      }),
    );
    const deployment = {
      rpcUrl,
      store,
      redemption,
      adapters: [adapter],
      sellerPrivateKey: keys.seller,
      confirmations: 1,
    };
    const redemptionChain = await ViemRedemptionChain.connect(deployment);
    const logs: AuditRecord[] = [];
    server = createServer();
    const apiPort = await listen(server);
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    const authorizer = new MockAgentAuthorizer({
      resource: `${baseUrl}/v1/redemptions`,
      chainId: 8453,
      redemptionContract: redemption,
    });
    server.on(
      "request",
      createRedemptionApp({
        chain: redemptionChain,
        authorizer,
        mockChallenges: authorizer,
        logger: (record) => logs.push(record),
      }),
    );

    async function purchase(): Promise<{
      input: RedemptionInput;
      purchaseRef: Hex;
    }> {
      // A fresh preimage bundle generated in the buyer fixture, before its bound quote.
      // Never log it, and never put it into the EIP-3009 authorization nonce.
      const rawPurchaseRef = `day4-buyer-${randomBytes(12).toString("hex")}`;
      const purchaseRefNonce = toHex(randomBytes(32));
      const purchaseRef = await publicClient.readContract({
        address: store,
        abi: notaReceiptStoreAbi,
        functionName: "hashPurchaseRef",
        args: [seller.address, 1n, rawPurchaseRef, purchaseRefNonce],
      });
      const issuedAt = (await publicClient.getBlock()).timestamp;
      const quote = {
        listingId: 1n,
        buyer: buyer.address,
        purchaseRef,
        amount: 1_000_000n,
        metadataHash: keccak256(toHex("Day 4 local redemption demo")),
        agentId: zeroHash,
        integratorFeeRecipient: zeroAddress,
        integratorFeeAmount: 0n,
        issuedAt,
        expiresAt: issuedAt + 600n,
      };
      const quoteData = signedQuoteTypedData(quote, {
        chainId: 8453,
        store,
        seller: seller.address,
        settlementToken: token,
        purchaseRefRegistry: registry,
      });
      // The existing mock store does not validate seller signatures. We still sign its domain;
      // this suite is not evidence of deployed-store signature compatibility (fork suite is).
      const sellerSignature = await seller.signTypedData({
        ...quoteData,
        domain: { ...quoteData.domain, name: "MockNotaReceiptStore" },
      });
      const digest = await publicClient.readContract({
        address: store,
        abi: notaReceiptStoreAbi,
        functionName: "hashSignedReceiptQuote",
        args: [quote],
      });
      const salt = toHex(randomBytes(32));
      const nonce = await publicClient.readContract({
        address: adapter,
        abi: notaX402SettlementAbi,
        functionName: "authorizationNonce",
        args: [digest, salt],
      });
      const authorization = {
        from: buyer.address,
        to: adapter,
        value: quote.amount,
        validAfter: 0n,
        validBefore: quote.expiresAt,
        nonce,
      };
      const buyerSignature = await buyer.signTypedData(
        receiveAuthorizationTypedData(authorization, {
          name: "Mock USD Coin",
          version: "2",
          chainId: 8453,
          verifyingContract: token,
        }),
      );
      const receipt = await mined(
        await wallet.writeContract({
          address: adapter,
          abi: notaX402SettlementAbi,
          functionName: "settleWithAuthorization",
          args: [
            quote,
            sellerSignature,
            zeroAddress,
            authorization,
            buyerSignature,
            salt,
          ],
        }),
      );
      return {
        input: {
          listingId: "1",
          purchaseTxHash: receipt.transactionHash,
          rawPurchaseRef,
          purchaseRefNonce,
        },
        purchaseRef,
      };
    }
    return {
      publicClient,
      buyer,
      attacker,
      seller,
      store,
      adapter,
      registry,
      redemption,
      deployment,
      redemptionChain,
      logs,
      purchase,
      stop,
      redeem: (input: RedemptionInput, account = buyer) =>
        redeemWithMockAgent(baseUrl, account, input, {
          chainId: 8453,
          redemptionContract: redemption,
        }),
      setConsumer: async (purchaseRef: Hex, consumer: Address) =>
        mined(
          await wallet.writeContract({
            address: registry,
            abi: parseAbi([
              "function setConsumedBy(bytes32 purchaseRef, address consumer)",
            ]),
            functionName: "setConsumedBy",
            args: [purchaseRef, consumer],
          }),
        ),
      unrelatedTransaction: () =>
        wallet.sendTransaction({ to: seller.address, value: 0n }),
      revertedTransaction: () =>
        wallet.sendTransaction({
          to: adapter,
          data: "0xdeadbeef",
          gas: 100_000n,
        }),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
