import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { parseUnits, type Hex } from "viem";
import deployment from "../../../deployments/base.json";
import { mkdir, writeFile, unlink } from "node:fs/promises";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const LIVE_CONFIRMATION = "SPEND ON BASE";

/** Only controlled, credential-free configuration messages may be printed by the CLI. */
export class LiveConfigError extends Error {}

export function demoMode(args: string[]): "fork" | "live" {
  if (
    new Set(args).size !== args.length ||
    args.some((arg) => !["--live", "--story"].includes(arg))
  )
    throw new LiveConfigError(
      "Use --story for narration, --live for Base mainnet, or both; no other flags",
    );
  return args.includes("--live") ? "live" : "fork";
}

export function requireLiveConfirmation(
  answer: string,
  interactive: boolean,
): void {
  if (!interactive || answer !== LIVE_CONFIRMATION)
    throw new LiveConfigError("LIVE_CONFIRMATION_REQUIRED");
}

export function readLiveConfig(env: NodeJS.ProcessEnv) {
  function key(name: string): Hex {
    const value = env[name];
    if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value))
      throw new LiveConfigError(`Missing or invalid ${name}`);
    try {
      privateKeyToAccount(value as Hex);
    } catch {
      throw new LiveConfigError(`Invalid ${name}`);
    }
    return value as Hex;
  }
  const sellerKey = key("SELLER_PRIVATE_KEY");
  const buyerKey = key("BUYER_PRIVATE_KEY");
  const relayerKey = env.RELAYER_PRIVATE_KEY
    ? key("RELAYER_PRIVATE_KEY")
    : sellerKey;
  const seller = privateKeyToAccount(sellerKey).address;
  const buyer = privateKeyToAccount(buyerKey).address;
  const relayer = privateKeyToAccount(relayerKey).address;
  if (buyer === seller || buyer === relayer)
    throw new LiveConfigError("Buyer must differ from seller and relayer");
  const rpcUrl = env.BASE_RPC_URL;
  let validRpc = false;
  try {
    validRpc = Boolean(rpcUrl) && new URL(rpcUrl!).protocol === "https:";
  } catch {
    /* Never expose URL parser errors: the input can contain a provider key. */
  }
  if (!validRpc || !rpcUrl)
    throw new LiveConfigError("Live mode requires an HTTPS Base RPC");
  const amountText = env.LIVE_DEMO_USDC_AMOUNT;
  if (!amountText || !/^\d+(\.\d{1,6})?$/.test(amountText))
    throw new LiveConfigError(
      "Set LIVE_DEMO_USDC_AMOUNT, with at most six decimals",
    );
  const amount = parseUnits(amountText, 6);
  if (amount <= 0n || amount > 10_000_000n)
    throw new LiveConfigError(
      "Live demo amount must be greater than zero and at most 10 USDC",
    );
  const stateDir = env.LIVE_DEMO_STATE_DIR;
  const privateRoot = path.join(repoRoot, "private-data");
  if (
    !stateDir ||
    !path.isAbsolute(stateDir) ||
    !path.resolve(stateDir).startsWith(privateRoot + path.sep)
  )
    throw new LiveConfigError(
      "LIVE_DEMO_STATE_DIR must be a new absolute directory inside this repo's private-data directory",
    );
  if (deployment.chainId !== 8453 || deployment.network !== "base")
    throw new LiveConfigError("Deployment manifest must target Base mainnet");
  return {
    rpcUrl,
    sellerKey,
    buyerKey,
    relayerKey,
    seller,
    buyer,
    relayer,
    amount,
    stateDir: path.resolve(stateDir),
  };
}

export type LiveConfig = ReturnType<typeof readLiveConfig>;

/** Fail closed across concurrent/partial runs; caller releases on success or a safe story cancellation. */
export async function acquireLiveRunLock(
  root = repoRoot,
): Promise<() => Promise<void>> {
  const directory = path.join(root, "private-data");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, "live-demo.lock");
  try {
    await writeFile(
      lock,
      JSON.stringify({
        startedAt: new Date().toISOString(),
        pid: process.pid,
        note: "Do not remove until any live transactions and evidence have been reconciled",
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new LiveConfigError(
        "private-data/live-demo.lock exists from an earlier incomplete run. Reconcile its transactions (transactions.jsonl in that run's LIVE_DEMO_STATE_DIR, and the wallets on Basescan), then delete the lock and retry",
      );
    throw error;
  }
  return () => unlink(lock);
}

/** Error class names only (e.g. viem's HttpRequestError); messages may contain RPC URLs or calldata. */
function safeErrorName(error: unknown): string | undefined {
  const name = error instanceof Error ? error.name : undefined;
  return name && /^[A-Za-z]{1,64}$/.test(name) ? name : undefined;
}

/** Credential-free description of an unexpected error: known RPC conditions, else the error type. */
export function describeSafeCause(error: unknown): string | undefined {
  let cause: unknown = error;
  for (let depth = 0; cause && depth < 10; depth++) {
    const { status, code } = cause as { status?: unknown; code?: unknown };
    if (status === 429 || code === 429 || code === -32016 || code === -32005)
      return "BASE_RPC_URL is rate-limiting requests (HTTP 429 / over rate limit). Use a dedicated Base RPC; shared public endpoints throttle this flow";
    cause = (cause as { cause?: unknown }).cause;
  }
  const name = safeErrorName(error);
  return name && `Cause (error type only): ${name}`;
}
