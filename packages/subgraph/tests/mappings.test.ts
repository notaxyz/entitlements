import {
  Address,
  BigInt,
  Bytes,
  DataSourceContext,
  ethereum,
  Value,
  ValueKind,
} from "@graphprotocol/graph-ts";
import {
  afterEach,
  assert,
  clearStore,
  dataSourceMock,
  newMockEvent,
  test,
} from "matchstick-as/assembly/index";
import { ReceiptPurchasedV2 } from "../generated/NotaReceiptStore/NotaReceiptStore";
import { X402ReceiptSettled } from "../generated/NotaX402Settlement/NotaX402Settlement";
import { EntitlementRedeemed } from "../generated/EntitlementRedemption/EntitlementRedemption";
import { Purchase, Redemption, Settlement } from "../generated/schema";
import { handleReceiptPurchasedV2 } from "../src/store";
import { handleX402ReceiptSettled } from "../src/adapter";
import { handleEntitlementRedeemed } from "../src/redemption";
import { eventId, listingId, purchaseId } from "../src/common";

const STORE = "0x1111111111111111111111111111111111111111";
const ADAPTER = "0x2222222222222222222222222222222222222222";
const REDEMPTION_A = "0x3333333333333333333333333333333333333333";
const REDEMPTION_B = "0x4444444444444444444444444444444444444444";
const REGISTRY = "0x5555555555555555555555555555555555555555";
const OTHER_REGISTRY = "0x6666666666666666666666666666666666666666";
const BUYER = "0x7777777777777777777777777777777777777777";
const SELLER = "0x8888888888888888888888888888888888888888";
const OTHER_BUYER = "0x9999999999999999999999999999999999999999";
const REF =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_REF =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const METADATA =
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const AGENT =
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const NONCE =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TX1 =
  "0x0101010101010101010101010101010101010101010101010101010101010101";
const TX2 =
  "0x0202020202020202020202020202020202020202020202020202020202020202";
const TX3 =
  "0x0303030303030303030303030303030303030303030303030303030303030303";
const BLOCK =
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

function config(
  emitter: string,
  registry: string = REGISTRY,
  chain: i32 = 8453,
): void {
  let context = new DataSourceContext();
  context.set("chainId", Value.fromBigInt(BigInt.fromI32(chain)));
  context.set("registry", Value.fromBytes(Bytes.fromHexString(registry)));
  context.set("store", Value.fromBytes(Bytes.fromHexString(STORE)));
  dataSourceMock.setReturnValues(emitter, "base", context);
}

function metadata(
  event: ethereum.Event,
  emitter: string,
  tx: string = TX1,
  index: i32 = 0,
): void {
  event.address = Address.fromString(emitter);
  event.transaction.hash = Bytes.fromHexString(tx);
  event.logIndex = BigInt.fromI32(index);
  event.block.number = BigInt.fromI32(100);
  event.block.hash = Bytes.fromHexString(BLOCK);
  event.block.timestamp = BigInt.fromI32(1000);
}

function number(name: string, value: i32): ethereum.EventParam {
  return new ethereum.EventParam(
    name,
    ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(value)),
  );
}

function address(name: string, value: string): ethereum.EventParam {
  return new ethereum.EventParam(
    name,
    ethereum.Value.fromAddress(Address.fromString(value)),
  );
}

function bytes(name: string, value: string): ethereum.EventParam {
  return new ethereum.EventParam(
    name,
    ethereum.Value.fromFixedBytes(Bytes.fromHexString(value)),
  );
}

function storeEvent(
  ref: string = REF,
  tx: string = TX1,
  index: i32 = 0,
): ReceiptPurchasedV2 {
  let event = changetype<ReceiptPurchasedV2>(newMockEvent());
  metadata(event, STORE, tx, index);
  event.parameters = [
    number("receiptId", 1),
    address("seller", SELLER),
    address("buyer", BUYER),
    number("listingId", 7),
    bytes("purchaseRef", ref),
    number("amount", 1000000),
    bytes("metadataHash", METADATA),
    bytes("agentId", AGENT),
  ];
  return event;
}

