import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  baseline,
  checkedMeta,
  checkFreshness,
  compareReceipt,
  graphQuery,
  scanSettlements,
} from "./index-verification.js";

const snapshot = { number: 50834000, hash: `0x${"ab".repeat(32)}` };
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
});

afterEach(() => vi.unstubAllGlobals());

describe("live index verification preparation", () => {
  it("pins the manifest to the verified creation block and deployment context", () => {
    const manifest = readFileSync(
      new URL("../subgraph.yaml", import.meta.url),
      "utf8",
    ).toLowerCase();
    expect(manifest).toContain(`startblock: ${baseline.creationBlock}`);
    expect(manifest).toContain(baseline.store);
    expect(manifest).toContain(baseline.registry);
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
