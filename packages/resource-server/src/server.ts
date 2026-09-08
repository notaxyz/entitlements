import type { Address, Hex } from "viem";

import { createResourceServer } from "./index.js";

const port = Number(process.env.RESOURCE_PORT ?? 4020);

createResourceServer({
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  chainId: Number(process.env.CHAIN_ID ?? 8453),
  store: process.env.NOTA_RECEIPT_STORE as Address,
  settlementToken: process.env.SETTLEMENT_TOKEN as Address,
  purchaseRefRegistry: process.env.PURCHASE_REF_REGISTRY as Address,
  adapter: process.env.NOTA_X402_ADAPTER as Address,
  facilitatorUrl: process.env.FACILITATOR_URL ?? "http://127.0.0.1:4021",
  sellerPrivateKey: process.env.SELLER_PRIVATE_KEY as Hex,
  listingId: BigInt(process.env.LISTING_ID ?? "1"),
  baseUrl: process.env.RESOURCE_BASE_URL ?? `http://127.0.0.1:${port}`,
  fromBlock: BigInt(process.env.FROM_BLOCK ?? "0"),
}).listen(port, () => {
  console.log(`resource server listening on http://127.0.0.1:${port}`);
});