function adapterEvent(ref: string = REF, tx: string = TX2): X402ReceiptSettled {
  let event = changetype<X402ReceiptSettled>(newMockEvent());
  metadata(event, ADAPTER, tx);
  event.parameters = [
    number("receiptId", 1),
    address("seller", SELLER),
    address("buyer", BUYER),
    number("listingId", 7),
    bytes("purchaseRef", ref),
    number("amount", 1000000),
    bytes("metadataHash", METADATA),
    bytes("agentId", AGENT),
    bytes("authorizationNonce", NONCE),
  ];
  return event;
}

function redemptionEvent(
  emitter: string = REDEMPTION_A,
  tx: string = TX3,
): EntitlementRedeemed {
  let event = changetype<EntitlementRedeemed>(newMockEvent());
  metadata(event, emitter, tx);
  event.parameters = [
    bytes("purchaseRef", REF),
    address("seller", SELLER),
    number("redeemedAt", 999),
  ];
  return event;
}

afterEach(() => {
  clearStore();
  dataSourceMock.resetValues();
});

test("store receipt maps every public field and exposes a settled purchase", () => {
  config(STORE);
  let event = storeEvent();
  handleReceiptPurchasedV2(event);
  let id = eventId(event);
  let purchase = purchaseId(Bytes.fromHexString(REF));
  assert.entityCount("Purchase", 1);
  assert.entityCount("Listing", 1);
  assert.entityCount("Settlement", 1);
  assert.fieldEquals("Purchase", purchase, "status", "SETTLED");
  assert.fieldEquals("Purchase", purchase, "settlementCount", "1");
  assert.fieldEquals("Purchase", purchase, "firstSettlement", id);
  assert.fieldEquals("Purchase", purchase, "buyer", BUYER);
  assert.fieldEquals("Purchase", purchase, "seller", SELLER);
  assert.fieldEquals("Purchase", purchase, "amount", "1000000");
  assert.fieldEquals("Purchase", purchase, "metadataHash", METADATA);
  assert.fieldEquals("Settlement", id, "purchase", purchase);
  assert.fieldEquals("Settlement", id, "kind", "STORE");
  assert.fieldEquals("Settlement", id, "chainId", "8453");
  assert.fieldEquals("Settlement", id, "registry", REGISTRY);
  assert.fieldEquals("Settlement", id, "store", STORE);
  assert.fieldEquals("Settlement", id, "emitter", STORE);
  assert.fieldEquals("Settlement", id, "receiptId", "1");
  assert.fieldEquals("Settlement", id, "listingId", "7");
  assert.fieldEquals("Settlement", id, "listing", listingId(BigInt.fromI32(7)));
  assert.fieldEquals("Settlement", id, "purchaseRef", REF);
  assert.fieldEquals("Settlement", id, "buyer", BUYER);
  assert.fieldEquals("Settlement", id, "seller", SELLER);
  assert.fieldEquals("Settlement", id, "amount", "1000000");
  assert.fieldEquals("Settlement", id, "metadataHash", METADATA);
  assert.fieldEquals("Settlement", id, "agentId", AGENT);
  assert.fieldEquals("Settlement", id, "transactionHash", TX1);
  assert.fieldEquals("Settlement", id, "logIndex", "0");
  assert.fieldEquals("Settlement", id, "blockNumber", "100");
  assert.fieldEquals("Settlement", id, "blockHash", BLOCK);
  assert.fieldEquals("Settlement", id, "blockTimestamp", "1000");
  assert.i32Equals(
    Settlement.load(id)!.get("authorizationNonce")!.kind,
    ValueKind.NULL,
  );
});

