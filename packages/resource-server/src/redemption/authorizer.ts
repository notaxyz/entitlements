import { randomBytes } from "node:crypto";
import {
  isAddressEqual,
  recoverMessageAddress,
  type Address,
  type Hex,
} from "viem";
import { inputDigest, RedemptionError, type RedemptionInput } from "./types.js";

export interface AgentAuthorizationRequest {
  headers: Readonly<Record<string, string | undefined>>;
  body: RedemptionInput;
}

export interface AgentAuthorizer {
  authorize(
    req: AgentAuthorizationRequest,
  ): Promise<{ agentAddress: string; humanId: string }>;
}

export interface MockChallenge {
  id: string;
  message: string;
  expiresAt: number;
  authentication: "mock-wallet";
  humanVerified: false;
}

/** EOA signatures only. No World ID, AgentBook lookup, or proof of a human is implied. */
export class MockAgentAuthorizer implements AgentAuthorizer {
  private challenges = new Map<
    string,
    {
      challenge: MockChallenge;
      address: Address;
      digest: Hex;
    }
  >();

  constructor(
    private config: {
      resource: string;
      chainId: number;
      redemptionContract: Address;
      ttlMs?: number;
      maxChallenges?: number;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.config.now ?? Date.now)();
  }

  issueChallenge(address: Address, input: RedemptionInput): MockChallenge {
    const now = this.now();
    for (const [id, record] of this.challenges) {
      if (record.challenge.expiresAt <= now) this.challenges.delete(id);
    }
    if (this.challenges.size >= (this.config.maxChallenges ?? 1000)) {
      throw new RedemptionError(
        "CHALLENGE_CAPACITY",
        1,
        429,
        "Challenge capacity reached; retry later",
      );
    }
    const id = randomBytes(32).toString("hex");
    const expiresAt = now + (this.config.ttlMs ?? 120_000);
    const digest = inputDigest(input);
    const challenge: MockChallenge = {
      id,
      expiresAt,
      authentication: "mock-wallet",
      humanVerified: false,
      message: [
        "Nota redemption — MOCK wallet authentication (not World ID)",
        `Resource: ${this.config.resource}`,
        "Method: POST",
        `Chain ID: ${this.config.chainId}`,
        `Redemption contract: ${this.config.redemptionContract}`,
        `Agent: ${address}`,
        `Request digest: ${digest}`,
        `Challenge: ${id}`,
        `Expires at: ${expiresAt}`,
      ].join("\n"),
    };
    this.challenges.set(id, { challenge, address, digest });
    return challenge;
  }

  async authorize(req: AgentAuthorizationRequest) {
    const fail = () =>
      new RedemptionError(
        "AGENT_AUTH_FAILED",
        1,
        401,
        "Missing, invalid, expired, or already-used agent authentication",
      );
    const header = req.headers["x-nota-agent-auth"];
    if (!header || header.length > 2048) throw fail();
    let proof: { challengeId?: unknown; signature?: unknown };
    try {
      proof = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      throw fail();
    }
    if (
      !proof ||
      typeof proof.challengeId !== "string" ||
      typeof proof.signature !== "string" ||
      !/^0x[0-9a-fA-F]{130}$/.test(proof.signature)
    )
      throw fail();
    const record = this.challenges.get(proof.challengeId);
    // Consume synchronously before signature recovery: concurrent use cannot authenticate twice.
    this.challenges.delete(proof.challengeId);
    if (
      !record ||
      record.challenge.expiresAt <= this.now() ||
      record.digest !== inputDigest(req.body)
    )
      throw fail();
    let recovered: Address;
    try {
      recovered = await recoverMessageAddress({
        message: record.challenge.message,
        signature: proof.signature as Hex,
      });
    } catch {
      throw fail();
    }
    if (!isAddressEqual(recovered, record.address)) throw fail();
    return {
      agentAddress: recovered,
      // Interface compatibility only. This namespace is explicitly synthetic, not a human ID.
      humanId: `mock:wallet:${recovered.toLowerCase()}`,
    };
  }
}
