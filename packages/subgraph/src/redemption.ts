import { dataSource } from "@graphprotocol/graph-ts";
import { EntitlementRedeemed } from "../generated/templates/EntitlementRedemption/EntitlementRedemption";
import { Redemption } from "../generated/schema";
import {
  chainId,
  eventId,
  getPurchase,
  receiptStore,
  registry,
} from "./common";

export function handleEntitlementRedeemed(event: EntitlementRedeemed): void {
  assert(
    event.address.equals(dataSource.address()),
    "Unconfigured event emitter",
  );
  let id = eventId(event);
  if (Redemption.load(id) != null) return;
  // Redemption can be observed without a purchase (partial history, incomplete configuration).
  // Preserve it without inventing a buyer, listing, or payment proof.
  let purchase = getPurchase(event.params.purchaseRef);
  purchase.save();
  let redemption = new Redemption(id);
  redemption.purchase = purchase.id;
  redemption.chainId = chainId();
  redemption.registry = registry();
  redemption.store = receiptStore();
  redemption.redemptionContract = event.address;
  redemption.purchaseRef = event.params.purchaseRef;
  redemption.seller = event.params.seller;
  redemption.redeemedAt = event.params.redeemedAt;
  redemption.transactionHash = event.transaction.hash;
  redemption.logIndex = event.logIndex;
  redemption.blockNumber = event.block.number;
  redemption.blockHash = event.block.hash;
  redemption.blockTimestamp = event.block.timestamp;
  redemption.save();
}
