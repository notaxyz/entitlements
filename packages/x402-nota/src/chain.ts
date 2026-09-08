import { defineChain, type Chain } from "viem";

/**
 * Base mainnet, or an anvil fork of it. The fork keeps chain id 8453, so the same definition
 * serves both and nothing in this stack has to branch on which one it is talking to.
 */
export function notaChain(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: chainId === 8453 ? "Base" : `Chain ${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
