import assert from "node:assert/strict";
import { startRedemptionFixture } from "../test/redemption-fixture.js";
import type { RedemptionResult } from "../src/redemption/chain.js";

async function main() {
  const f = await startRedemptionFixture();
  try {
    console.info(
      "LOCAL DEMO: real wallet signatures and local EVM transactions; mock Nota dependencies. No World ID / AgentBook verification.",
    );
    const { input, purchaseRef } = await f.purchase();
    const before = await f.publicClient.getTransactionCount({
      address: f.seller.address,
    });
    const attack = await f.redeem(input, f.attacker);
    const denial = (await attack.json()) as { code: string; step: number };
    assert.equal(attack.status, 403);
    assert.equal(denial.code, "BUYER_MISMATCH");
    assert.equal(
      await f.publicClient.getTransactionCount({ address: f.seller.address }),
      before,
    );
    console.info(
      JSON.stringify({
        scenario: "B with A's bundle",
        code: denial.code,
        step: denial.step,
        transactionsSent: 0,
      }),
    );
    const accepted = await f.redeem(input);
    const success = (await accepted.json()) as RedemptionResult;
    assert.equal(accepted.status, 201);
    assert.equal(success.purchaseRef, purchaseRef);
    assert.equal(
      await f.redemptionChain.redeemedAt(purchaseRef),
      BigInt(success.redeemedAt),
    );
    console.info(
      JSON.stringify({
        scenario: "A with correct bundle",
        purchaseRef: success.purchaseRef,
        transactionHash: success.transactionHash,
        redeemedAt: success.redeemedAt,
        event: "EntitlementRedeemed",
        authentication: "mock-wallet",
        humanVerified: false,
      }),
    );
    const replay = await f.redeem(input);
    const replayResult = (await replay.json()) as {
      code: string;
      step: number;
    };
    assert.equal(replay.status, 409);
    assert.equal(replayResult.code, "ALREADY_REDEEMED");
    assert.equal(
      await f.publicClient.getTransactionCount({ address: f.seller.address }),
      before + 1,
    );
    console.info(
      JSON.stringify({
        scenario: "A again",
        code: replayResult.code,
        step: replayResult.step,
        transactionsSent: 0,
      }),
    );
  } finally {
    await f.stop();
  }
}

main().catch(() => {
  // RPC error dumps can contain a redemption bundle. Keep this safe even on demo failures.
  console.error(
    "Local redemption demo failed. Run the test suite for isolated diagnostics; no preimage bundle was logged.",
  );
  process.exitCode = 1;
});
