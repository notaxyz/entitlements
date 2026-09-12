// Read-only deployment checks, deliberately separate from backend authorization.
import { deployed } from "./deployments.js";

export const baseline = {
  chainId: 8453,
  store: "0xf6062f3f52d3e19cb9cc3e027491a5c11d101f88",
  registry: "0x9aaffa5787ca332a40b9c98e3e5323a97f96d991",
  creationTx:
    "0x78301d0cffc614a1ad591275a96fbdd413fddb73568d57fe6bda3a37e4055266",
  creationBlock: 50536305,
  creationBlockHash:
    "0x13d569fdf01d03841c96ffdf61b1d8e161be2895f9ff2e447a0c486af3fed3c0",
  receiptTx:
    "0x3b9656b4a67dee38ca2bd28d8841fbb67469c0ed3f9ace2977e5b753e7230978",
  receiptBlock: 50833757,
  receiptBlockHash:
    "0x55d862855399541f157cfb01d399747d507fefdcf47761751afaf62fbdcb9d50",
  receiptLogIndex: 474,
  purchaseRef:
    "0x5333d780992fdf98c143083b765392aeaa27cb393a034235026f57f202806770",
} as const;

export type Query = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<any>;
export type Snapshot = { number: number; hash: string };

export function checkedMeta(data: any, deployment: string): Snapshot {
  const meta = data?._meta;
  if (
    meta?.deployment !== deployment ||
    meta?.hasIndexingErrors !== false ||
    !Number.isSafeInteger(meta?.block?.number) ||
    meta.block.number < 0 ||
    !/^0x[0-9a-f]{64}$/i.test(meta?.block?.hash ?? "")
  ) {
    throw new Error("INDEX_UNHEALTHY_OR_WRONG_DEPLOYMENT");
  }
  return { number: meta.block.number, hash: meta.block.hash.toLowerCase() };
}

export function checkFreshness(
  index: Snapshot,
  head: bigint,
  maxLag = 300,
): void {
  const lag = head - BigInt(index.number);
  if (lag < 0n || lag > BigInt(maxLag)) throw new Error("INDEX_STALE_OR_AHEAD");
}

export const healthQuery = `query IndexHealth {
  _meta { deployment hasIndexingErrors block { number hash } }
}`;

// Freeze every page to the same RPC-confirmed finalized block hash, use an ID
// cursor instead of skip, and retain _meta on every response. No partial success.
async function scanEvidence(
  entity: "settlements" | "redemptions",
  query: Query,
  deployment: string,
  snapshot: Snapshot,
  pageSize = 100,
  maxPages = 100,
): Promise<Record<string, string>[]> {
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 1000 ||
    !Number.isInteger(maxPages) ||
    maxPages < 1
  )
    throw new Error("INVALID_PAGE_LIMIT");
  const rows: Record<string, string>[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const data = await query(
      `query Evidence($block: Block_height!, $cursor: String!, $first: Int!) {
      _meta(block: $block) { deployment hasIndexingErrors block { number hash } }
      ${entity}(block: $block, first: $first, orderBy: id, orderDirection: asc,
        where: { id_gt: $cursor }) {
        id chainId registry store purchaseRef seller
        transactionHash logIndex blockNumber blockHash blockTimestamp
        ${
          entity === "settlements"
            ? "kind emitter receiptId listingId buyer amount metadataHash agentId authorizationNonce"
            : "redemptionContract redeemedAt"
        }
      }
    }`,
      { block: { hash: snapshot.hash }, cursor, first: pageSize },
    );
    const meta = checkedMeta(data, deployment);
    if (meta.hash !== snapshot.hash || meta.number !== snapshot.number)
      throw new Error("INDEX_SNAPSHOT_CHANGED");
    const pageRows = data[entity];
    if (!Array.isArray(pageRows) || pageRows.length > pageSize)
      throw new Error("INVALID_PAGE");
    for (const row of pageRows) {
      const startBlock =
        entity === "redemptions"
          ? row?.redemptionContract === deployed.redemption
            ? deployed.redemptionBlock
            : undefined
          : row?.kind === "STORE" && row?.emitter === baseline.store
            ? baseline.creationBlock
            : row?.kind === "X402_ADAPTER" && row?.emitter === deployed.adapter
              ? deployed.adapterBlock
              : undefined;
      if (
        typeof row?.id !== "string" ||
        row.id <= cursor ||
        row.chainId !== String(baseline.chainId) ||
        row.registry !== baseline.registry ||
        row.store !== baseline.store ||
        startBlock === undefined ||
        !/^(0|[1-9][0-9]*)$/.test(row.blockNumber ?? "") ||
        BigInt(row.blockNumber) < BigInt(startBlock) ||
        BigInt(row.blockNumber) > BigInt(snapshot.number)
      ) {
        throw new Error("INVALID_CURSOR_OR_SOURCE");
      }
      rows.push(row);
      cursor = row.id;
    }
    if (pageRows.length < pageSize) return rows;
  }
  throw new Error("PAGINATION_LIMIT_REACHED");
}

export function scanSettlements(
  query: Query,
  deployment: string,
  snapshot: Snapshot,
  pageSize = 100,
  maxPages = 100,
): Promise<Record<string, string>[]> {
  return scanEvidence(
    "settlements",
    query,
    deployment,
    snapshot,
    pageSize,
    maxPages,
  );
}

export function scanRedemptions(
  query: Query,
  deployment: string,
  snapshot: Snapshot,
  pageSize = 100,
  maxPages = 100,
): Promise<Record<string, string>[]> {
  return scanEvidence(
    "redemptions",
    query,
    deployment,
    snapshot,
    pageSize,
    maxPages,
  );
}

export function compareReceipt(
  rows: Record<string, string>[],
  expected: Record<string, string>,
): void {
  const matches = rows.filter(
    (row) => row.purchaseRef === baseline.purchaseRef,
  );
  if (matches.length !== 1) throw new Error("RECEIPT_MISSING_OR_CONFLICTED");
  for (const [key, value] of Object.entries(expected)) {
    if (matches[0]![key] !== value) throw new Error("RECEIPT_RPC_MISMATCH");
  }
}

export function graphQuery(endpoint: string): Query {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("HTTPS_ENDPOINT_REQUIRED");
  return async (query, variables) => {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error("GRAPH_HTTP_ERROR");
    const body = (await response.json()) as any;
    if (body.errors?.length || !body.data) throw new Error("GRAPH_QUERY_ERROR");
    return body.data;
  };
}
