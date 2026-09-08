import { payAndFetch, PaymentRefused } from "@nota/client";
import {
  NOTA_EXTENSION_KIND,
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

  it("serves the resource again for the same settled purchase reference", async () => {
    const first = await payAndFetch<{ report: string }>(fixture.resourceUrl, agentConfig());
    const replay = await fetch(fixture.resourceUrl, {
      headers: {
        "x-payer": fixture.buyer,
        "x-payment": Buffer.from(
          JSON.stringify({
            x402Version: 1,
            scheme: "exact",
            network: "base",
            payload: {
              kind: NOTA_EXTENSION_KIND,
              purchaseRef: first.receipt.purchaseRef,
              adapter: fixture.adapter,
            },
          }),
          "utf8",
        ).toString("base64"),
      },
    });

    expect(replay.status).toBe(200);
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
            scheme: "exact",
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
