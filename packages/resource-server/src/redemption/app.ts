import express, { type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { isAddressEqual, type Address } from "viem";
import type { AgentAuthorizer, MockAgentAuthorizer } from "./authorizer.js";
import type { RedemptionChain } from "./chain.js";
import { parseInput, RedemptionError, requireAddress } from "./types.js";

export interface AuditRecord {
  event: "redemption.accepted" | "redemption.rejected";
  requestId: string;
  step: number;
  code: string;
}

export interface RedemptionAppConfig {
  authorizer: AgentAuthorizer;
  chain: RedemptionChain;
  /** Only the mock deployment exposes this development challenge endpoint. */
  mockChallenges?: MockAgentAuthorizer;
  logger?: (record: AuditRecord) => void;
}

export function createRedemptionApp(config: RedemptionAppConfig) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  const log = (record: AuditRecord) => {
    // Explicit allowlist, never a request, body, headers, exception, or RPC error object.
    try {
      (config.logger ?? ((entry) => console.info(JSON.stringify(entry))))(
        record,
      );
    } catch {
      /* Logging must not turn a confirmed redemption into an apparent failure. */
    }
  };

  // Single seller writer per process; serializes state check + policy + submission, with a
  // bounded queue. Multi-instance operation requires a shared durable queue/nonce manager.
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (queued >= 32)
      throw new RedemptionError(
        "SERVER_BUSY",
        5,
        429,
        "Redemption queue is full",
      );
    queued++;
    const result = tail.then(action);
    tail = result.catch(() => {});
    try {
      return await result;
    } finally {
      queued--;
    }
  }

  if (config.mockChallenges) {
    app.post("/v1/redemptions/challenge", (req, res) => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const address = requireAddress(body?.agentAddress);
        const input = parseInput(body?.redemption);
        const challenge = config.mockChallenges!.issueChallenge(address, input);
        res.json(challenge);
      } catch (error) {
        const failure =
          error instanceof RedemptionError
            ? error
            : new RedemptionError(
                "INVALID_REQUEST",
                0,
                400,
                "Invalid challenge request",
              );
        res
          .status(failure.status)
          .json({
            code: failure.code,
            error: failure.message,
            step: failure.step,
          });
      }
    });
  }

  app.post("/v1/redemptions", async (req, res) => {
    const requestId = randomUUID();
    let step = 0;
    try {
      const input = parseInput(req.body);
      step = 1;
      const identity = await config.authorizer.authorize({
        headers: {
          agentkit: req.header("agentkit"),
          "x-nota-agent-auth": req.header("x-nota-agent-auth"),
        },
        body: input,
      });
      // A faulty authorizer cannot turn an absent identity into a wildcard buyer.
      let agent: Address;
      try {
        agent = requireAddress(identity.agentAddress);
        if (typeof identity.humanId !== "string" || !identity.humanId)
          throw new Error();
      } catch {
        throw new RedemptionError(
          "AGENT_AUTH_FAILED",
          1,
          401,
          "Agent identity missing or invalid",
        );
      }
      step = 2;
      const settlements = await config.chain.settlements(input.purchaseTxHash);
      if (!settlements.length)
        throw new RedemptionError(
          "NO_NOTA_SETTLEMENT",
          2,
          422,
          "No trusted Nota settlement in this transaction",
        );
      step = 3;
      const purchaseRef = await config.chain.reconstruct(input);
      const matches = settlements.filter(
        (record) =>
          record.purchaseRef.toLowerCase() === purchaseRef.toLowerCase(),
      );
      if (!matches.length)
        throw new RedemptionError(
          "PREIMAGE_MISMATCH",
          3,
          422,
          "Redemption preimage bundle does not match the purchase",
        );
      // The adapter does not emit the store event. Either kind suffices; if a transaction
      // contains ambiguous claims for the same reference, do not guess which buyer is real.
      if (matches.length !== 1)
        throw new RedemptionError(
          "AMBIGUOUS_SETTLEMENT",
          3,
          422,
          "Multiple settlements claim this purchase reference",
        );
      const settlement = matches[0]!;
      if (
        settlement.listingId !== BigInt(input.listingId) ||
        !isAddressEqual(settlement.seller, config.chain.seller)
      ) {
        throw new RedemptionError(
          "SETTLEMENT_MISMATCH",
          3,
          422,
          "Settlement listing or seller does not match this redemption",
        );
      }
      const result = await exclusive(async () => {
        step = 4;
        const consumer = await config.chain.consumedBy(purchaseRef);
        if (!isAddressEqual(consumer, settlement.emitter)) {
          throw new RedemptionError(
            "CONSUMER_MISMATCH",
            4,
            422,
            "Reference was not consumed by the settlement emitter",
          );
        }
        step = 5;
        if ((await config.chain.redeemedAt(purchaseRef)) !== 0n) {
          throw new RedemptionError(
            "ALREADY_REDEEMED",
            5,
            409,
            "Entitlement has already been redeemed",
          );
        }
        step = 6;
        if (!isAddressEqual(agent, settlement.buyer)) {
          throw new RedemptionError(
            "BUYER_MISMATCH",
            6,
            403,
            "Authenticated agent is not the receipt buyer; possession of the preimage bundle does not authorize redemption",
          );
        }
        step = 7;
        return config.chain.submit(input, purchaseRef);
      });
      log({
        event: "redemption.accepted",
        requestId,
        step: 7,
        code: "REDEEMED",
      });
      res
        .status(201)
        .json({
          code: "REDEEMED",
          requestId,
          ...result,
          ...(config.mockChallenges
            ? { authentication: "mock-wallet", humanVerified: false }
            : {}),
        });
    } catch (error) {
      const failure =
        error instanceof RedemptionError
          ? error
          : new RedemptionError(
              step === 1 ? "AGENT_AUTH_FAILED" : "VERIFICATION_UNAVAILABLE",
              step,
              step === 1 ? 401 : 503,
              step === 1
                ? "Agent authentication failed"
                : "Could not safely verify or submit redemption",
            );
      log({
        event: "redemption.rejected",
        requestId,
        step: failure.step,
        code: failure.code,
      });
      res
        .status(failure.status)
        .json({
          code: failure.code,
          error: failure.message,
          step: failure.step,
          requestId,
        });
    }
  });

  // Express/body-parser errors may include the original body. Never use their message/stack.
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => {
    log({
      event: "redemption.rejected",
      requestId: randomUUID(),
      step: 0,
      code: "INVALID_REQUEST",
    });
    res
      .status(400)
      .json({
        code: "INVALID_REQUEST",
        error: "Invalid request body",
        step: 0,
      });
  };
  app.use(errors);
  return app;
}
