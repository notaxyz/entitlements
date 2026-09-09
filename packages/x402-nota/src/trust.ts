import { isAddressEqual, type Address } from "viem";

import { BASE_CHAIN_ID, NOTA_RECEIPT_STORE, PURCHASE_REF_REGISTRY, USDC } from "./addresses.js";
import type { NotaExtension } from "./types.js";

/**
 * What an agent believes Nota's deployment to be, independent of anything a server tells it.
 *
 * Without this the 402 response is self-certifying: a hostile endpoint can serve internally
 * consistent metadata whose hash matches its own quote, name an adapter it controls, and collect
 * an authorization the buyer signed in good faith. Every address the buyer commits value to has
 * to come from here, not from the response.
 */
export interface TrustedDeployment {
  chainId: number;
  store: Address;
  settlementToken: Address;
  purchaseRefRegistry: Address;
  /// Adapters this agent will authorize payment to. Empty means it will pay nobody.
  adapters: Address[];
}

/// Base mainnet's deployed store, token and registry. Adapters are per-deployment, so the caller
/// supplies them; an agent that names none cannot be talked into paying one.
export function baseDeployment(adapters: Address[]): TrustedDeployment {
  return {
    chainId: BASE_CHAIN_ID,
    store: NOTA_RECEIPT_STORE,
    settlementToken: USDC,
    purchaseRefRegistry: PURCHASE_REF_REGISTRY,
    adapters,
  };
}

/// Compares what the 402 asserts against what the agent independently trusts.
export function checkTrustedDeployment(
  extension: NotaExtension,
  trusted: TrustedDeployment,
): string[] {
  const problems: string[] = [];

  if (extension.chainId !== trusted.chainId) {
    problems.push(`response is for chain ${extension.chainId}, agent trusts ${trusted.chainId}`);
  }
  if (!isAddressEqual(extension.store, trusted.store)) {
    problems.push(`response names store ${extension.store}, agent trusts ${trusted.store}`);
  }
  if (!isAddressEqual(extension.settlementToken, trusted.settlementToken)) {
    problems.push(
      `response names settlement token ${extension.settlementToken}, agent trusts ${trusted.settlementToken}`,
    );
  }
  if (!isAddressEqual(extension.purchaseRefRegistry, trusted.purchaseRefRegistry)) {
    problems.push(
      `response names registry ${extension.purchaseRefRegistry}, agent trusts ${trusted.purchaseRefRegistry}`,
    );
  }
  if (!trusted.adapters.some((adapter) => isAddressEqual(adapter, extension.adapter))) {
    problems.push(
      `response names adapter ${extension.adapter}, which is not one this agent will authorize payment to`,
    );
  }

  return problems;
}
