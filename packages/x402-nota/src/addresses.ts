import type { Address } from "viem";

/// Base mainnet deployment the whole x402 path targets. No other chain is supported here.
export const BASE_CHAIN_ID = 8453;

export const NOTA_RECEIPT_STORE: Address = "0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88";
export const PURCHASE_REF_REGISTRY: Address = "0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991";
export const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/// The x402 `network` identifier for Base mainnet.
export const NETWORK = "base" as const;

/**
 * The payment scheme this stack implements.
 *
 * Deliberately NOT `exact`. The flow here does not match the registered `exact` semantics: the
 * payload a client returns is a reference to an already-settled on-chain receipt rather than a
 * transfer authorization for a facilitator to execute, and funds reach the seller through the
 * Nota adapter rather than directly. Advertising `exact` would invite a generic x402 client to
 * try, and fail, to settle it. Naming it separately makes the mechanism explicit.
 */
export const NOTA_SCHEME = "nota-exact" as const;
