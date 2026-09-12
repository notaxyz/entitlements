import { existsSync } from "node:fs";
import path from "node:path";
import {
  LiveConfigError,
  readLiveConfig,
  repoRoot,
  describeSafeCause,
} from "../src/live-config.js";
import { preflightLive } from "../src/live-fixture.js";

// Read-only live-demo readiness check: no confirmation, no lock, no transactions, no files written.
async function main() {
  const config = readLiveConfig(process.env);
  const lockExists = existsSync(path.join(repoRoot, "private-data", "live-demo.lock"));
  await preflightLive(config);
  console.info(
    JSON.stringify({
      preflight: "PASS",
      seller: config.seller,
      buyer: config.buyer,
      relayer: config.relayer,
      amountUSDCBaseUnits: config.amount.toString(),
    }),
  );
  if (lockExists) {
    console.error(
      "BLOCKED: private-data/live-demo.lock exists from an earlier incomplete run. Reconcile it, then delete the lock before `npm run demo:connected -- --live`.",
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  if (error instanceof LiveConfigError) console.error(error.message);
  else if (describeSafeCause(error)) console.error(describeSafeCause(error));
  console.error(
    "Live preflight failed. Nothing was sent. Keys and provider details suppressed.",
  );
  process.exitCode = 1;
});
