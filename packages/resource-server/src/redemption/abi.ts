import { parseAbi, parseAbiItem } from "viem";

// Verified against the deployed store on Basescan, 2026-09-10. receiptId is NOT indexed.
// https://basescan.org/address/0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88#code
export const receiptPurchasedV2Event = parseAbiItem(
  "event ReceiptPurchasedV2(uint256 receiptId, address indexed seller, address indexed buyer, uint256 listingId, bytes32 indexed purchaseRef, uint256 amount, bytes32 metadataHash, bytes32 agentId)",
);

export const redemptionAbi = parseAbi([
  "function STORE() view returns (address)",
  "function PURCHASE_REF_REGISTRY() view returns (address)",
  "function isAcceptedConsumer(address consumer) view returns (bool)",
  "function redeemedAt(bytes32 purchaseRef) view returns (uint64)",
  "function redeemEntitlement(uint256 listingId, string rawPurchaseRef, bytes32 purchaseRefNonce) returns (bytes32)",
  "event EntitlementRedeemed(bytes32 indexed purchaseRef, address indexed seller, uint64 redeemedAt)",
]);
