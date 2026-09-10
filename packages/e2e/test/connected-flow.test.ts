import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseRpcUrl, startFixture, type Fixture } from "../src/fixture.js";
import { runConnectedDemo } from "../src/connected-demo.js";

const describeFork = baseRpcUrl() ? describe : describe.skip;

describeFork(
  "one HTTP purchase → authenticated access → redemption on a Base fork",
  () => {
    let fixture: Fixture;
    beforeAll(async () => {
      fixture = await startFixture();
    });
    afterAll(async () => {
      await fixture?.stop();
    });

    it("runs the demo with one reference, verifies actual events, and rejects B before A and replay after A", async () => {
      const steps = await runConnectedDemo(fixture);
      expect(steps.map((step) => [step.stage, step.status])).toEqual([
        ["payment.required", 402],
        ["payment.settled", 200],
        ["access.authenticated", 200],
        ["access.recovered", 200],
        ["attacker.rejected", 403],
        ["buyer.redeemed", 201],
        ["replay.rejected", 409],
      ]);
      expect(new Set(steps.map((step) => step.purchaseRef)).size).toBe(1);
      expect(steps.filter((step) => step.transactionsSent === 0)).toHaveLength(
        2,
      );
    });
  },
);
