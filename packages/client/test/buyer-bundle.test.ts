import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseDeployment, NOTA_EXTENSION_KIND } from "@nota/x402-nota";
import {
  payAndFetch,
  type AgentConfig,
  type RedemptionBundle,
} from "../src/index.js";
import {
  assertPrivateCheckoutUrl,
  createRedemptionBundle,
} from "../src/bundle.js";

const rpc = vi.hoisted(() => ({ readContract: vi.fn() }));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => rpc,
}));
const adapter = "0x1111111111111111111111111111111111111111";
const trusted = baseDeployment([adapter]);
const privateKey = keccak256(toHex("buyer-bundle-unit-tests"));
const buyer = privateKeyToAccount(privateKey).address;
const ref = keccak256(toHex("unrelated bundle"));

function response() {
  return Response.json(
    {
      accepts: [],
      extensions: {
        [NOTA_EXTENSION_KIND]: {
          kind: NOTA_EXTENSION_KIND,
          ...trusted,
          adapter,
          seller: "0x2222222222222222222222222222222222222222",
          quote: {
            buyer,
            purchaseRef: ref,
            listingId: "1",
            amount: "1",
            metadataHash: ref,
            agentId: ref,
            integratorFeeRecipient: adapter,
            integratorFeeAmount: "0",
            issuedAt: "1",
            expiresAt: "9999999999",
          },
          metadata: { document: {}, hash: ref },
        },
      },
    },
    { status: 402 },
  );
}
function config(
  fetchImpl: typeof fetch,
  onBundleCreated?: AgentConfig["onBundleCreated"],
): AgentConfig {
  return {
    rpcUrl: "http://127.0.0.1:1",
    chainId: trusted.chainId,
    privateKey,
    trusted,
    maxAmount: 1n,
    fetchImpl,
    onBundleCreated,
    logger: { info: vi.fn(), warn: vi.fn() },
  };
}
afterEach(() => vi.resetAllMocks());

describe("buyer-generated checkout bundles", () => {
  it("generates fresh independent raw references and 32-byte nonces", () => {
    const a = createRedemptionBundle(),
      b = createRedemptionBundle();
    expect(a.rawPurchaseRef).toMatch(/^nota_x402_[0-9a-f]{24}$/);
    expect(a.purchaseRefNonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.rawPurchaseRef).not.toBe(b.rawPurchaseRef);
    expect(a.purchaseRefNonce).not.toBe(b.purchaseRefNonce);
  });

  it("allows HTTPS and loopback development, but rejects remote plaintext and URL credentials", () => {
    for (const url of [
      "https://merchant.example/report",
      "http://localhost/report",
      "http://127.0.0.1:123/report",
    ])
      expect(() => assertPrivateCheckoutUrl(url)).not.toThrow();
    for (const url of [
      "http://merchant.example/report",
      "http://localhost.attacker.example/report",
      "https://user:password@merchant.example/report",
    ])
      expect(() => assertPrivateCheckoutUrl(url)).toThrow();
  });

  it("waits for buyer retention before POST and refuses a substituted quote before signing/payment", async () => {
    let saved: RedemptionBundle | undefined;
    const calls: string[] = [];
    rpc.readContract.mockImplementation(async ({ functionName }) => {
      calls.push(functionName);
      if (functionName === "STORE") return trusted.store;
      if (functionName === "SETTLEMENT_TOKEN") return trusted.settlementToken;
      if (functionName === "PURCHASE_REF_REGISTRY")
        return trusted.purchaseRefRegistry;
      if (functionName === "hashPurchaseRef")
        return keccak256(toHex("buyer bundle"));
      throw new Error("Unexpected later payment operation");
    });
    const fetch = vi.fn(async (_url, init) => {
      expect(saved).toBeDefined();
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(JSON.parse(init.body)).toEqual(saved);
      expect(JSON.stringify(init.headers)).not.toContain(
        saved!.purchaseRefNonce,
      );
      return response();
    });
    const cfg = config(fetch as typeof globalThis.fetch, async (bundle) => {
      await Promise.resolve();
      saved = { ...bundle };
    });
    await expect(
      payAndFetch("https://merchant.example/report", cfg),
    ).rejects.toThrow("buyer bundle commitment rejected");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls).toContain("hashPurchaseRef");
    expect(calls).not.toContain("validateSignedReceiptPurchase");
    const hashCall = rpc.readContract.mock.calls.find(
      ([call]) => call.functionName === "hashPurchaseRef",
    )![0];
    expect(hashCall.address).toBe(trusted.store);
    expect(hashCall.args.slice(2)).toEqual([
      saved!.rawPurchaseRef,
      saved!.purchaseRefNonce,
    ]);
    const logs = JSON.stringify([
      vi.mocked(cfg.logger!.info).mock.calls,
      vi.mocked(cfg.logger!.warn).mock.calls,
    ]);
    expect(logs).not.toContain(saved!.purchaseRefNonce);
    expect(logs).not.toContain(saved!.rawPurchaseRef);
  });

  it("does not begin checkout if private retention fails, and sanitizes that error", async () => {
    const fetch = vi.fn();
    const cfg = config(fetch, async (bundle) => {
      throw new Error(bundle.purchaseRefNonce);
    });
    await expect(
      payAndFetch("https://merchant.example/report", cfg),
    ).rejects.toThrow(
      "Could not retain buyer redemption bundle; checkout not started",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed without leaking a canonical RPC error containing the bundle", async () => {
    let original: RedemptionBundle | undefined;
    rpc.readContract.mockImplementation(async ({ functionName, args }) => {
      if (functionName === "STORE") return trusted.store;
      if (functionName === "SETTLEMENT_TOKEN") return trusted.settlementToken;
      if (functionName === "PURCHASE_REF_REGISTRY") return trusted.purchaseRefRegistry;
      throw new Error(`${args[2]} ${args[3]}`);
    });
    const fetch = vi.fn(async () => response());
    const cfg = config(fetch, async bundle => { original = { ...bundle }; });
    await expect(payAndFetch("https://merchant.example/report", cfg)).rejects.toThrow(
      "bundle verification unavailable: canonical hash lookup failed",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const logs = JSON.stringify([vi.mocked(cfg.logger!.info).mock.calls, vi.mocked(cfg.logger!.warn).mock.calls]);
    expect(logs).not.toContain(original!.rawPurchaseRef);
    expect(logs).not.toContain(original!.purchaseRefNonce);
  });

  it("suppresses transport diagnostics that contain the private POST body", async () => {
    const fetch = vi.fn(async (_url, init) => {
      throw new Error(init.body);
    });
    await expect(
      payAndFetch(
        "https://merchant.example/report",
        config(fetch as typeof globalThis.fetch),
      ),
    ).rejects.toThrow("Buyer bundle checkout request failed");
  });
});
