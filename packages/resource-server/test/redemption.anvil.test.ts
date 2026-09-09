import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { decodeEventLog, zeroAddress, zeroHash, type Hex } from "viem";
import { redemptionAbi } from "../src/redemption/abi.js";
import { ViemRedemptionChain } from "../src/redemption/chain.js";
import { startRedemptionFixture } from "./redemption-fixture.js";

describe("redemption HTTP → frozen contracts on local Anvil (no external RPC)", () => {
  let f: Awaited<ReturnType<typeof startRedemptionFixture>>;
  beforeAll(async () => {
    f = await startRedemptionFixture();
  });
  afterAll(async () => {
    await f?.stop();
  });

  it("B is rejected before any transaction, A emits EntitlementRedeemed, A replay sends nothing", async () => {
    const { input, purchaseRef } = await f.purchase();
    const initialNonce = await f.publicClient.getTransactionCount({
      address: f.seller.address,
    });
    const initialBlock = await f.publicClient.getBlockNumber({ cacheTime: 0 });
    const attack = await f.redeem(input, f.attacker);
    expect(attack.status).toBe(403);
    expect(await attack.json()).toMatchObject({
      code: "BUYER_MISMATCH",
      step: 6,
    });
    expect(
      await f.publicClient.getTransactionCount({ address: f.seller.address }),
    ).toBe(initialNonce);
    expect(await f.publicClient.getBlockNumber({ cacheTime: 0 })).toBe(
      initialBlock,
    );
    expect(await f.redemptionChain.redeemedAt(purchaseRef)).toBe(0n);

    const accepted = await f.redeem(input);
    const result = (await accepted.json()) as {
      transactionHash: Hex;
      redeemedAt: string;
    };
    expect(accepted.status).toBe(201);
    const receipt = await f.publicClient.getTransactionReceipt({
      hash: result.transactionHash,
    });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(f.seller.address.toLowerCase());
    const logs = receipt.logs.filter(
      (log) => log.address.toLowerCase() === f.redemption.toLowerCase(),
    );
    expect(logs).toHaveLength(1);
    const event = decodeEventLog({
      abi: redemptionAbi,
      eventName: "EntitlementRedeemed",
      data: logs[0]!.data,
      topics: logs[0]!.topics,
    });
    expect(event.args).toEqual({
      purchaseRef,
      seller: f.seller.address,
      redeemedAt: BigInt(result.redeemedAt),
    });
    expect(await f.redemptionChain.redeemedAt(purchaseRef)).toBe(
      BigInt(result.redeemedAt),
    );
    const redeemedBlock = await f.publicClient.getBlockNumber({ cacheTime: 0 });
    const replay = await f.redeem(input);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: "ALREADY_REDEEMED",
      step: 5,
    });
    expect(
      await f.publicClient.getTransactionCount({ address: f.seller.address }),
    ).toBe(initialNonce + 1);
    expect(await f.publicClient.getBlockNumber({ cacheTime: 0 })).toBe(
      redeemedBlock,
    );
    expect(await f.publicClient.getBalance({ address: f.buyer.address })).toBe(
      0n,
    );
    expect(
      await f.publicClient.getBalance({ address: f.attacker.address }),
    ).toBe(0n);
    expect(f.logs).toContainEqual(
      expect.objectContaining({ code: "BUYER_MISMATCH", step: 6 }),
    );
    expect(JSON.stringify(f.logs)).not.toContain(input.rawPurchaseRef);
    expect(JSON.stringify(f.logs)).not.toContain(input.purchaseRefNonce);
  });

  it("rejects consumption by another accepted module and unconsumed references", async () => {
    const { input, purchaseRef } = await f.purchase();
    // Store is accepted by the frozen contract, but did not emit this adapter settlement.
    await f.setConsumer(purchaseRef, f.store);
    expect(await (await f.redeem(input)).json()).toMatchObject({
      code: "CONSUMER_MISMATCH",
      step: 4,
    });
    await f.setConsumer(purchaseRef, zeroAddress);
    expect(await (await f.redeem(input)).json()).toMatchObject({
      code: "REFERENCE_UNCONSUMED",
      step: 4,
    });
    expect(await f.redemptionChain.redeemedAt(purchaseRef)).toBe(0n);
  });

  it("checks confirmations and missing transactions through the real RPC reader", async () => {
    const { input } = await f.purchase();
    const conservative = await ViemRedemptionChain.connect({
      ...f.deployment,
      confirmations: 3,
    });
    await expect(
      conservative.settlements(input.purchaseTxHash),
    ).rejects.toMatchObject({ code: "PURCHASE_UNCONFIRMED", step: 2 });
    await expect(f.redemptionChain.settlements(zeroHash)).rejects.toMatchObject(
      { code: "PURCHASE_NOT_MINED", step: 2 },
    );
  });

  it("rejects nonexistent listing through the canonical helper without leaking its error calldata", async () => {
    const { input, purchaseRef } = await f.purchase();
    const response = await f.redeem({ ...input, listingId: "999" });
    expect(response.status).toBe(503);
    const result = await response.text();
    expect(result).not.toContain(input.rawPurchaseRef);
    expect(result).not.toContain(input.purchaseRefNonce);
    expect(await f.redemptionChain.redeemedAt(purchaseRef)).toBe(0n);
  });

  it("fails startup for a configured adapter with wrong store wiring", async () => {
    await expect(
      ViemRedemptionChain.connect({
        ...f.deployment,
        adapters: [f.redemption],
      }),
    ).rejects.toThrow();
  });

  it("does not retry a broadcast whose response was lost even if the transaction mined", async () => {
    const { input, purchaseRef } = await f.purchase();
    let sends = 0;
    let broadcastHash: Hex | undefined;
    const proxy = createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk.toString();
        const request = JSON.parse(raw) as { id: number; method: string };
        const upstream = await fetch(f.deployment.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        });
        const response = await upstream.text();
        res.setHeader("content-type", "application/json");
        if (request.method === "eth_sendRawTransaction") {
          sends++;
          broadcastHash = (JSON.parse(response) as { result?: Hex }).result;
          // Forward first, then lose the success response: the hazardous ambiguous-broadcast case.
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32000, message: "simulated lost response" },
            }),
          );
        } else res.end(response);
      } catch {
        res.statusCode = 502;
        res.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = proxy.address();
      if (!address || typeof address === "string")
        throw new Error("Missing proxy port");
      const uncertain = await ViemRedemptionChain.connect({
        ...f.deployment,
        rpcUrl: `http://127.0.0.1:${address.port}`,
      });
      await expect(uncertain.submit(input, purchaseRef)).rejects.toMatchObject({
        code: "SUBMISSION_UNCERTAIN",
      });
      // RPC acknowledgement does not mean mined, including on newer Anvil versions.
      expect(broadcastHash).toMatch(/^0x[0-9a-f]{64}$/);
      const mined = await f.publicClient.waitForTransactionReceipt({ hash: broadcastHash! });
      expect(mined.status).toBe("success");
      expect(await f.redemptionChain.redeemedAt(purchaseRef)).toBeGreaterThan(
        0n,
      );
      await expect(uncertain.submit(input, purchaseRef)).rejects.toMatchObject({
        code: "SELLER_RECONCILIATION_REQUIRED",
      });
      expect(sends).toBe(1);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("rejects reverted transactions and successful transactions without a Nota settlement", async () => {
    const reverted = await f.revertedTransaction();
    await f.publicClient.waitForTransactionReceipt({ hash: reverted });
    await expect(f.redemptionChain.settlements(reverted)).rejects.toMatchObject(
      { code: "PURCHASE_REVERTED", step: 2 },
    );
    const unrelated = await f.unrelatedTransaction();
    await f.publicClient.waitForTransactionReceipt({ hash: unrelated });
    await expect(
      f.redemptionChain.settlements(unrelated),
    ).rejects.toMatchObject({ code: "NO_NOTA_SETTLEMENT", step: 2 });
  });
});
