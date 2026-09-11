import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex, type Hex } from "viem";
import {
  NOTA_EXTENSION_KIND,
  type PaymentRequiredResponse,
} from "@nota/x402-nota";
import {
  createResourceServer,
  type ResourceServerConfig,
} from "../src/index.js";
import {
  configuredQuoteStore,
  fileQuoteStore,
  memoryQuoteStore,
  type QuoteStore,
} from "../src/store.js";

// These tests isolate persistence at the HTTP boundary. They do not claim chain compatibility.
vi.mock("viem", async (importOriginal) => {
  const real = await importOriginal<typeof import("viem")>();
  return {
    ...real,
    createPublicClient: () => ({
      readContract: async ({ args }: { args: unknown[] }) =>
        real.keccak256(
          real.toHex(
            JSON.stringify(args, (_, value) =>
              typeof value === "bigint" ? value.toString() : value,
            ),
          ),
        ),
      getBlock: async () => ({ timestamp: 1000n }),
    }),
  };
});

const servers: Server[] = [];
const directories: string[] = [];
const buyer = "0x1111111111111111111111111111111111111111";
const config: ResourceServerConfig = {
  rpcUrl: "http://127.0.0.1:1",
  chainId: 8453,
  store: "0x2222222222222222222222222222222222222222",
  settlementToken: "0x3333333333333333333333333333333333333333",
  purchaseRefRegistry: "0x4444444444444444444444444444444444444444",
  adapter: "0x5555555555555555555555555555555555555555",
  facilitatorUrl: "http://localhost:4021",
  sellerPrivateKey: keccak256(toHex("persistence-test-seller")),
  listingId: 1n,
  baseUrl: "http://localhost:4020",
  fromBlock: 0n,
};

