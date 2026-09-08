import { createFacilitator } from "./index.js";
import type { Address, Hex } from "viem";

const port = Number(process.env.FACILITATOR_PORT ?? 4021);
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const chainId = Number(process.env.CHAIN_ID ?? 8453);
const privateKey = process.env.FACILITATOR_PRIVATE_KEY as Hex | undefined;
const adapter = process.env.NOTA_X402_ADAPTER as Address | undefined;

if (!privateKey) throw new Error("FACILITATOR_PRIVATE_KEY is required");
if (!adapter) throw new Error("NOTA_X402_ADAPTER is required");

createFacilitator({ rpcUrl, chainId, privateKey, allowedAdapters: [adapter] }).listen(port, () => {
  console.log(`facilitator listening on http://127.0.0.1:${port} (adapter ${adapter})`);
});