test("adapter receipt preserves its event type and public payment nonce", () => {
  config(ADAPTER);
  let event = adapterEvent();
  handleX402ReceiptSettled(event);
  let id = eventId(event);
  assert.fieldEquals("Settlement", id, "kind", "X402_ADAPTER");
  assert.fieldEquals("Settlement", id, "emitter", ADAPTER);
  assert.fieldEquals("Settlement", id, "authorizationNonce", NONCE);
  assert.fieldEquals("Settlement", id, "metadataHash", METADATA);
  assert.fieldEquals("Settlement", id, "amount", "1000000");
  assert.fieldEquals("Settlement", id, "buyer", BUYER);
  assert.fieldEquals("Settlement", id, "seller", SELLER);
  assert.fieldEquals("Settlement", id, "agentId", AGENT);
  assert.fieldEquals(
    "Purchase",
    purchaseId(Bytes.fromHexString(REF)),
    "status",
    "SETTLED",
  );
});

test("equal receipt IDs from different modules do not merge purchases", () => {
  config(STORE);
  handleReceiptPurchasedV2(storeEvent());
  config(ADAPTER);
  handleX402ReceiptSettled(adapterEvent(OTHER_REF));
  assert.entityCount("Purchase", 2);
  assert.entityCount("Settlement", 2);
  assert.entityCount("Listing", 1);
});

test("duplicate store and adapter processing is idempotent", () => {
  config(STORE);
  let event = storeEvent();
  handleReceiptPurchasedV2(event);
  handleReceiptPurchasedV2(event);
  config(ADAPTER);
  let adapter = adapterEvent(OTHER_REF);
  handleX402ReceiptSettled(adapter);
  handleX402ReceiptSettled(adapter);
  assert.entityCount("Settlement", 2);
  assert.fieldEquals(
    "Purchase",
    purchaseId(Bytes.fromHexString(REF)),
    "settlementCount",
    "1",
  );
  assert.fieldEquals(
    "Purchase",
    purchaseId(Bytes.fromHexString(OTHER_REF)),
    "settlementCount",
    "1",
  );
});

test("different logs in the same transaction retain distinct identities", () => {
  config(STORE);
  handleReceiptPurchasedV2(storeEvent());
  handleReceiptPurchasedV2(storeEvent(OTHER_REF, TX1, 1));
  assert.entityCount("Settlement", 2);
  assert.entityCount("Purchase", 2);
});

test("conflicting settlement claims are retained and flagged, not overwritten", () => {
  config(STORE);
  let first = storeEvent();
  handleReceiptPurchasedV2(first);
  config(ADAPTER);
  let second = adapterEvent();
  second.parameters[2] = address("buyer", OTHER_BUYER);
  second.parameters[5] = number("amount", 1);
  handleX402ReceiptSettled(second);
  let id = purchaseId(Bytes.fromHexString(REF));
  assert.entityCount("Purchase", 1);
  assert.entityCount("Settlement", 2);
  assert.fieldEquals("Purchase", id, "status", "CONFLICTED");
  assert.fieldEquals("Purchase", id, "settlementCount", "2");
  assert.fieldEquals("Purchase", id, "buyer", BUYER);
  assert.fieldEquals("Purchase", id, "amount", "1000000");
  assert.fieldEquals("Purchase", id, "firstSettlement", eventId(first));
  assert.fieldEquals("Settlement", eventId(second), "buyer", OTHER_BUYER);
});

test("redemption joins on the reference without inventing a listing field", () => {
  config(ADAPTER);
  handleX402ReceiptSettled(adapterEvent());
  config(REDEMPTION_A);
  let event = redemptionEvent();
  handleEntitlementRedeemed(event);
  let id = eventId(event);
  assert.fieldEquals(
    "Redemption",
    id,
    "purchase",
    purchaseId(Bytes.fromHexString(REF)),
  );
  assert.fieldEquals("Redemption", id, "redemptionContract", REDEMPTION_A);
  assert.fieldEquals("Redemption", id, "purchaseRef", REF);
  assert.fieldEquals("Redemption", id, "seller", SELLER);
  assert.fieldEquals("Redemption", id, "redeemedAt", "999");
  assert.fieldEquals("Redemption", id, "transactionHash", TX3);
  assert.fieldEquals("Redemption", id, "blockNumber", "100");
  assert.fieldEquals("Redemption", id, "blockTimestamp", "1000");
  assert.assertNull(Redemption.load(id)!.get("listingId"));
  assert.fieldEquals(
    "Purchase",
    purchaseId(Bytes.fromHexString(REF)),
    "status",
    "SETTLED",
  );
});