async function serve(quoteStore: QuoteStore) {
  const server = createServer(createResourceServer({ ...config, quoteStore }));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    checkout: (body: string, payer = buyer) => fetch(`${url}/reports/base-usdc-flows-2026-09`, {
      method: "POST", headers: { "x-payer": payer, "content-type": "application/json" }, body,
    }),
    issue: () =>
      fetch(`${url}/reports/base-usdc-flows-2026-09`, {
        headers: { "x-payer": buyer },
      }),
    challenge: (purchaseRef: Hex) =>
      fetch(`${url}/access/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ purchaseRef }),
      }),
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      servers.splice(servers.indexOf(server), 1);
    },
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("resource-server issued-order persistence", () => {
  it("persists the supplied buyer bundle without exposing it in the signed 402", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "nota-buyer-checkout-"));
    directories.push(directory);
    const filename = path.join(directory, "issued-orders.json");
    const server = await serve(fileQuoteStore(filename));
    const bundle = { rawPurchaseRef: "buyer-created-order", purchaseRefNonce: keccak256(toHex("buyer-created-nonce")) };
    const response = await server.checkout(JSON.stringify(bundle));
    expect(response.status).toBe(402);
    const text = await response.text();
    expect(text).not.toContain(bundle.rawPurchaseRef);
    expect(text).not.toContain(bundle.purchaseRefNonce);
    const quote = JSON.parse(text).extensions[NOTA_EXTENSION_KIND].quote;
    const record = await fileQuoteStore(filename).get(quote.purchaseRef);
    expect(record).toMatchObject({ ...bundle, bundleSource: "buyer" });
    expect(quote.buyer).toBe(buyer);
    await server.stop();
    const restarted = await serve(fileQuoteStore(filename));
    expect((await restarted.challenge(quote.purchaseRef)).status).toBe(200);
  });

  it("rejects invalid or malformed private bodies without fallback, persistence, or secret logging", async () => {
    const store = memoryQuoteStore();
    const put = vi.spyOn(store, "put");
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await serve(store);
    const nonce = keccak256(toHex("must-not-leak"));
    const cases = [JSON.stringify({ rawPurchaseRef: "", purchaseRefNonce: nonce }),
      JSON.stringify({ rawPurchaseRef: "private-ref", purchaseRefNonce: "0x00" }),
      JSON.stringify({ rawPurchaseRef: "private-ref", purchaseRefNonce: `0x${"00".repeat(32)}` }),
      JSON.stringify({ rawPurchaseRef: "private-ref", purchaseRefNonce: nonce, extra: true }),
      `{"rawPurchaseRef":"private-ref","purchaseRefNonce":"${nonce}" broken}`];
    for (const body of cases) {
      const response = await server.checkout(body);
      expect(response.status).toBe(400);
      const output = await response.text();
      expect(output).not.toContain(nonce);
      expect(output).not.toContain("private-ref");
    }
    expect((await server.checkout(JSON.stringify({ rawPurchaseRef: "private-ref", purchaseRefNonce: nonce }), "invalid")).status).toBe(400);
    expect(put).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.mock.calls)).not.toContain(nonce);
    expect(JSON.stringify(logger.mock.calls)).not.toContain("private-ref");
  });

  it("cannot rebind an existing buyer's order by submitting its bundle with another payer", async () => {
    const store = memoryQuoteStore();
    const server = await serve(store);
    const body = JSON.stringify({ rawPurchaseRef: "buyer-original", purchaseRefNonce: keccak256(toHex("original-nonce")) });
    const first = await server.checkout(body);
    expect(first.status).toBe(402);
    const quote = ((await first.json()) as PaymentRequiredResponse).extensions[NOTA_EXTENSION_KIND]!.quote;
    const attack = await server.checkout(body, "0x9999999999999999999999999999999999999999");
    expect(attack.status).toBe(500);
    expect((await store.get(quote.purchaseRef))?.quote.buyer).toBe(buyer);
  });

  it("persists every concurrent HTTP quote and restores access challenges after server restart", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "nota-resource-persistence-"),
    );
    directories.push(directory);
    const filename = path.join(directory, "issued-orders.json");
    const first = await serve(configuredQuoteStore(filename));
    const quotes = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const response = await first.issue();
        expect(response.status).toBe(402);
        const body = (await response.json()) as PaymentRequiredResponse;
        return body.extensions[NOTA_EXTENSION_KIND]!.quote;
      }),
    );
    expect(new Set(quotes.map((quote) => quote.purchaseRef)).size).toBe(10);
    await first.stop();
    const restarted = await serve(configuredQuoteStore(filename));
    for (const quote of quotes) {
      const record = await fileQuoteStore(filename).get(quote.purchaseRef);
      expect(record?.quote).toEqual(quote);
      const challenge = await restarted.challenge(quote.purchaseRef);
      expect(challenge.status).toBe(200);
      const body = await challenge.text();
      expect(JSON.parse(body)).toMatchObject({
        purchaseRef: quote.purchaseRef,
        buyer,
      });
      expect(body).not.toContain(record!.rawPurchaseRef);
      expect(body).not.toContain(record!.purchaseRefNonce);
    }
  });

  it("does not hand out the signed quote before persistence succeeds", async () => {
    const store = memoryQuoteStore();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(store, "put").mockImplementation(async () => {
      started();
      await pending;
    });
    const server = await serve(store);
    let responded = false;
    const request = server.issue().then((response) => {
      responded = true;
      return response;
    });
    try {
      await reached;
      expect(responded).toBe(false);
    } finally {
      release();
    }
    expect((await request).status).toBe(402);
  });

  it("does not hand out a quote or leak its bundle when saving fails", async () => {
    const store = memoryQuoteStore();
    let secrets: string[] = [];
    vi.spyOn(store, "put").mockImplementation(async (record) => {
      secrets = [record.rawPurchaseRef, record.purchaseRefNonce];
      throw new Error(secrets.join(" "));
    });
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await serve(store);
    const response = await server.issue();
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "could not issue a quote" });
    expect(secrets).toHaveLength(2);
    for (const secret of secrets)
      expect(body + JSON.stringify(logger.mock.calls)).not.toContain(secret);
  });

  it("handles failed reads with a sanitized 503 rather than an unhandled async rejection", async () => {
    const store = memoryQuoteStore();
    vi.spyOn(store, "get").mockRejectedValue(
      new Error("PRIVATE_BUNDLE_FROM_CORRUPT_JSON"),
    );
    const server = await serve(store);
    const response = await server.challenge(keccak256(toHex("reference")));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "could not safely process the request",
    });
  });
});
