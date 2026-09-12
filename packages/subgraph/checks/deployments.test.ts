import { beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256 } from "viem";
import record from "../../../deployments/base.json";
import { deployed, verifyDeployments } from "./deployments.js";

// Stub only the hash result: these tests exercise RPC evidence validation, not
// viem's hashing implementation, and need neither live RPC nor bytecode fixtures.
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  keccak256: vi.fn((value: string) => value),
}));

const blockNumber = BigInt(deployed.redemptionBlock + 100);
function reader() {
  return {
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => {
      const contract = [
        record.notaX402Settlement,
        record.entitlementRedemption,
      ].find((item) => item.deployTxHash === hash)!;
      return {
        status: "success",
        contractAddress: contract.address,
        blockNumber: BigInt(contract.deployBlock),
        blockHash: contract.deployBlockHash,
      };
    }),
    getBytecode: vi.fn(async ({ address }: { address: string }) =>
      address === deployed.adapter
        ? record.notaX402Settlement.runtimeCodeHash
        : record.entitlementRedemption.runtimeCodeHash,
    ),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "STORE":
          return deployed.store;
        case "PURCHASE_REF_REGISTRY":
          return deployed.registry;
        case "SETTLEMENT_TOKEN":
          return deployed.token;
        case "acceptedConsumers":
          return [deployed.store, deployed.adapter];
        case "authorizedConsumers":
          return true as boolean;
        default:
          throw new Error("UNEXPECTED_READ");
      }
    }),
  };
}
type Client = Parameters<typeof verifyDeployments>[0];
beforeEach(() => vi.clearAllMocks());

describe("recorded Base deployment preflight", () => {
  it("checks both creations, runtime hashes and exact wiring at one block", async () => {
    const client = reader();
    await verifyDeployments(client as unknown as Client, blockNumber);
    expect(client.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(keccak256).toHaveBeenCalledTimes(2);
    for (const [request] of [
      ...client.getBytecode.mock.calls,
      ...client.readContract.mock.calls,
    ])
      expect(request).toHaveProperty("blockNumber", blockNumber);
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: deployed.registry,
        functionName: "authorizedConsumers",
        args: [deployed.adapter],
      }),
    );
  });

  it.each([
    { status: "reverted" },
    { contractAddress: deployed.registry },
    { blockNumber: 1n },
    { blockHash: `0x${"00".repeat(32)}` },
  ])("rejects mismatched creation evidence: %s", async (change) => {
    const client = reader();
    const receipt = await client.getTransactionReceipt({
      hash: record.notaX402Settlement.deployTxHash,
    });
    client.getTransactionReceipt.mockResolvedValueOnce({
      ...receipt,
      ...change,
    });
    await expect(
      verifyDeployments(client as unknown as Client, blockNumber),
    ).rejects.toThrow("DEPLOYMENT_EVIDENCE_MISMATCH");
  });

  it.each(["0x", "0x1234"])(
    "rejects absent or different runtime code: %s",
    async (code) => {
      const client = reader();
      client.getBytecode.mockResolvedValueOnce(code);
      await expect(
        verifyDeployments(client as unknown as Client, blockNumber),
      ).rejects.toThrow("DEPLOYMENT_CODE_MISMATCH");
    },
  );

  it.each([
    ["STORE", deployed.registry, "DEPLOYMENT_WIRING_MISMATCH"],
    ["PURCHASE_REF_REGISTRY", deployed.store, "DEPLOYMENT_WIRING_MISMATCH"],
    ["SETTLEMENT_TOKEN", deployed.store, "SETTLEMENT_TOKEN_MISMATCH"],
    ["acceptedConsumers", [deployed.store], "ACCEPTED_CONSUMERS_MISMATCH"],
    [
      "acceptedConsumers",
      [deployed.store, deployed.adapter, deployed.registry],
      "ACCEPTED_CONSUMERS_MISMATCH",
    ],
    ["authorizedConsumers", false, "ADAPTER_NOT_AUTHORIZED"],
  ])("rejects incorrect %s", async (name, value, error) => {
    const client = reader();
    const original = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async (request) =>
      request.functionName === name ? value : original(request),
    );
    await expect(
      verifyDeployments(client as unknown as Client, blockNumber),
    ).rejects.toThrow(error as string);
  });

  it("rejects a snapshot before the contracts exist, without RPC calls", async () => {
    const client = reader();
    await expect(
      verifyDeployments(
        client as unknown as Client,
        BigInt(deployed.redemptionBlock - 1),
      ),
    ).rejects.toThrow("SNAPSHOT_BEFORE_DEPLOYMENTS");
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
  });
});
