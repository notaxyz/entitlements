import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { x402ReceiptSettledEvent } from "@nota/x402-nota";
import { receiptPurchasedV2Event } from "../src/redemption/abi.js";
import { decodeSettlements } from "../src/redemption/chain.js";

const store: Address = "0x1111111111111111111111111111111111111111";
const adapter: Address = "0x2222222222222222222222222222222222222222";
const seller: Address = "0x3333333333333333333333333333333333333333";
const buyer: Address = "0x4444444444444444444444444444444444444444";
const attacker: Address = "0x5555555555555555555555555555555555555555";
const purchaseRef = keccak256(toHex("reference"));
const metadataHash = keccak256(toHex("metadata"));
const agentId = keccak256(toHex("agent"));
const authorizationNonce = keccak256(toHex("authorization"));
const storeLog = {
  address: store,
  topics: encodeEventTopics({
    abi: [receiptPurchasedV2Event],
    args: { seller, buyer, purchaseRef },
  }) as Hex[],
  // Deployed ABI: receiptId is in data; purchaseRef is a topic. Do not confuse with adapter.
  data: encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [7n, 11n, 1_000_000n, metadataHash, agentId],
  ),
};
const adapterLog = {
  address: adapter,
  topics: encodeEventTopics({
    abi: [x402ReceiptSettledEvent],
    args: { receiptId: 7n, seller, buyer },
  }) as Hex[],
  data: encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [11n, purchaseRef, 1_000_000n, metadataHash, agentId, authorizationNonce],
  ),
};

describe("trusted Nota settlement event decoding", () => {
  it.each([storeLog, adapterLog])(
    "extracts the authoritative reference, listing, buyer and seller %#",
    (log) => {
      expect(decodeSettlements([log], store, [adapter])).toEqual([
        {
          kind:
            log.address === store ? "ReceiptPurchasedV2" : "X402ReceiptSettled",
          emitter: log.address,
          listingId: 11n,
          purchaseRef,
          seller,
          buyer,
        },
      ]);
    },
  );
  it("does not confuse unrelated store and adapter receipt ID spaces", () => {
    const events = decodeSettlements([storeLog, adapterLog], store, [adapter]);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.purchaseRef)).toEqual([
      purchaseRef,
      purchaseRef,
    ]);
    expect(events[0]!.emitter).not.toBe(events[1]!.emitter);
  });
  it("ignores a lookalike event emitted by an untrusted address", () => {
    expect(
      decodeSettlements(
        [
          { ...adapterLog, address: attacker },
          { ...storeLog, address: attacker },
        ],
        store,
        [adapter],
      ),
    ).toEqual([]);
  });
  it("requires the correct event type at each trusted emitter", () => {
    expect(
      decodeSettlements(
        [
          { ...adapterLog, address: store },
          { ...storeLog, address: adapter },
        ],
        store,
        [adapter],
      ),
    ).toEqual([]);
  });
  it("does not accept an adapter just because its event signature matches", () => {
    expect(decodeSettlements([adapterLog], store, [])).toEqual([]);
  });
  it("rejects truncated data and missing indexed fields", () => {
    expect(
      decodeSettlements(
        [
          { ...adapterLog, data: "0x" },
          { ...storeLog, topics: storeLog.topics.slice(0, 2) },
        ],
        store,
        [adapter],
      ),
    ).toEqual([]);
  });
});
