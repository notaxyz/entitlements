import { X402ReceiptSettled } from "../generated/templates/NotaX402Settlement/NotaX402Settlement";
import { recordSettlement } from "./common";

export function handleX402ReceiptSettled(event: X402ReceiptSettled): void {
  recordSettlement(
    event,
    "X402_ADAPTER",
    event.params.receiptId,
    event.params.listingId,
    event.params.purchaseRef,
    event.params.buyer,
    event.params.seller,
    event.params.amount,
    event.params.metadataHash,
    event.params.agentId,
    event.params.authorizationNonce,
  );
}
