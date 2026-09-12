import {
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import record from "../../../deployments/base.json";

// The reviewed deployment record is the source of truth for off-chain checks.
// The manifest remains explicit; a deterministic test catches configuration drift.
export const deployed = {
  chainId: record.chainId,
  store: record.notaReceiptStore.address.toLowerCase() as Address,
  registry: record.purchaseRefRegistry.address.toLowerCase() as Address,
  token: record.settlementToken.toLowerCase() as Address,
  adapter: record.notaX402Settlement.address.toLowerCase() as Address,
  redemption: record.entitlementRedemption.address.toLowerCase() as Address,
  adapterBlock: record.notaX402Settlement.deployBlock,
  redemptionBlock: record.entitlementRedemption.deployBlock,
};

const wiringAbi = parseAbi([
  "function STORE() view returns (address)",
  "function PURCHASE_REF_REGISTRY() view returns (address)",
  "function SETTLEMENT_TOKEN() view returns (address)",
  "function acceptedConsumers() view returns (address[])",
  "function authorizedConsumers(address) view returns (bool)",
]);

type Reader = Pick<
  PublicClient,
  "getTransactionReceipt" | "getBytecode" | "readContract"
>;

// Read-only, pinned to a caller-selected RPC block. This proves deployment wiring,
// not event-index completeness, fulfillment, or the right to redeem a purchase.
export async function verifyDeployments(
  client: Reader,
  blockNumber: bigint,
): Promise<void> {
  if (blockNumber < BigInt(deployed.redemptionBlock))
    throw new Error("SNAPSHOT_BEFORE_DEPLOYMENTS");
  for (const contract of [
    record.notaX402Settlement,
    record.entitlementRedemption,
  ]) {
    const address = contract.address.toLowerCase() as Address;
    const receipt = await client.getTransactionReceipt({
      hash: contract.deployTxHash as Hex,
    });
    if (
      receipt.status !== "success" ||
      receipt.contractAddress?.toLowerCase() !== address ||
      receipt.blockNumber !== BigInt(contract.deployBlock) ||
      receipt.blockHash !== contract.deployBlockHash
    )
      throw new Error("DEPLOYMENT_EVIDENCE_MISMATCH");
    const code = await client.getBytecode({ address, blockNumber });
    if (!code || keccak256(code) !== contract.runtimeCodeHash)
      throw new Error("DEPLOYMENT_CODE_MISMATCH");
    const store = await client.readContract({
      address,
      abi: wiringAbi,
      functionName: "STORE",
      blockNumber,
    });
    const registry = await client.readContract({
      address,
      abi: wiringAbi,
      functionName: "PURCHASE_REF_REGISTRY",
      blockNumber,
    });
    if (
      store.toLowerCase() !== deployed.store ||
      registry.toLowerCase() !== deployed.registry
    )
      throw new Error("DEPLOYMENT_WIRING_MISMATCH");
  }
  const token = await client.readContract({
    address: deployed.adapter,
    abi: wiringAbi,
    functionName: "SETTLEMENT_TOKEN",
    blockNumber,
  });
  if (token.toLowerCase() !== deployed.token)
    throw new Error("SETTLEMENT_TOKEN_MISMATCH");
  const accepted = await client.readContract({
    address: deployed.redemption,
    abi: wiringAbi,
    functionName: "acceptedConsumers",
    blockNumber,
  });
  const consumers = accepted.map((address) => address.toLowerCase()).sort();
  if (
    JSON.stringify(consumers) !==
    JSON.stringify([deployed.store, deployed.adapter].sort())
  )
    throw new Error("ACCEPTED_CONSUMERS_MISMATCH");
  const authorized = await client.readContract({
    address: deployed.registry,
    abi: wiringAbi,
    functionName: "authorizedConsumers",
    args: [deployed.adapter],
    blockNumber,
  });
  if (!authorized) throw new Error("ADAPTER_NOT_AUTHORIZED");
}
