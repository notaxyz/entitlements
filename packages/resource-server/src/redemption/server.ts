import type { Hex } from "viem";
import { MockAgentAuthorizer } from "./authorizer.js";
import { createRedemptionApp } from "./app.js";
import { ChainIdMismatchError, ViemRedemptionChain } from "./chain.js";
import { requireAddress } from "./types.js";
import { configuredQuoteStore } from "../store.js";

async function main() {
  const quoteStore = configuredQuoteStore(process.env.QUOTE_STORE_PATH);
  // No silent downgrade when World is unavailable. Mock operation is an explicit opt-in.
  if (process.env.AGENT_AUTH_MODE !== "mock")
    throw new Error(
      "World integration is unavailable; explicitly select mock mode for development",
    );
  if (process.env.NODE_ENV === "production")
    throw new Error("Mock agent authentication is disabled in production");
  const port = Number(process.env.REDEMPTION_PORT ?? 4022);
  const baseUrl = new URL(
    process.env.REDEMPTION_BASE_URL ?? `http://127.0.0.1:${port}`,
  );
  if (
    baseUrl.protocol !== "https:" &&
    !["127.0.0.1", "localhost"].includes(baseUrl.hostname)
  )
    throw new Error("Use HTTPS outside localhost");
  const redemption = requireAddress(process.env.ENTITLEMENT_REDEMPTION);
  const chainId = Number(process.env.CHAIN_ID ?? 8453);
  const chain = await ViemRedemptionChain.connect({
    rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
    chainId,
    store: requireAddress(process.env.NOTA_RECEIPT_STORE),
    redemption,
    adapters: (process.env.REDEMPTION_ADAPTERS ?? "")
      .split(",")
      .filter(Boolean)
      .map((item) => requireAddress(item.trim())),
    sellerPrivateKey: process.env.SELLER_PRIVATE_KEY as Hex,
    confirmations: Number(process.env.REDEMPTION_CONFIRMATIONS ?? 2),
  });
  const authorizer = new MockAgentAuthorizer({
    resource: new URL("/v1/redemptions", baseUrl).href,
    chainId,
    redemptionContract: redemption,
  });
  createRedemptionApp({
    authorizer,
    mockChallenges: authorizer,
    chain,
    quoteStore,
  }).listen(
    port,
    "127.0.0.1",
    () => {
      console.info(
        JSON.stringify({
          event: "redemption.started",
          port,
          chainId: chain.connectedChainId,
          authentication: "mock-wallet",
          humanVerified: false,
        }),
      );
    },
  );
}

main().catch((error: unknown) => {
  // Two chain IDs are safe to print; report them so a wrong RPC_URL or CHAIN_ID is self-evident.
  if (error instanceof ChainIdMismatchError) {
    console.error(
      JSON.stringify({
        event: "redemption.startup_failed",
        code: "CHAIN_ID_MISMATCH",
        expectedChainId: error.expectedChainId,
        rpcChainId: error.rpcChainId,
      }),
    );
    process.exitCode = 1;
    return;
  }
  // Configuration/RPC exceptions can contain private keys, URLs with credentials, or calldata.
  console.error(
    "Redemption startup failed. Check QUOTE_STORE_PATH, explicit mock mode, non-production environment, RPC_URL and CHAIN_ID (default 8453), and deployment configuration. No sensitive diagnostic data was logged.",
  );
  process.exitCode = 1;
});
