import { BigInt, Bytes, dataSource, ethereum } from "@graphprotocol/graph-ts";
import { Listing, Purchase, Settlement } from "../generated/schema";

export function chainId(): BigInt {
  return dataSource.context().getBigInt("chainId");
}

export function registry(): Bytes {
  return dataSource.context().getBytes("registry");
}

export function receiptStore(): Bytes {
  return dataSource.context().getBytes("store");
}

export function eventId(event: ethereum.Event): string {
  return (
    chainId().toString() +
    ":" +
    event.transaction.hash.toHexString() +
    ":" +
    event.logIndex.toString()
  );
}

export function purchaseId(ref: Bytes): string {
  return (
    chainId().toString() +
    ":" +
    registry().toHexString() +
    ":" +
    ref.toHexString()
  );
}

export function listingId(id: BigInt): string {
  return (
    chainId().toString() +
    ":" +
    receiptStore().toHexString() +
    ":" +
    id.toString()
  );
}

export function getPurchase(ref: Bytes): Purchase {
  let id = purchaseId(ref);
  let purchase = Purchase.load(id);
  if (purchase == null) {
    purchase = new Purchase(id);
    purchase.chainId = chainId();
    purchase.registry = registry();
    purchase.purchaseRef = ref;
    purchase.status = "UNKNOWN";
    purchase.settlementCount = BigInt.zero();
  }
  return purchase;
}

export function recordSettlement(
  event: ethereum.Event,
  kind: string,
  receipt: BigInt,
  listing: BigInt,
  ref: Bytes,
  buyer: Bytes,
  seller: Bytes,
  amount: BigInt,
  metadataHash: Bytes,
  agentId: Bytes,
  authorizationNonce: Bytes | null,
): void {
  assert(
    event.address.equals(dataSource.address()),
    "Unconfigured event emitter",
  );
  let id = eventId(event);
  // Reprocessing the exact log must not inflate counts or overwrite immutable evidence.
  if (Settlement.load(id) != null) return;
  let purchase = getPurchase(ref);
  let listingKey = listingId(listing);
  if (Listing.load(listingKey) == null) {
    let listingEntity = new Listing(listingKey);
    listingEntity.chainId = chainId();
    listingEntity.store = receiptStore();
    listingEntity.listingId = listing;
    listingEntity.save();
  }
  let settlement = new Settlement(id);
  settlement.purchase = purchase.id;
  settlement.chainId = chainId();
  settlement.registry = registry();
  settlement.store = receiptStore();
  settlement.kind = kind;
  settlement.emitter = event.address;
  settlement.receiptId = receipt;
  settlement.listing = listingKey;
  settlement.listingId = listing;
  settlement.purchaseRef = ref;
  settlement.buyer = buyer;
  settlement.seller = seller;
  settlement.amount = amount;
  settlement.metadataHash = metadataHash;
  settlement.agentId = agentId;
  settlement.authorizationNonce = authorizationNonce;
  settlement.transactionHash = event.transaction.hash;
  settlement.logIndex = event.logIndex;
  settlement.blockNumber = event.block.number;
  settlement.blockHash = event.block.hash;
  settlement.blockTimestamp = event.block.timestamp;
  settlement.save();

  if (purchase.settlementCount.equals(BigInt.zero())) {
    purchase.firstSettlement = id;
    purchase.buyer = buyer;
    purchase.seller = seller;
    purchase.listing = listingKey;
    purchase.amount = amount;
    purchase.metadataHash = metadataHash;
    purchase.status = "SETTLED";
  } else {
    // Two distinct settlement logs for one globally consumed reference are ambiguous.
    // Keep both as evidence and never silently choose the later buyer or purchase terms.
    purchase.status = "CONFLICTED";
  }
  purchase.settlementCount = purchase.settlementCount.plus(BigInt.fromI32(1));
  purchase.save();
}
