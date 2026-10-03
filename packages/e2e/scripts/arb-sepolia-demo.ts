/**
 * Purchase-to-redemption against a live chain, driven entirely by environment.
 *
 * Unlike `connected-demo`, this boots no fixture and deploys nothing: the contracts, the
 * listing and the funded buyer must already exist on the configured chain, and the three
 * services must already be running. It exists because every other entry point in this repo
 * is pinned to a Base fork or to the live Base manifest.
 *
 *   npm run facilitator
 *   npm run resource-server
 *   npm run redemption-server
 *   npm run demo:arb-sepolia
 *
 * Authentication is the explicitly labelled mock wallet seam: it proves control of the
 * wallet that paid. It is not World ID and resolves no AgentBook registration.
 *
 * The redemption bundle is a secret. It is never printed here, and must never be added to
 * the output of this script.
 */

import { payAndFetch, PaymentRefused } from "@nota/client";
import { redeemWithMockAgent } from "../../resource-server/src/redemption/client.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Address, Hex } from "viem";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function address(name: string): Address {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} is not an address`);
  return value as Address;
}

async function main() {
  const rpcUrl = required("RPC_URL");
  const chainId = Number(required("CHAIN_ID"));
  const resourceUrl = required("RESOURCE_URL");
  const redemptionBaseUrl = required("REDEMPTION_BASE_URL");

  const store = address("NOTA_RECEIPT_STORE");
  const settlementToken = address("SETTLEMENT_TOKEN");
  const purchaseRefRegistry = address("PURCHASE_REF_REGISTRY");
  const adapter = address("NOTA_X402_ADAPTER");
  const redemptionContract = address("ENTITLEMENT_REDEMPTION");

  const buyerKey = required("BUYER_PRIVATE_KEY") as Hex;
  const maxAmount = BigInt(process.env.MAX_AMOUNT ?? "1000000");

  const buyer = privateKeyToAccount(buyerKey);

  // Everything the agent will check the 402 against. Configured here, never taken from the
  // response: a hostile endpoint can sign its own quote over its own document naming its own
  // adapter, and satisfy every internal-consistency check in the process.
  const trusted = {
    chainId,
    store,
    settlementToken,
    purchaseRefRegistry,
    adapters: [adapter],
  };

  console.info(`chain ${chainId}  buyer ${buyer.address}`);
  console.info(`store ${store}\nadapter ${adapter}\nredemption ${redemptionContract}\n`);

  // ---- 1. Discover the price, verify it, pay it, and collect the content ----

  console.info("1. purchase");
  const paid = await payAndFetch(resourceUrl, {
    rpcUrl,
    chainId,
    privateKey: buyerKey,
    maxAmount,
    trusted,
  });

  if (!paid.entitlement) throw new Error("no entitlement returned from checkout");

  const purchaseTxHash = paid.receipt.txHash;
  console.info(`   settled in ${purchaseTxHash}`);
  console.info(`   purchaseRef ${paid.receipt.purchaseRef ?? "(see settlement response)"}`);
  console.info(`   resource: ${paid.resource}\n`);

  // The bundle travels in this object. It is not logged.
  const input = {
    listingId: paid.entitlement.listingId,
    purchaseTxHash,
    rawPurchaseRef: paid.entitlement.rawPurchaseRef,
    purchaseRefNonce: paid.entitlement.purchaseRefNonce,
  };

  const context = { chainId, redemptionContract };

  // ---- 2. Someone else, holding the correct bundle ----
  //
  // Before the legitimate redemption, so a rejection here cannot be confused with a
  // rejection for already having been redeemed. This wallet is generated fresh, holds
  // nothing, and only ever signs a message.

  console.info("2. redemption attempt by a different wallet, with the correct bundle");
  const attacker = privateKeyToAccount(generatePrivateKey());
  const denied = await redeemWithMockAgent(redemptionBaseUrl, attacker, input, context);
  const denial = (await denied.json()) as { code?: string; step?: number };
  console.info(`   HTTP ${denied.status}  ${denial.code ?? ""}  step ${denial.step ?? "-"}`);
  if (denied.status !== 403) throw new Error(`expected 403, got ${denied.status}`);
  console.info("   rejected, and no transaction was sent\n");

  // ---- 3. The wallet that actually paid ----

  console.info("3. redemption by the paying wallet");
  const accepted = await redeemWithMockAgent(redemptionBaseUrl, buyer, input, context);
  const result = (await accepted.json()) as {
    purchaseRef?: string;
    transactionHash?: string;
    redeemedAt?: number;
  };
  console.info(`   HTTP ${accepted.status}`);
  if (accepted.status !== 201) throw new Error(`expected 201, got ${accepted.status}`);
  console.info(`   purchaseRef  ${result.purchaseRef}`);
  console.info(`   redeemed in  ${result.transactionHash}`);
  console.info(`   redeemedAt   ${result.redeemedAt}`);
  console.info("   EntitlementRedeemed emitted\n");

  // ---- 4. The same wallet, the same bundle, again ----

  console.info("4. the same wallet redeeming the same entitlement again");
  const replay = await redeemWithMockAgent(redemptionBaseUrl, buyer, input, context);
  const replayed = (await replay.json()) as { code?: string; step?: number };
  console.info(`   HTTP ${replay.status}  ${replayed.code ?? ""}  step ${replayed.step ?? "-"}`);
  if (replay.status !== 409) throw new Error(`expected 409, got ${replay.status}`);
  console.info("   rejected, and no second transaction was sent\n");

  console.info("PASS. Paid once, redeemed once, by the paying wallet only.");
  console.info(`redemption tx: ${result.transactionHash}`);
}

main().catch((error) => {
  if (error instanceof PaymentRefused) {
    console.error(`agent refused to pay: ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
