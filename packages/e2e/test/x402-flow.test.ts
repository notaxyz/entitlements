import { payAndFetch, PaymentRefused, refetchPaidResource } from "@nota/client";
import {
  baseDeployment,
  NOTA_EXTENSION_KIND,
  NOTA_SCHEME,
  notaReceiptStoreAbi,
  NOTA_RECEIPT_STORE,
  requireNotaExtension,
  type PaymentRequiredResponse,
} from "@nota/x402-nota";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { baseRpcUrl, startFixture, type Fixture } from "../src/fixture.js";

const RESOURCE_PRICE = 10_000_000n;

const describeFork = baseRpcUrl() ? describe : describe.skip;

describeFork("x402 → Nota settlement, end to end on a Base fork", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  });

  afterAll(async () => {
    await fixture?.stop();
  });

  function agentConfig(overrides: Partial<Parameters<typeof payAndFetch>[1]> = {}) {
    return {
      rpcUrl: fixture.rpcUrl,
      chainId: fixture.chainId,
      privateKey: fixture.buyerPrivateKey,
      maxAmount: 50_000_000n,
      // Configured out of band. Nothing the server says can widen it.
      trusted: baseDeployment([fixture.adapter]),
      logger: { info: () => {}, warn: () => {} },
      ...overrides,
    };
  }

  it("discovers, verifies, pays gaslessly, and receives the resource", async () => {
    const buyerBefore = await fixture.usdcBalance(fixture.buyer);
    const sellerBefore = await fixture.usdcBalance(fixture.seller);
    // The buyer was never funded with ETH at all.
    expect(await fixture.publicClient.getBalance({ address: fixture.buyer })).toBe(0n);

    const paid = await payAndFetch<{ report: string }>(fixture.resourceUrl, agentConfig());

    expect(paid.content.report).toBe("base-usdc-flows-2026-09");
    expect(paid.resource).toBe(fixture.resourceUrl);
    expect(paid.receipt.purchaseRef).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(paid.receipt.amount)).toBe(RESOURCE_PRICE);
    expect(paid.receipt.seller.toLowerCase()).toBe(fixture.seller.toLowerCase());
    expect(paid.receipt.buyer.toLowerCase()).toBe(fixture.buyer.toLowerCase());
    expect(BigInt(paid.receipt.listingId)).toBe(fixture.listingId);

    // The money moved.
    expect(await fixture.usdcBalance(fixture.buyer)).toBe(buyerBefore - RESOURCE_PRICE);
    expect(await fixture.usdcBalance(fixture.seller)).toBe(sellerBefore + RESOURCE_PRICE);
    expect(await fixture.usdcBalance(fixture.adapter)).toBe(0n);

    // The point of the whole path: the buyer paid 10 USDC while holding zero ETH, because it
    // never sent a transaction.
    expect(await fixture.publicClient.getBalance({ address: fixture.buyer })).toBe(0n);
  });

  it("hands the redemption credential over with the paid resource, and only then", async () => {
    const paid = await payAndFetch<{ report: string }>(fixture.resourceUrl, agentConfig());

    // The buyer now holds the bundle. This is the one channel that carries it: after settlement,
    // in the paid response, to the payer that funded it.
    expect(paid.entitlement).toBeDefined();
    expect(paid.entitlement!.purchaseRefNonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(paid.entitlement!.rawPurchaseRef).toMatch(/^nota_x402_[0-9a-f]+$/);

    // And it is the real redemption preimage, not a decorative echo: the deployed store
    // reconstructs the settled purchaseRef from it. This is what EntitlementRedemption will be
    // handed at redemption time.
    const reconstructed = await fixture.publicClient.readContract({
      address: NOTA_RECEIPT_STORE,
      abi: notaReceiptStoreAbi,
      functionName: "hashPurchaseRef",
      args: [
        fixture.seller,
        BigInt(paid.entitlement!.listingId),
        paid.entitlement!.rawPurchaseRef,
        paid.entitlement!.purchaseRefNonce,
      ],
    });

    expect(reconstructed).toBe(paid.receipt.purchaseRef);
  });

  it("refuses an anonymous request that merely names the public purchase reference", async () => {
    const paid = await payAndFetch<{ report: string }>(fixture.resourceUrl, agentConfig());

    // purchaseRef is published in the 402 response and again in the settlement event, so anyone
    // can name it. Naming it must not be enough to obtain the content or the credential.
    const anonymous = await fetch(fixture.resourceUrl, {
      headers: {
        "x-payment": Buffer.from(
          JSON.stringify({
            x402Version: 1,
            scheme: NOTA_SCHEME,
            network: "base",
            payload: {
              kind: NOTA_EXTENSION_KIND,
              purchaseRef: paid.receipt.purchaseRef,
              adapter: fixture.adapter,
            },
          }),
          "utf8",
        ).toString("base64"),
      },
    });

    expect(anonymous.status).toBe(401);
    const body = await anonymous.text();
    expect(body).not.toMatch(/purchaseRefNonce/i);
    expect(body).not.toMatch(/netInflowUsd/);
  });

  it("refuses a challenge answered by a wallet that did not pay", async () => {
    const paid = await payAndFetch<{ report: string }>(fixture.resourceUrl, agentConfig());

    await expect(
      refetchPaidResource(
        fixture.resourceUrl,
        paid.receipt.purchaseRef,
        fixture.adapter,
        agentConfig({ privateKey: fixture.intruderPrivateKey }),
      ),
    ).rejects.toThrow(/challenge names .*, not this agent|401/);
  });

  it("lets the buyer re-read a resource it already paid for", async () => {
    const paid = await payAndFetch<{ report: string }>(fixture.resourceUrl, agentConfig());

    const again = await refetchPaidResource<{ report: string }>(
      fixture.resourceUrl,
      paid.receipt.purchaseRef,
      fixture.adapter,
      agentConfig(),
    );

    expect(again.content.report).toBe("base-usdc-flows-2026-09");
    expect(again.entitlement?.purchaseRefNonce).toBe(paid.entitlement?.purchaseRefNonce);
  });

  it("refuses an adapter the agent does not trust, however consistent the response is", async () => {
    // A hostile endpoint can serve internally consistent metadata whose hash matches its own
    // quote. What it cannot do is make the agent authorize payment to a contract it was never
    // configured to trust.
    const hostileAdapter = "0x00000000000000000000000000000000BaDaDa97";
    const swapAdapterFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input as string, init);
      if (response.status !== 402) return response;

      const body = (await response.json()) as PaymentRequiredResponse;
      const extension = body.extensions[NOTA_EXTENSION_KIND];
      if (extension) extension.adapter = hostileAdapter;

      return new Response(JSON.stringify(body), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    };

    const refusal = payAndFetch(fixture.resourceUrl, agentConfig({ fetchImpl: swapAdapterFetch }));

    await expect(refusal).rejects.toBeInstanceOf(PaymentRefused);
    await expect(refusal).rejects.toThrow(/not one this agent will authorize payment to/);
  });

  it("refuses a quote whose seller signature the trusted store rejects", async () => {
    // Hash consistency says nothing about who signed. Only the store can answer that.
    const forgeSignatureFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input as string, init);
      if (response.status !== 402) return response;

      const body = (await response.json()) as PaymentRequiredResponse;
      const extension = body.extensions[NOTA_EXTENSION_KIND];
      if (extension) extension.sellerSignature = `0x${"11".repeat(65)}`;

      return new Response(JSON.stringify(body), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      payAndFetch(fixture.resourceUrl, agentConfig({ fetchImpl: forgeSignatureFetch })),
    ).rejects.toThrow(/rejected by the trusted store/);
  });

  it("still serves a paid purchase after the server restarts", async () => {
    const paid = await payAndFetch<{ report: string }>(fixture.resourceUrl, agentConfig());

    // Settlement is irreversible. If the quote and its credential only existed in memory, a
    // restart would strand a purchase the buyer has already paid for.
    await fixture.restartResourceServer();

    const again = await refetchPaidResource<{ report: string }>(
      fixture.resourceUrl,
      paid.receipt.purchaseRef,
      fixture.adapter,
      agentConfig(),
    );

    expect(again.content.report).toBe("base-usdc-flows-2026-09");
    expect(again.entitlement?.purchaseRefNonce).toBe(paid.entitlement?.purchaseRefNonce);
  });

  it("refuses to pay when the metadata document does not match the commitment", async () => {
    // Stands in for a server, proxy, or middlebox that alters the itemisation after the seller
    // signed it. The signature still verifies on chain; the document no longer describes it.
    const tamperingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input as string, init);

      if (response.status !== 402) return response;

      const body = (await response.json()) as PaymentRequiredResponse;
      const extension = body.extensions[NOTA_EXTENSION_KIND];

      if (extension?.metadata.document) {
        extension.metadata.document.items = [
          { sku: "swapped", name: "Something cheaper", quantity: 1, unitAmount: "1" },
        ];
        extension.metadata.document.totalAmount = "1";
      }

      return new Response(JSON.stringify(body), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    };

    const refusal = payAndFetch(
      fixture.resourceUrl,
      agentConfig({ fetchImpl: tamperingFetch }),
    );

    await expect(refusal).rejects.toBeInstanceOf(PaymentRefused);
    await expect(refusal).rejects.toThrow(/does not match the seller's commitment/);
  });

  it("refuses a quote bound to a different buyer", async () => {
    const rebindingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input as string, init);

      if (response.status !== 402) return response;

      const body = (await response.json()) as PaymentRequiredResponse;
      const extension = body.extensions[NOTA_EXTENSION_KIND];

      if (extension) {
        extension.quote.buyer = "0x000000000000000000000000000000000000dEaD";
      }

      return new Response(JSON.stringify(body), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(
      payAndFetch(fixture.resourceUrl, agentConfig({ fetchImpl: rebindingFetch })),
    ).rejects.toThrow(/not to this agent/);
  });

  it("never puts the redemption credential in the 402 response", async () => {
    const response = await fetch(fixture.resourceUrl, { headers: { "x-payer": fixture.buyer } });
    const raw = await response.text();
    const body = JSON.parse(raw) as PaymentRequiredResponse;
    const extension = requireNotaExtension(body);

    expect(response.status).toBe(402);
    expect(raw).not.toMatch(/purchaseRefNonce/i);
    expect(raw).not.toMatch(/rawPurchaseRef/i);
    expect(JSON.stringify(extension.metadata.document)).not.toMatch(/nonce/i);

    // Only the hash of the bundle is ever published before payment.
    expect(extension.quote.purchaseRef).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("withholds the resource when no settlement exists for the purchase reference", async () => {
    const response = await fetch(fixture.resourceUrl, {
      headers: {
        "x-payer": fixture.buyer,
        "x-payment": Buffer.from(
          JSON.stringify({
            x402Version: 1,
            scheme: NOTA_SCHEME,
            network: "base",
            payload: {
              kind: NOTA_EXTENSION_KIND,
              purchaseRef: `0x${"ab".repeat(32)}`,
              adapter: fixture.adapter,
              txHash: `0x${"cd".repeat(32)}`,
            },
          }),
          "utf8",
        ).toString("base64"),
      },
    });

    expect(response.status).toBe(402);
  });
});
