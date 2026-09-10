import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex, zeroAddress, zeroHash, type Address } from "viem";
import { memoryQuoteStore } from "../src/store.js";
import { issuedOrder } from "./issued-order.js";
import { privateKeyToAccount } from "viem/accounts";
import { MockAgentAuthorizer } from "../src/redemption/authorizer.js";
import {
  createRedemptionApp,
  type AuditRecord,
} from "../src/redemption/app.js";
import { redeemWithMockAgent } from "../src/redemption/client.js";
import type { RedemptionChain, Settlement } from "../src/redemption/chain.js";
import {
  parseInput,
  RedemptionError,
  type RedemptionInput,
} from "../src/redemption/types.js";

const buyer = privateKeyToAccount(
  keccak256(toHex("nota-redemption-unit:buyer")),
);
const attacker = privateKeyToAccount(
  keccak256(toHex("nota-redemption-unit:attacker")),
);
const seller = privateKeyToAccount(
  keccak256(toHex("nota-redemption-unit:seller")),
).address;
const store: Address = "0x1111111111111111111111111111111111111111";
const adapter: Address = "0x2222222222222222222222222222222222222222";
const redemption: Address = "0x3333333333333333333333333333333333333333";
const purchaseRef = keccak256(toHex("consumed test reference"));
const metadataHash = keccak256(toHex("expected metadata"));
const input: RedemptionInput = {
  listingId: "1",
  purchaseTxHash: keccak256(toHex("purchase transaction")),
  rawPurchaseRef: "UNIQUE_RAW_BUNDLE_MUST_NOT_BE_LOGGED",
  purchaseRefNonce: keccak256(toHex("UNIQUE_SECRET_NONCE")),
};
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  vi.restoreAllMocks();
});

async function fixture(kind: Settlement["kind"] = "X402ReceiptSettled") {
  const trace: string[] = [];
  const logs: AuditRecord[] = [];
  let redeemed = 0n;
  const quoteStore = memoryQuoteStore();
  await quoteStore.put(issuedOrder({
    purchaseRef, listingId: "1", buyer: buyer.address, amount: "1000000",
    metadataHash, agentId: zeroHash, integratorFeeRecipient: zeroAddress,
    integratorFeeAmount: "0", issuedAt: "1000", expiresAt: "2000",
  }, input.rawPurchaseRef, input.purchaseRefNonce));
  const chain: RedemptionChain = {
    seller,
    settlements: vi.fn(async () => {
      trace.push("2");
      return [
        {
          kind,
          emitter: kind === "ReceiptPurchasedV2" ? store : adapter,
          purchaseRef,
          seller,
          buyer: buyer.address,
          listingId: 1n,
          amount: 1_000_000n,
          metadataHash,
        },
      ];
    }),
    reconstruct: vi.fn(async (request) => {
      trace.push("3");
      return request.rawPurchaseRef === input.rawPurchaseRef &&
        request.purchaseRefNonce === input.purchaseRefNonce
        ? purchaseRef
        : keccak256(toHex("wrong bundle"));
    }),
    consumedBy: vi.fn(async () => {
      trace.push("4");
      return kind === "ReceiptPurchasedV2" ? store : adapter;
    }),
    redeemedAt: vi.fn(async () => {
      trace.push("5");
      return redeemed;
    }),
    submit: vi.fn(async () => {
      trace.push("7");
      redeemed = 1234n;
      return {
        transactionHash: keccak256(toHex("redemption transaction")),
        purchaseRef,
        seller,
        redeemedAt: "1234",
      };
    }),
  };
  // Bind a real port before constructing challenges so the origin is exact.
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  const url = `http://127.0.0.1:${address.port}`;
  const authorizer = new MockAgentAuthorizer({
    resource: `${url}/v1/redemptions`,
    chainId: 8453,
    redemptionContract: redemption,
  });
  const app = createRedemptionApp({
    quoteStore,
    chain,
    mockChallenges: authorizer,
    logger: (record) => logs.push(record),
    authorizer: {
      authorize: async (req) => {
        trace.push("1");
        return authorizer.authorize(req);
      },
    },
  });
  server.on("request", app);
  const redeem = (account = buyer, body = input) =>
    redeemWithMockAgent(url, account, body, {
      chainId: 8453,
      redemptionContract: redemption,
    });
  return { chain, authorizer, trace, logs, url, redeem, quoteStore };
}

