import { ReceiptPurchasedV2 } from "../generated/NotaReceiptStore/NotaReceiptStore";
import { receiptStore, recordSettlement } from "./common";

export function handleReceiptPurchasedV2(event: ReceiptPurchasedV2): void {
  assert(event.address.equals(receiptStore()), "Wrong receipt store context");
  recordSettlement(
    event,
    "STORE",
    event.params.receiptId,
    event.params.listingId,
    event.params.purchaseRef,
    event.params.buyer,
    event.params.seller,
    event.params.amount,
    event.params.metadataHash,
    event.params.agentId,
    null,
  );
}