test("redemptions on two deployments remain separate and duplicate events do not multiply", () => {
  config(STORE);
  handleReceiptPurchasedV2(storeEvent());
  config(REDEMPTION_A);
  let first = redemptionEvent();
  handleEntitlementRedeemed(first);
  handleEntitlementRedeemed(first);
  config(REDEMPTION_B);
  let second = redemptionEvent(REDEMPTION_B, TX2);
  handleEntitlementRedeemed(second);
  assert.entityCount("Purchase", 1);
  assert.entityCount("Redemption", 2);
  assert.fieldEquals(
    "Redemption",
    eventId(first),
    "redemptionContract",
    REDEMPTION_A,
  );
  assert.fieldEquals(
    "Redemption",
    eventId(second),
    "redemptionContract",
    REDEMPTION_B,
  );
  let purchase = Purchase.load(purchaseId(Bytes.fromHexString(REF)))!;
  assert.assertNull(purchase.get("redeemed"));
  assert.assertNull(purchase.get("redeemedAt"));
  assert.i32Equals(purchase.redemptions.load().length, 2);
});

test("missing purchase history stays unknown and is filled by a later indexed settlement", () => {
  config(REDEMPTION_A);
  handleEntitlementRedeemed(redemptionEvent());
  let id = purchaseId(Bytes.fromHexString(REF));
  assert.fieldEquals("Purchase", id, "status", "UNKNOWN");
  assert.fieldEquals("Purchase", id, "settlementCount", "0");
  let purchase = Purchase.load(id)!;
  assert.assertNull(purchase.get("buyer"));
  assert.assertNull(purchase.get("amount"));
  assert.assertNull(purchase.get("firstSettlement"));
  config(STORE);
  handleReceiptPurchasedV2(storeEvent());
  assert.entityCount("Purchase", 1);
  assert.fieldEquals("Purchase", id, "status", "SETTLED");
  assert.fieldEquals("Purchase", id, "buyer", BUYER);
  assert.i32Equals(Purchase.load(id)!.redemptions.load().length, 1);
});

test("purchase IDs separate registries even for the same preimage hash", () => {
  config(STORE);
  handleReceiptPurchasedV2(storeEvent());
  let first = purchaseId(Bytes.fromHexString(REF));
  config(STORE, OTHER_REGISTRY);
  handleReceiptPurchasedV2(storeEvent(REF, TX2));
  let second = purchaseId(Bytes.fromHexString(REF));
  assert.assertTrue(first != second);
  assert.entityCount("Purchase", 2);
});

test("event, purchase and listing IDs include chain scope", () => {
  config(STORE);
  handleReceiptPurchasedV2(storeEvent());
  config(STORE, REGISTRY, 84532);
  handleReceiptPurchasedV2(storeEvent());
  assert.entityCount("Purchase", 2);
  assert.entityCount("Settlement", 2);
  assert.entityCount("Listing", 2);
});

test(
  "mismatched store context is rejected",
  () => {
    config(ADAPTER);
    let event = storeEvent();
    event.address = Address.fromString(ADAPTER);
    handleReceiptPurchasedV2(event);
  },
  true,
);

test(
  "an event from outside the configured data source is rejected",
  () => {
    config(ADAPTER);
    let event = adapterEvent();
    event.address = Address.fromString(OTHER_BUYER);
    handleX402ReceiptSettled(event);
  },
  true,
);

test(
  "an unconfigured redemption emitter is rejected",
  () => {
    config(REDEMPTION_A);
    handleEntitlementRedeemed(redemptionEvent(REDEMPTION_B));
  },
  true,
);