describe("redemption endpoint — deterministic real EOA signatures, mock chain", () => {
  it.each(["ReceiptPurchasedV2", "X402ReceiptSettled"] as const)(
    "accepts buyer A through %s",
    async (kind) => {
      const f = await fixture(kind);
      const response = await f.redeem();
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        code: "REDEEMED",
        purchaseRef,
        seller,
        redeemedAt: "1234",
        humanVerified: false,
      });
      expect(f.trace).toEqual(["1", "2", "3", "4", "5", "7"]);
    },
  );

  it("B holding A's bundle fails explicitly at step 6; A succeeds; A replay fails at step 5", async () => {
    const f = await fixture();
    const rejected = await f.redeem(attacker);
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({
      code: "BUYER_MISMATCH",
      step: 6,
      error: expect.stringContaining("not the receipt buyer"),
    });
    expect(f.chain.submit).not.toHaveBeenCalled();
    expect(f.logs).toContainEqual(
      expect.objectContaining({ code: "BUYER_MISMATCH", step: 6 }),
    );
    expect((await f.redeem()).status).toBe(201);
    const replay = await f.redeem();
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: "ALREADY_REDEEMED",
      step: 5,
    });
    expect(f.chain.submit).toHaveBeenCalledTimes(1);
  });

  it("denies missing authentication before any chain read", async () => {
    const f = await fixture();
    const response = await fetch(`${f.url}/v1/redemptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(401);
    expect(f.trace).toEqual(["1"]);
  });

  it("does not let a hostile server turn the client into an arbitrary-message signer", async () => {
    const f = await fixture();
    const original = f.authorizer.issueChallenge.bind(f.authorizer);
    vi.spyOn(f.authorizer, "issueChallenge").mockImplementation(
      (address, body) => ({
        ...original(address, body),
        message: "Sign an unrelated authorization",
      }),
    );
    const signer = { ...buyer, signMessage: vi.fn(buyer.signMessage) };
    await expect(f.redeem(signer)).rejects.toThrow("Untrusted mock challenge");
    expect(signer.signMessage).not.toHaveBeenCalled();
    expect(f.chain.submit).not.toHaveBeenCalled();
  });

  it.each(["rawPurchaseRef", "purchaseRefNonce"] as const)(
    "rejects wrong %s at step 3",
    async (field) => {
      const f = await fixture();
      const body = {
        ...input,
        [field]:
          field === "rawPurchaseRef" ? "wrong" : keccak256(toHex("wrong")),
      };
      const response = await f.redeem(buyer, body);
      expect(await response.json()).toMatchObject({
        code: "PREIMAGE_MISMATCH",
        step: 3,
      });
      expect(f.chain.consumedBy).not.toHaveBeenCalled();
      expect(f.chain.submit).not.toHaveBeenCalled();
    },
  );

  it.each([zeroAddress, store, attacker.address] as Address[])(
    "rejects mismatched consumer %s",
    async (consumer) => {
      const f = await fixture();
      vi.mocked(f.chain.consumedBy).mockResolvedValue(consumer);
      expect(await (await f.redeem()).json()).toMatchObject({
        code: "CONSUMER_MISMATCH",
        step: 4,
      });
      expect(f.chain.submit).not.toHaveBeenCalled();
    },
  );

  it("rejects nonexistent listing and sanitizes canonical helper errors", async () => {
    const f = await fixture();
    vi.mocked(f.chain.reconstruct).mockRejectedValue(
      new Error(
        `ListingNotFound calldata ${input.rawPurchaseRef} ${input.purchaseRefNonce}`,
      ),
    );
    expect(
      await (await f.redeem(buyer, { ...input, listingId: "99" })).json(),
    ).toMatchObject({ code: "VERIFICATION_UNAVAILABLE", step: 3 });
    expect(f.chain.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(f.logs)).not.toContain(input.rawPurchaseRef);
  });

  it("rejects a different listing even when the seller and reconstructed hash match", async () => {
    const f = await fixture();
    expect(
      await (await f.redeem(buyer, { ...input, listingId: "2" })).json(),
    ).toMatchObject({ code: "SETTLEMENT_MISMATCH", step: 3 });
    expect(f.chain.submit).not.toHaveBeenCalled();
  });

  it("rejects ambiguous same-reference settlement events", async () => {
    const f = await fixture();
    const [event] = await f.chain.settlements(input.purchaseTxHash);
    vi.mocked(f.chain.settlements).mockResolvedValue([
      event!,
      { ...event!, buyer: attacker.address },
    ]);
    expect(await (await f.redeem()).json()).toMatchObject({
      code: "AMBIGUOUS_SETTLEMENT",
      step: 3,
    });
    expect(f.chain.submit).not.toHaveBeenCalled();
  });

  it.each(["ReceiptPurchasedV2", "X402ReceiptSettled"] as const)(
    "rejects amount and metadata mismatches against the expected order for %s",
    async (kind) => {
      for (const change of [{ amount: 999_999n }, { metadataHash: zeroHash }]) {
        const f = await fixture(kind);
        const [event] = await f.chain.settlements(input.purchaseTxHash);
        vi.mocked(f.chain.settlements).mockResolvedValue([{ ...event!, ...change }]);
        const response = await f.redeem();
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: "ORDER_MISMATCH", step: 3 });
        expect(f.chain.consumedBy).not.toHaveBeenCalled();
        expect(f.chain.submit).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a paid reference absent from the merchant's issued orders", async () => {
    const f = await fixture();
    vi.spyOn(f.quoteStore, "get").mockResolvedValue(undefined);
    const response = await f.redeem();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "ORDER_NOT_FOUND", step: 3 });
    expect(f.chain.submit).not.toHaveBeenCalled();
  });

  it("fails closed and redacts storage errors", async () => {
    const f = await fixture();
    vi.spyOn(f.quoteStore, "get").mockRejectedValue(
      new Error(`${input.rawPurchaseRef} ${input.purchaseRefNonce}`),
    );
    const response = await f.redeem();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("VERIFICATION_UNAVAILABLE");
    for (const secret of [input.rawPurchaseRef, input.purchaseRefNonce]) {
      expect(text + JSON.stringify(f.logs)).not.toContain(secret);
    }
    expect(f.chain.submit).not.toHaveBeenCalled();
  });

  it.each(["buyer", "listingId", "purchaseRef"] as const)(
    "rejects an order with mismatched %s", async (field) => {
      const f = await fixture();
      const order = (await f.quoteStore.get(purchaseRef))!;
      if (field === "listingId") order.quote.listingId = "2";
      else order.quote[field] = field === "buyer" ? attacker.address : zeroHash;
      vi.spyOn(f.quoteStore, "get").mockResolvedValue(order);
      expect(await (await f.redeem()).json()).toMatchObject({ code: "ORDER_MISMATCH", step: 3 });
      expect(f.chain.submit).not.toHaveBeenCalled();
    },
  );

  it.each(["settlements", "consumedBy", "redeemedAt", "submit"] as const)(
    "fails closed on %s failure without leaking RPC calldata",
    async (method) => {
      const f = await fixture();
      const consoleLog = vi.spyOn(console, "info").mockImplementation(() => {});
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      vi.mocked(f.chain[method]).mockRejectedValue(
        new Error(
          `RPC error: ${input.rawPurchaseRef} ${input.purchaseRefNonce}`,
        ),
      );
      const response = await f.redeem();
      expect(response.status).toBe(503);
      const evidence = JSON.stringify([
        await response.json(),
        f.logs,
        consoleLog.mock.calls,
        consoleError.mock.calls,
      ]);
      expect(evidence).not.toContain(input.rawPurchaseRef);
      expect(evidence).not.toContain(input.purchaseRefNonce);
      if (method !== "submit") expect(f.chain.submit).not.toHaveBeenCalled();
    },
  );

  it("never logs bundle on success, buyer rejection, replay, or malformed JSON", async () => {
    const f = await fixture();
    await f.redeem(attacker);
    await f.redeem();
    await f.redeem();
    const malformed = await fetch(`${f.url}/v1/redemptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"rawPurchaseRef":"${input.rawPurchaseRef}","nonce":"${input.purchaseRefNonce}"`,
    });
    const text = await malformed.text();
    expect(malformed.status).toBe(400);
    const evidence = JSON.stringify(f.logs) + text;
    expect(evidence).not.toContain(input.rawPurchaseRef);
    expect(evidence).not.toContain(input.purchaseRefNonce);
  });

  it("serializes concurrent authenticated attempts so only one reaches submission", async () => {
    const f = await fixture();
    const responses = await Promise.all([f.redeem(), f.redeem()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(f.chain.submit).toHaveBeenCalledTimes(1);
  });

  it("rejects an unconsumed reference at step 4", async () => {
    const f = await fixture();
    vi.mocked(f.chain.consumedBy).mockRejectedValue(
      new RedemptionError(
        "REFERENCE_UNCONSUMED",
        4,
        422,
        "Purchase reference has not been consumed",
      ),
    );
    expect(await (await f.redeem()).json()).toMatchObject({
      code: "REFERENCE_UNCONSUMED",
      step: 4,
    });
    expect(f.chain.redeemedAt).not.toHaveBeenCalled();
  });
});

describe("mock authorization challenge boundaries", () => {
  const config = {
    resource: "https://merchant.example/v1/redemptions",
    chainId: 8453,
    redemptionContract: redemption,
  };
  async function proof(
    authorizer: MockAgentAuthorizer,
    signingAccount = buyer,
  ) {
    const challenge = authorizer.issueChallenge(buyer.address, input);
    const signature = await signingAccount.signMessage({
      message: challenge.message,
    });
    return {
      "x-nota-agent-auth": Buffer.from(
        JSON.stringify({ challengeId: challenge.id, signature }),
      ).toString("base64"),
    };
  }

  it("returns a synthetic wallet ID, never a human registration", async () => {
    const authorizer = new MockAgentAuthorizer(config);
    expect(
      await authorizer.authorize({
        headers: await proof(authorizer),
        body: input,
      }),
    ).toEqual({
      agentAddress: buyer.address,
      humanId: `mock:wallet:${buyer.address.toLowerCase()}`,
    });
  });
  it("rejects a signature from another wallet", async () => {
    const authorizer = new MockAgentAuthorizer(config);
    await expect(
      authorizer.authorize({
        headers: await proof(authorizer, attacker),
        body: input,
      }),
    ).rejects.toMatchObject({ code: "AGENT_AUTH_FAILED" });
  });
  it("rejects reused challenges", async () => {
    const authorizer = new MockAgentAuthorizer(config);
    const headers = await proof(authorizer);
    await authorizer.authorize({ headers, body: input });
    await expect(
      authorizer.authorize({ headers, body: input }),
    ).rejects.toThrow();
  });
  it.each([
    "listingId",
    "purchaseTxHash",
    "rawPurchaseRef",
    "purchaseRefNonce",
  ] as const)("binds the signature to %s", async (field) => {
    const authorizer = new MockAgentAuthorizer(config);
    const headers = await proof(authorizer);
    const value =
      field === "listingId"
        ? "2"
        : field === "rawPurchaseRef"
          ? "other"
          : keccak256(toHex("other"));
    await expect(
      authorizer.authorize({ headers, body: { ...input, [field]: value } }),
    ).rejects.toThrow();
  });
  it("expires and bounds outstanding challenges", async () => {
    let now = 1000;
    const authorizer = new MockAgentAuthorizer({
      ...config,
      now: () => now,
      ttlMs: 100,
      maxChallenges: 1,
    });
    const headers = await proof(authorizer);
    expect(() => authorizer.issueChallenge(buyer.address, input)).toThrow(
      "capacity",
    );
    now += 100;
    await expect(
      authorizer.authorize({ headers, body: input }),
    ).rejects.toThrow();
    expect(() => authorizer.issueChallenge(buyer.address, input)).not.toThrow();
  });
  it("does not accept another server's challenge", async () => {
    const first = new MockAgentAuthorizer(config);
    const second = new MockAgentAuthorizer({
      ...config,
      resource: "https://other.example/v1/redemptions",
    });
    await expect(
      second.authorize({ headers: await proof(first), body: input }),
    ).rejects.toThrow();
  });
  it.each([
    null,
    {},
    { ...input, buyer: buyer.address },
    { ...input, listingId: 1 },
    { ...input, listingId: "0" },
    { ...input, listingId: (2n ** 256n).toString() },
    { ...input, purchaseRefNonce: "0x12" },
  ])("rejects malformed body %#", (body) => {
    expect(() => parseInput(body)).toThrow();
  });
});
