import { createPublicClient, decodeEventLog } from "viem";
import { receiptPurchasedV2Event } from "../../resource-server/src/redemption/abi.js";
import { notaReceiptStoreAbi } from "../../x402-nota/src/abi.js";
import { deployed, verifyDeployments } from "./deployments.js";
import { preflightTransport } from "./rpc.js";
import {
  baseline,
  checkedMeta,
  checkFreshness,
  compareReceipt,
  graphQuery,
  healthQuery,
  scanSettlements,
  scanRedemptions,
} from "./index-verification.js";

// Fixed stage names give operators useful diagnostics without logging RPC URLs,
// response bodies, or provider errors that can contain credentials.
let stage = "configuration";

async function main(): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL_REQUIRED");
  const client = createPublicClient({
    transport: preflightTransport(rpcUrl),
  });
  stage = "chain";
  if ((await client.getChainId()) !== baseline.chainId)
    throw new Error("WRONG_CHAIN");
  const deploymentCheckBlock = await client.getBlockNumber();
  stage = "new-deployments";
  await verifyDeployments(client, deploymentCheckBlock);
  stage = "baseline-registry";
  const registry = await client.readContract({
    address: baseline.store,
    abi: notaReceiptStoreAbi,
    functionName: "PURCHASE_REF_REGISTRY",
    blockNumber: deploymentCheckBlock,
  });
  if (registry.toLowerCase() !== baseline.registry)
    throw new Error("REGISTRY_MISMATCH");
  stage = "baseline-creation";
  const creation = await client.getTransactionReceipt({
    hash: baseline.creationTx,
  });
  if (
    creation.status !== "success" ||
    creation.contractAddress?.toLowerCase() !== baseline.store ||
    creation.blockNumber !== BigInt(baseline.creationBlock) ||
    creation.blockHash !== baseline.creationBlockHash
  ) {
    throw new Error("CREATION_EVIDENCE_MISMATCH");
  }
  stage = "compatibility-receipt";
  const receipt = await client.getTransactionReceipt({
    hash: baseline.receiptTx,
  });
  if (
    receipt.status !== "success" ||
    receipt.blockNumber !== BigInt(baseline.receiptBlock) ||
    receipt.blockHash !== baseline.receiptBlockHash
  )
    throw new Error("RECEIPT_EVIDENCE_MISMATCH");
  stage = "compatibility-event";
  const log = receipt.logs.find(
    (item) => item.logIndex === baseline.receiptLogIndex,
  );
  if (!log || log.address.toLowerCase() !== baseline.store)
    throw new Error("RECEIPT_LOG_MISSING");
  const { args } = decodeEventLog({
    abi: [receiptPurchasedV2Event],
    data: log.data,
    topics: log.topics,
    strict: true,
  });
  if (
    args.receiptId !== 1n ||
    args.listingId !== 1n ||
    args.purchaseRef !== baseline.purchaseRef
  ) {
    throw new Error("RECEIPT_IDENTITY_MISMATCH");
  }
  stage = "compatibility-block";
  const receiptBlock = await client.getBlock({
    blockNumber: receipt.blockNumber,
  });
  if (receiptBlock.hash !== receipt.blockHash)
    throw new Error("RECEIPT_NOT_CANONICAL");
  const expected: Record<string, string> = {
    id: `${baseline.chainId}:${baseline.receiptTx}:${baseline.receiptLogIndex}`,
    transactionHash: baseline.receiptTx,
    logIndex: String(baseline.receiptLogIndex),
    blockNumber: String(baseline.receiptBlock),
    blockHash: baseline.receiptBlockHash,
    blockTimestamp: receiptBlock.timestamp.toString(),
  };
  for (const [key, value] of Object.entries(args))
    expected[key] = String(value).toLowerCase();
  const endpoint = process.env.GRAPH_QUERY_URL;
  if (!endpoint) {
    console.log(
      JSON.stringify(
        {
          status: "RPC_EVIDENCE_VERIFIED_ONLY",
          creationBlock: baseline.creationBlock,
          deployments: deployed,
          deploymentCheckBlock: deploymentCheckBlock.toString(),
          receiptTx: baseline.receiptTx,
          graphVerified: false,
        },
        null,
        2,
      ),
    );
    return;
  }
  stage = "index-health";
  const deployment = process.env.GRAPH_DEPLOYMENT_ID;
  if (!deployment) throw new Error("GRAPH_DEPLOYMENT_ID_REQUIRED");
  const query = graphQuery(endpoint);
  const index = checkedMeta(await query(healthQuery, {}), deployment);
  checkFreshness(index, await client.getBlockNumber());
  const indexedBlock = await client.getBlock({
    blockNumber: BigInt(index.number),
  });
  if (indexedBlock.hash !== index.hash) throw new Error("INDEX_NOT_CANONICAL");
  stage = "index-snapshot";
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const number =
    BigInt(index.number) < finalized.number
      ? BigInt(index.number)
      : finalized.number;
  if (number < BigInt(deployed.redemptionBlock))
    throw new Error("SNAPSHOT_BEFORE_DEPLOYMENTS");
  const block = await client.getBlock({ blockNumber: number });
  const snapshot = { number: Number(number), hash: block.hash };
  stage = "index-settlements";
  const rows = await scanSettlements(query, deployment, snapshot);
  stage = "index-redemptions";
  const redemptions = await scanRedemptions(query, deployment, snapshot);
  stage = "index-receipt-parity";
  compareReceipt(rows, expected);
  // Catch a stalled or errored index during the paginated scan as well.
  stage = "index-final-health";
  checkFreshness(
    checkedMeta(await query(healthQuery, {}), deployment),
    await client.getBlockNumber(),
  );
  console.log(
    JSON.stringify(
      {
        status: "INDEX_COMPATIBILITY_VERIFIED",
        deployment,
        snapshot,
        indexedSettlementCount: rows.length,
        indexedAdapterSettlementCount: rows.filter(
          (row) => row.kind === "X402_ADAPTER",
        ).length,
        indexedRedemptionCount: redemptions.length,
        deployments: deployed,
        deploymentCheckBlock: deploymentCheckBlock.toString(),
        receiptTx: baseline.receiptTx,
        scope:
          "Receipt #1 compared to RPC; source and pagination checks for configured store, adapter and redemption. Zero new events is not proof of live adapter/redemption indexing; not an event-completeness audit or redemption authorization.",
      },
      null,
      2,
    ),
  );
}

main().catch(() => {
  // URLs can embed API keys; provider error messages and response bodies are not logged.
  console.error(
    `Subgraph preflight failed at ${stage}; no verification claim. Check configuration, RPC, index health and receipt parity. Provider details suppressed.`,
  );
  process.exitCode = 1;
});
