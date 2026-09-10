import assert from "node:assert/strict";
import { payAndFetch, refetchPaidResource } from "@nota/client";
import {
  baseDeployment,
  buildPaymentPayload,
  encodePaymentPayload,
  requireNotaExtension,
  type PaymentRequiredResponse,
} from "@nota/x402-nota";
import { decodeEventLog, isAddressEqual, type Hex } from "viem";
import { redemptionAbi } from "../../resource-server/src/redemption/abi.js";
import type { RedemptionResult } from "../../resource-server/src/redemption/chain.js";
import type { Fixture } from "./fixture.js";

/** Only public, deliberately selected fields may enter the demo transcript. */
export interface DemoStep {
  stage:
    | "payment.required"
    | "payment.settled"
    | "access.authenticated"
    | "access.recovered"
    | "attacker.rejected"
    | "buyer.redeemed"
    | "replay.rejected";
  status: number;
  purchaseRef: Hex;
  transactionHash?: Hex;
  code?: string;
  step?: number;
  transactionsSent?: number;
}

/** One real HTTP purchase, using the returned bundle for every redemption attempt. */
export async function runConnectedDemo(
  f: Fixture,
  onStep: (step: DemoStep) => void = () => {},
) {
  const transcript: DemoStep[] = [];
  const report = (step: DemoStep) => {
    transcript.push(step);
    onStep(step);
  };
  let purchaseRef: Hex | undefined;
  let quoteResponses = 0;
  let settlementRequests = 0;
  let accessChallenges = 0;
  let publicPaymentData = "";
  const buyerEthBefore = await f.publicClient.getBalance({ address: f.buyer });
  const buyerNonceBefore = await f.publicClient.getTransactionCount({
    address: f.buyer,
  });
  const buyerTokensBefore = await f.usdcBalance(f.buyer);
  assert.equal(buyerEthBefore, 0n, "The demo buyer must start without ETH");

  const tracedFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const response = await fetch(input, init);
    if (response.status === 402 && url.href === f.resourceUrl) {
      quoteResponses++;
      const body = await response.clone().text();
      publicPaymentData += body;
      assert(
        !/rawPurchaseRef|purchaseRefNonce/.test(body),
        "402 response exposed a bundle field",
      );
      const extension = requireNotaExtension(
        JSON.parse(body) as PaymentRequiredResponse,
      );
      assert(
        isAddressEqual(extension.quote.buyer, f.buyer),
        "Quote must bind buyer A",
      );
      purchaseRef = extension.quote.purchaseRef;
      report({ stage: "payment.required", status: 402, purchaseRef });
    }
    if (url.href === `${f.facilitatorUrl}/settle`) {
      settlementRequests++;
      assert.equal(typeof init?.body, "string");
      publicPaymentData += init!.body as string;
      assert(
        !/rawPurchaseRef|purchaseRefNonce/.test(init!.body as string),
        "Settlement request exposed a bundle field",
      );
      assert.equal(
        response.status,
        200,
        "Facilitator must settle the purchase",
      );
      const settled = (await response.clone().json()) as {
        purchaseRef: Hex;
        txHash: Hex;
      };
      assert.equal(settled.purchaseRef, purchaseRef);
      report({
        stage: "payment.settled",
        status: 200,
        purchaseRef: settled.purchaseRef,
        transactionHash: settled.txHash,
      });
    }
    if (url.pathname === "/access/challenge") accessChallenges++;
    return response;
  };
  const agent = {
    rpcUrl: f.rpcUrl,
    chainId: f.chainId,
    privateKey: f.buyerPrivateKey,
    maxAmount: 10_000_000n,
    trusted: baseDeployment([f.adapter]),
    logger: { info: () => {}, warn: () => {} },
    fetchImpl: tracedFetch,
  };
  const paid = await payAndFetch<{ report: string }>(f.resourceUrl, agent);
  assert(
    paid.entitlement,
    "Authenticated paid response must supply the redemption bundle",
  );
  assert.equal(paid.content.report, "base-usdc-flows-2026-09");
  assert.equal(paid.receipt.purchaseRef, purchaseRef);
  assert.equal(quoteResponses, 1, "Demo must use one issued quote");
  assert.equal(settlementRequests, 1, "Demo must use one settlement");
  assert.equal(accessChallenges, 1, "Paid access must authenticate the buyer");
  for (const secret of [
    paid.entitlement.rawPurchaseRef,
    paid.entitlement.purchaseRefNonce,
  ]) {
    assert(
      !publicPaymentData.includes(secret),
      "Bundle must be absent from public payment messages",
    );
  }
  const settled = await f.publicClient.getTransactionReceipt({
    hash: paid.receipt.txHash,
  });
  assert.equal(settled.status, "success");
  assert(
    isAddressEqual(settled.from, f.relayer),
    "Relayer, not buyer, must send settlement",
  );
  assert.equal(
    await f.usdcBalance(f.buyer),
    buyerTokensBefore - BigInt(paid.receipt.amount),
  );
  assert.equal(await f.usdcBalance(f.adapter), 0n);
  assert(
    isAddressEqual(await f.redemptionChain.consumedBy(purchaseRef!), f.adapter),
  );
  report({
    stage: "access.authenticated",
    status: 200,
    purchaseRef: purchaseRef!,
  });

  const anonymous = await fetch(f.resourceUrl, {
    headers: {
      "x-payment": encodePaymentPayload(
        buildPaymentPayload("base", purchaseRef!, f.adapter),
      ),
    },
  });
  assert.equal(
    anonymous.status,
    401,
    "Public receipt alone must not release the bundle",
  );
  const anonymousBody = await anonymous.text();
  assert(!anonymousBody.includes(paid.entitlement.purchaseRefNonce));

  // This restart exercises the file-backed issued order, not an in-memory demo shortcut.
  await f.restartResourceServer();
  const recovered = await refetchPaidResource(
    f.resourceUrl,
    purchaseRef!,
    f.adapter,
    agent,
  );
  assert.equal(
    recovered.entitlement?.purchaseRefNonce,
    paid.entitlement.purchaseRefNonce,
  );
  assert.equal(
    recovered.entitlement?.rawPurchaseRef,
    paid.entitlement.rawPurchaseRef,
  );
  assert.equal(settlementRequests, 1, "Recovery must not buy again");
  report({ stage: "access.recovered", status: 200, purchaseRef: purchaseRef! });

  const input = { ...paid.entitlement, purchaseTxHash: paid.receipt.txHash };
  const sellerNonceBefore = await f.publicClient.getTransactionCount({
    address: f.seller,
  });
  const blockBefore = await f.publicClient.getBlockNumber({ cacheTime: 0 });
  assert.equal(await f.redemptionChain.redeemedAt(purchaseRef!), 0n);
  const attack = await f.redeem(input, true);
  const denial = (await attack.json()) as { code: string; step: number };
  assert.equal(attack.status, 403);
  assert.equal(denial.code, "BUYER_MISMATCH");
  assert.equal(denial.step, 6);
  assert.equal(
    await f.publicClient.getTransactionCount({ address: f.seller }),
    sellerNonceBefore,
  );
  assert.equal(
    await f.publicClient.getBlockNumber({ cacheTime: 0 }),
    blockBefore,
  );
  assert.equal(await f.redemptionChain.redeemedAt(purchaseRef!), 0n);
  report({
    stage: "attacker.rejected",
    status: 403,
    purchaseRef: purchaseRef!,
    code: denial.code,
    step: denial.step,
    transactionsSent: 0,
  });

  const accepted = await f.redeem(input);
  assert.equal(accepted.status, 201);
  const redeemed = (await accepted.json()) as RedemptionResult & {
    humanVerified: boolean;
  };
  assert.equal(redeemed.humanVerified, false);
  assert.equal(redeemed.purchaseRef, purchaseRef);
  const receipt = await f.publicClient.getTransactionReceipt({
    hash: redeemed.transactionHash,
  });
  assert.equal(receipt.status, "success");
  assert(isAddressEqual(receipt.from, f.seller));
  const logs = receipt.logs.filter((log) =>
    isAddressEqual(log.address, f.redemption),
  );
  assert.equal(logs.length, 1);
  const event = decodeEventLog({
    abi: redemptionAbi,
    eventName: "EntitlementRedeemed",
    data: logs[0]!.data,
    topics: logs[0]!.topics,
  });
  assert.equal(event.args.purchaseRef, purchaseRef);
  assert(isAddressEqual(event.args.seller, f.seller));
  assert.equal(event.args.redeemedAt, BigInt(redeemed.redeemedAt));
  assert(event.args.redeemedAt > 0n);
  assert.equal(
    await f.redemptionChain.redeemedAt(purchaseRef!),
    event.args.redeemedAt,
  );
  report({
    stage: "buyer.redeemed",
    status: 201,
    purchaseRef: purchaseRef!,
    transactionHash: redeemed.transactionHash,
    transactionsSent: 1,
  });

  const blockAfter = await f.publicClient.getBlockNumber({ cacheTime: 0 });
  const replay = await f.redeem(input);
  const replayResult = (await replay.json()) as { code: string; step: number };
  assert.equal(replay.status, 409);
  assert.equal(replayResult.code, "ALREADY_REDEEMED");
  assert.equal(replayResult.step, 5);
  assert.equal(
    await f.publicClient.getTransactionCount({ address: f.seller }),
    sellerNonceBefore + 1,
  );
  assert.equal(
    await f.publicClient.getBlockNumber({ cacheTime: 0 }),
    blockAfter,
  );
  assert.equal(
    await f.publicClient.getBalance({ address: f.buyer }),
    buyerEthBefore,
  );
  assert.equal(
    await f.publicClient.getTransactionCount({ address: f.buyer }),
    buyerNonceBefore,
  );
  report({
    stage: "replay.rejected",
    status: 409,
    purchaseRef: purchaseRef!,
    code: replayResult.code,
    step: replayResult.step,
    transactionsSent: 0,
  });

  const safeOutput = JSON.stringify([transcript, f.redemptionLogs]);
  for (const secret of [input.rawPurchaseRef, input.purchaseRefNonce])
    assert(
      !safeOutput.includes(secret),
      "Demo transcript or audit logs exposed a bundle",
    );
  assert(
    f.redemptionLogs.some(
      (entry) => entry.code === "BUYER_MISMATCH" && entry.step === 6,
    ),
  );
  return transcript;
}
