import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { deployed } from "./deployments.js";
import {
  baseline,
  checkedMeta,
  checkFreshness,
  compareReceipt,
  graphQuery,
  scanSettlements,
  scanRedemptions,
} from "./index-verification.js";

const snapshot = { number: 51185000, hash: `0x${"ab".repeat(32)}` };
const deployment = "expected-deployment-cid";
const meta = { deployment, hasIndexingErrors: false, block: snapshot };
const row = (id: string) => ({
  id,
  chainId: "8453",
  registry: baseline.registry,
  store: baseline.store,
  emitter: baseline.store,
  kind: "STORE",
  purchaseRef: baseline.purchaseRef,
  blockNumber: String(baseline.receiptBlock),
});

afterEach(() => vi.unstubAllGlobals());

describe("live index verification preparation", () => {
  it("pins the manifest to the verified creation block and deployment context", () => {
    // Use Graph CLI's declared YAML parser, without adding another tooling dependency.
    const require = createRequire(import.meta.url);
    const graphRequire = createRequire(
      require.resolve("@graphprotocol/graph-cli/package.json"),
    );
    const manifest = graphRequire("js-yaml").load(
      readFileSync(new URL("../subgraph.yaml", import.meta.url), "utf8"),
    );
    expect(manifest.templates).toBeUndefined();
    expect(manifest.dataSources).toHaveLength(3);
    expect(deployed.store).toBe(baseline.store);
    expect(deployed.registry).toBe(baseline.registry);
    expect(deployed.chainId).toBe(baseline.chainId);
    for (const [name, address, startBlock, handler, file] of [
      [
        "NotaReceiptStore",
        baseline.store,
        baseline.creationBlock,
        "handleReceiptPurchasedV2",
        "store",
      ],
      [
        "NotaX402Settlement",
        deployed.adapter,
        deployed.adapterBlock,
        "handleX402ReceiptSettled",
        "adapter",
      ],
      [
        "EntitlementRedemption",
        deployed.redemption,
        deployed.redemptionBlock,
        "handleEntitlementRedeemed",
        "redemption",
      ],
    ]) {
      const source = manifest.dataSources.find(
        (item: any) => item.name === name,
      );
      expect(source.network).toBe("base");
      expect(source.source.address.toLowerCase()).toBe(address);
      expect(source.source.startBlock).toBe(startBlock);
      expect(source.source.abi).toBe(name);
      expect(source.context.chainId).toEqual({ type: "BigInt", data: "8453" });
      expect(source.context.store.type).toBe("Bytes");
      expect(source.context.store.data.toLowerCase()).toBe(baseline.store);
      expect(source.context.registry.type).toBe("Bytes");
      expect(source.context.registry.data.toLowerCase()).toBe(
        baseline.registry,
      );
      expect(source.mapping.file).toBe(`./src/${file}.ts`);
      expect(source.mapping.eventHandlers).toHaveLength(1);
      expect(source.mapping.eventHandlers[0].handler).toBe(handler);
    }
  });

  it("rejects missing metadata, index errors and a different deployment", () => {
    expect(() => checkedMeta({}, deployment)).toThrow();
    expect(() =>
      checkedMeta({ _meta: { ...meta, hasIndexingErrors: true } }, deployment),
    ).toThrow();
    expect(() => checkedMeta({ _meta: meta }, "other")).toThrow();
    expect(checkedMeta({ _meta: meta }, deployment)).toEqual(snapshot);
  });

  it("fails closed on lag or an index ahead of the RPC", () => {
    expect(() =>
      checkFreshness(snapshot, BigInt(snapshot.number + 301)),
    ).toThrow();
    expect(() =>
      checkFreshness(snapshot, BigInt(snapshot.number - 1)),
    ).toThrow();
    expect(() =>
      checkFreshness(snapshot, BigInt(snapshot.number + 300)),
    ).not.toThrow();
  });

  it("uses an increasing ID cursor at one pinned block on every page", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ _meta: meta, settlements: [row("a"), row("b")] })
      .mockResolvedValueOnce({ _meta: meta, settlements: [row("c")] });
    expect(await scanSettlements(query, deployment, snapshot, 2)).toHaveLength(
      3,
    );
    expect(query.mock.calls[0]![1]).toEqual({
      block: { hash: snapshot.hash },
      cursor: "",
      first: 2,
    });
    expect(query.mock.calls[1]![1]).toEqual({
      block: { hash: snapshot.hash },
      cursor: "b",
      first: 2,
    });
  });

  it("rejects a changed snapshot or deployment mid-scan", async () => {
    for (const changed of [
      { ...meta, block: { ...snapshot, number: snapshot.number + 1 } },
      { ...meta, deployment: "other" },
    ]) {
      const query = vi
        .fn()
        .mockResolvedValueOnce({ _meta: meta, settlements: [row("a")] })
        .mockResolvedValueOnce({ _meta: changed, settlements: [] });
      await expect(
        scanSettlements(query, deployment, snapshot, 1),
      ).rejects.toThrow();
    }
  });

  it("rejects repeated cursors, wrong emitters and an exhausted page limit", async () => {
    for (const rows of [
      [row("b"), row("a")],
      [{ ...row("a"), emitter: "0xattacker" }],
    ]) {
      await expect(
        scanSettlements(
          vi.fn().mockResolvedValue({ _meta: meta, settlements: rows }),
          deployment,
          snapshot,
          2,
        ),
      ).rejects.toThrow();
    }
    await expect(
      scanSettlements(
        vi.fn().mockResolvedValue({ _meta: meta, settlements: [row("a")] }),
        deployment,
        snapshot,
        1,
        1,
      ),
    ).rejects.toThrow("PAGINATION_LIMIT_REACHED");
  });

  it("requires exactly one known receipt with all RPC fields matching", () => {
    const receipt = { ...row("a"), amount: "100000" };
    expect(() => compareReceipt([receipt], { amount: "100000" })).not.toThrow();
    expect(() => compareReceipt([], { amount: "100000" })).toThrow();
    expect(() =>
      compareReceipt([receipt, receipt], { amount: "100000" }),
    ).toThrow();
    expect(() => compareReceipt([receipt], { amount: "1" })).toThrow();
  });

  it("accepts only the pinned adapter with the matching event kind and start block", async () => {
    const adapter = {
      ...row("a"),
      emitter: deployed.adapter,
      kind: "X402_ADAPTER",
      blockNumber: String(deployed.adapterBlock),
    };
    const query = (item: object) =>
      vi.fn().mockResolvedValue({ _meta: meta, settlements: [item] });
    expect(await scanSettlements(query(adapter), deployment, snapshot)).toEqual(
      [adapter],
    );
    for (const bad of [
      { ...adapter, kind: "STORE" },
      { ...adapter, emitter: baseline.store },
      { ...adapter, emitter: deployed.redemption },
      { ...adapter, blockNumber: String(deployed.adapterBlock - 1) },
      { ...adapter, blockNumber: String(snapshot.number + 1) },
      { ...adapter, blockNumber: "invalid" },
    ])
      await expect(
        scanSettlements(query(bad), deployment, snapshot),
      ).rejects.toThrow("INVALID_CURSOR_OR_SOURCE");
  });

  it("scans redemptions at the same snapshot and fails closed on foreign deployments", async () => {
    const redemption = {
      ...row("a"),
      redemptionContract: deployed.redemption,
      blockNumber: String(deployed.redemptionBlock),
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ _meta: meta, redemptions: [redemption] })
      .mockResolvedValueOnce({ _meta: meta, redemptions: [] });
    expect(await scanRedemptions(query, deployment, snapshot, 1)).toEqual([
      redemption,
    ]);
    expect(query.mock.calls[0]![0]).toContain("redemptions(block:");
    expect(query.mock.calls[1]![1]).toEqual({
      block: { hash: snapshot.hash },
      cursor: "a",
      first: 1,
    });
    for (const bad of [
      { ...redemption, redemptionContract: deployed.adapter },
      { ...redemption, registry: deployed.adapter },
      { ...redemption, chainId: "1" },
      { ...redemption, blockNumber: String(deployed.redemptionBlock - 1) },
    ])
      await expect(
        scanRedemptions(
          vi.fn().mockResolvedValue({ _meta: meta, redemptions: [bad] }),
          deployment,
          snapshot,
        ),
      ).rejects.toThrow();
    await expect(
      scanRedemptions(
        vi.fn().mockResolvedValue({
          _meta: { ...meta, hasIndexingErrors: true },
          redemptions: [],
        }),
        deployment,
        snapshot,
      ),
    ).rejects.toThrow();
  });

  it("rejects partial GraphQL results and HTTP errors without exposing provider details", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {},
          errors: [{ message: "private-api-key" }],
        }),
      })
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal("fetch", fetch);
    const query = graphQuery("https://example.invalid/api/private-api-key");
    await expect(query("query {}", {})).rejects.toThrow("GRAPH_QUERY_ERROR");
    await expect(query("query {}", {})).rejects.toThrow("GRAPH_HTTP_ERROR");
    expect(fetch.mock.calls[0]![1].redirect).toBe("error");
    expect(() => graphQuery("http://example.invalid")).toThrow();
  });
});
