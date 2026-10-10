import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, isAddressEqual, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  eip3009Abi,
  notaChain,
  notaReceiptStoreAbi,
  notaX402SettlementAbi,
  purchaseRefRegistryAbi,
} from "@nota/x402-nota";
import { CATALOG } from "../../resource-server/src/catalog.js";
import { redemptionAbi } from "../../resource-server/src/redemption/abi.js";
import { repoRoot } from "../src/live-config.js";

// Read-only readiness check for a live deployment: no transactions, no files written.
// Prints addresses and amounts only. Never prints a private key or a redemption bundle.
//
//   tsx deployment-preflight.ts <deployment manifest> [catalog id]
//
// Every contract address and the chain id come from the manifest, never from the environment.
// Without a catalog id only the deployment's wiring is checked; with one, the seller, buyer and
// quote store are also checked as ready to purchase that catalog entry.

interface DeploymentManifest {
  chainId: number;
  settlementToken: string;
  notaReceiptStore: { address: string };
  purchaseRefRegistry: { address: string };
  notaX402Settlement: { address: string };
  entitlementRedemption: { address: string };
}

const [manifestArg, catalogArg] = process.argv.slice(2);
if (!manifestArg) {
  throw new Error("usage: deployment-preflight.ts <deployment manifest> [catalog id]");
}
const CATALOG_ID: string | undefined = catalogArg;
const deployment = JSON.parse(
  readFileSync(path.resolve(repoRoot, manifestArg), "utf8"),
) as DeploymentManifest;
if (CATALOG_ID && !CATALOG[CATALOG_ID]) throw new Error(`unknown catalog id ${CATALOG_ID}`);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function report() {
  console.info(failures === 0 ? "\npreflight: PASS" : `\npreflight: FAIL (${failures})`);
  if (failures) process.exitCode = 1;
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("RPC_URL is required");

  const store = deployment.notaReceiptStore.address as Address;
  const registry = deployment.purchaseRefRegistry.address as Address;
  const token = deployment.settlementToken as Address;
  const adapter = deployment.notaX402Settlement.address as Address;
  const redemption = deployment.entitlementRedemption.address as Address;
  const listingId = BigInt(process.env.LISTING_ID ?? "1");

  const client = createPublicClient({
    chain: notaChain(deployment.chainId, rpcUrl),
    transport: http(rpcUrl, { retryCount: 0 }),
  });

  const chainId = await client.getChainId();
  check("RPC chain id", chainId === deployment.chainId, `got ${chainId}, want ${deployment.chainId}`);

  const read = <T>(address: Address, abi: any, functionName: string, args: unknown[] = []) =>
    client.readContract({ address, abi, functionName, args }) as Promise<T>;

  const adapterStore = await read<Address>(adapter, notaX402SettlementAbi, "STORE");
  check("adapter.STORE", isAddressEqual(adapterStore, store), adapterStore);
  const adapterToken = await read<Address>(adapter, notaX402SettlementAbi, "SETTLEMENT_TOKEN");
  check("adapter.SETTLEMENT_TOKEN", isAddressEqual(adapterToken, token), adapterToken);
  const adapterRegistry = await read<Address>(adapter, notaX402SettlementAbi, "PURCHASE_REF_REGISTRY");
  check("adapter.PURCHASE_REF_REGISTRY", isAddressEqual(adapterRegistry, registry), adapterRegistry);

  check(
    "registry.authorizedConsumers(adapter)",
    await read<boolean>(registry, purchaseRefRegistryAbi, "authorizedConsumers", [adapter]),
  );
  check(
    "redemption accepts adapter",
    await read<boolean>(redemption, redemptionAbi, "isAcceptedConsumer", [adapter]),
  );
  check(
    "store.purchasesPaused() is false",
    !(await read<boolean>(store, notaReceiptStoreAbi, "purchasesPaused")),
  );

  if (!CATALOG_ID) return report();
  const amount = CATALOG[CATALOG_ID]!.amount;

  const sellerKey = process.env.SELLER_PRIVATE_KEY as Hex | undefined;
  const listing = await read<{ seller: Address; active: boolean }>(
    store,
    notaReceiptStoreAbi,
    "getListing",
    [listingId],
  );
  if (!sellerKey) {
    check(`getListing(${listingId}).seller matches SELLER_PRIVATE_KEY`, false, "SELLER_PRIVATE_KEY not set");
  } else {
    const seller = privateKeyToAccount(sellerKey).address;
    check(
      `getListing(${listingId}).seller matches SELLER_PRIVATE_KEY`,
      isAddressEqual(listing.seller, seller),
      `listing ${listing.seller}, key ${seller}`,
    );
  }

  const buyerKey = process.env.BUYER_PRIVATE_KEY as Hex | undefined;
  const buyer = (process.env.BUYER_ADDRESS as Address | undefined) ??
    (buyerKey ? privateKeyToAccount(buyerKey).address : undefined);
  if (!buyer) {
    check("buyer USDC balance >= catalog amount", false, "set BUYER_ADDRESS or BUYER_PRIVATE_KEY");
  } else {
    const balance = await read<bigint>(token, eip3009Abi, "balanceOf", [buyer]);
    check(
      "buyer USDC balance >= catalog amount",
      balance >= amount,
      `buyer ${buyer} balance ${balance}, catalog ${CATALOG_ID} amount ${amount}`,
    );
  }

  const quotePath = process.env.QUOTE_STORE_PATH;
  if (!quotePath || !path.isAbsolute(quotePath)) {
    check("QUOTE_STORE_PATH is absolute and writable", false, "not set or not absolute");
  } else {
    const dir = path.dirname(quotePath);
    const insideRepo = !path.relative(repoRoot, quotePath).startsWith("..");
    let ignored = !insideRepo;
    if (insideRepo) {
      try {
        execFileSync("git", ["-C", repoRoot, "check-ignore", "-q", quotePath]);
        ignored = true;
      } catch {
        ignored = false;
      }
    }
    let writable = true;
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      writable = false;
    }
    check(
      "QUOTE_STORE_PATH is absolute and writable",
      writable,
      writable ? dir : `${dir} missing or not writable`,
    );
    check(
      "QUOTE_STORE_PATH is outside the repo or git-ignored",
      ignored,
      insideRepo ? "inside repo" : "outside repo",
    );
  }

  report();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
