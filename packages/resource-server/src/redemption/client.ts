import type { PrivateKeyAccount } from "viem";
import { inputDigest, type RedemptionInput } from "./types.js";
import type { MockChallenge } from "./authorizer.js";

/** Development client: the account signs; the server never receives its private key. */
export async function redeemWithMockAgent(
  baseUrl: string,
  account: PrivateKeyAccount,
  input: RedemptionInput,
  context: { chainId: number; redemptionContract: string },
): Promise<Response> {
  const resource = new URL("/v1/redemptions", baseUrl).href;
  const challengeResponse = await fetch(
    new URL("/v1/redemptions/challenge", baseUrl),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentAddress: account.address,
        redemption: input,
      }),
      redirect: "error",
    },
  );
  if (!challengeResponse.ok)
    throw new Error("Could not obtain mock redemption challenge");
  const challenge = (await challengeResponse.json()) as MockChallenge;
  // Never sign arbitrary server text. Pin origin, chain, contract, wallet and exact input.
  const expected = [
    "Nota redemption — MOCK wallet authentication (not World ID)",
    `Resource: ${resource}`,
    "Method: POST",
    `Chain ID: ${context.chainId}`,
    `Redemption contract: ${context.redemptionContract}`,
    `Agent: ${account.address}`,
    `Request digest: ${inputDigest(input)}`,
    `Challenge: ${challenge.id}`,
    `Expires at: ${challenge.expiresAt}`,
  ].join("\n");
  if (
    challenge.authentication !== "mock-wallet" ||
    challenge.humanVerified !== false ||
    !/^[a-f0-9]{64}$/.test(challenge.id) ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    challenge.expiresAt <= Date.now() ||
    challenge.expiresAt > Date.now() + 300_000 ||
    challenge.message !== expected
  )
    throw new Error("Untrusted mock challenge");
  const signature = await account.signMessage({ message: expected });
  return fetch(resource, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-nota-agent-auth": Buffer.from(
        JSON.stringify({ challengeId: challenge.id, signature }),
      ).toString("base64"),
    },
    body: JSON.stringify(input),
  });
}
