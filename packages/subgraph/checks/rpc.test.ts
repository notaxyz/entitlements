import { afterEach, describe, expect, it, vi } from "vitest";
import { preflightTransport, retryRateLimit } from "./rpc.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("read-only preflight RPC transport", () => {
  it.each([-32016, -32005, 429])(
    "backs off on rate-limit code %s",
    async (code) => {
      vi.useFakeTimers();
      const operation = vi
        .fn()
        .mockRejectedValueOnce({ cause: { code } })
        .mockResolvedValue("ok");
      const result = retryRateLimit(operation);
      await vi.advanceTimersByTimeAsync(4999);
      expect(operation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBe("ok");
      expect(operation).toHaveBeenCalledTimes(2);
    },
  );

  it("fails closed after three rate-limited requests", async () => {
    vi.useFakeTimers();
    const error = { cause: { status: 429 } };
    const operation = vi.fn().mockRejectedValue(error);
    const result = expect(retryRateLimit(operation)).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(15000);
    await result;
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry reverts or unknown errors", async () => {
    const operation = vi
      .fn()
      .mockRejectedValue({ code: 3, message: "execution reverted" });
    await expect(retryRateLimit(operation)).rejects.toMatchObject({ code: 3 });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("forbids transaction submission before touching the network", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const transport = preflightTransport("https://example.invalid")({});
    await expect(
      transport.request({ method: "eth_sendRawTransaction", params: ["0x"] }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
