import { describe, expect, it } from "vitest";
import { baseRpcUrl, startFixture } from "../src/fixture.js";
import { runConnectedDemo } from "../src/connected-demo.js";
import { createStory } from "../src/story.js";

const describeFork = baseRpcUrl() ? describe : describe.skip;
describeFork("story narration on a disposable Base fork", () => {
  it("awaits six pauses while retaining all seven original steps and assertions", async () => {
    const fixture = await startFixture();
    const originalFetch = globalThis.fetch;
    let pauses = 0;
    const output: string[] = [];
    const story = createStory(
      fixture,
      async () => {
        // Asynchronous callback must finish before the next step is allowed to run.
        await new Promise((resolve) => setTimeout(resolve, 10));
        pauses++;
      },
      (line) => output.push(line),
    );
    globalThis.fetch = story.observeFetch(originalFetch);
    try {
      await story.start();
      const steps = await runConnectedDemo(fixture, story.onStep);
      expect(pauses).toBe(5);
      await story.finish();
      expect(pauses).toBe(6);
      expect(steps).toHaveLength(7);
      expect(steps[4]?.code).toBe("BUYER_MISMATCH");
      expect(steps[6]?.code).toBe("ALREADY_REDEEMED");
      expect(output.join("\n")).not.toMatch(/rawPurchaseRef|purchaseRefNonce/);
      expect(output.filter((line) => line.includes("ACT "))).toHaveLength(6);
    } finally {
      globalThis.fetch = originalFetch;
      await fixture.stop();
    }
  });
});
