import { custom, http } from "viem";

function isRateLimited(error: unknown): boolean {
  // Viem wraps JSON-RPC errors. Bound traversal and never log provider messages.
  let cause = error;
  for (
    let depth = 0;
    depth < 8 && cause && typeof cause === "object";
    depth++
  ) {
    const item = cause as { code?: unknown; status?: unknown; cause?: unknown };
    if (
      item.code === -32016 ||
      item.code === -32005 ||
      item.code === 429 ||
      item.status === 429
    )
      return true;
    cause = item.cause;
  }
  return false;
}

export async function retryRateLimit<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !isRateLimited(error)) throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 5000 * 2 ** attempt),
      );
    }
  }
}

export function preflightTransport(url: string) {
  // Disable nested retries: at most three requests, with 5s/10s backoff, per read.
  // Base's public RPC uses -32016, which viem's default retry policy excludes.
  const upstream = http(url, { timeout: 20_000, retryCount: 0 })({});
  return custom(
    { request: (args) => retryRateLimit(() => upstream.request(args)) },
    {
      retryCount: 0,
      methods: {
        include: [
          "eth_chainId",
          "eth_blockNumber",
          "eth_getTransactionReceipt",
          "eth_getCode",
          "eth_call",
          "eth_getBlockByNumber",
        ],
      },
    },
  );
}
