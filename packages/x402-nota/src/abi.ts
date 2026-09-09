import { parseAbi, parseAbiItem } from "viem";

export const notaX402SettlementAbi = parseAbi([
  "struct SignedReceiptQuote { uint256 listingId; address buyer; bytes32 purchaseRef; uint256 amount; bytes32 metadataHash; bytes32 agentId; address integratorFeeRecipient; uint256 integratorFeeAmount; uint64 issuedAt; uint64 expiresAt; }",
  "struct ReceiveAuthorization { address from; address to; uint256 value; uint256 validAfter; uint256 validBefore; bytes32 nonce; }",
  "function settleWithAuthorization(SignedReceiptQuote quote, bytes sellerSignature, address claimedSigner, ReceiveAuthorization authorization, bytes buyerSignature, bytes32 paymentSalt) returns (uint256 receiptId)",
  "function authorizationNonce(bytes32 quoteDigest, bytes32 paymentSalt) pure returns (bytes32)",
  "function AUTHORIZATION_NONCE_DOMAIN() view returns (bytes32)",
  "function nextAdapterReceiptId() view returns (uint256)",
  "function STORE() view returns (address)",
  "function PURCHASE_REF_REGISTRY() view returns (address)",
  "function SETTLEMENT_TOKEN() view returns (address)",
  "event X402ReceiptSettled(uint256 indexed receiptId, address indexed seller, address indexed buyer, uint256 listingId, bytes32 purchaseRef, uint256 amount, bytes32 metadataHash, bytes32 agentId, bytes32 authorizationNonce)",
  "error UnboundQuote()",
  "error StorePurchasesPaused()",
  "error AuthorizationPayerMismatch(address authorizationFrom, address quoteBuyer)",
  "error AuthorizationRecipientMismatch(address authorizationTo, address adapter)",
  "error AuthorizationValueMismatch(uint256 authorizationValue, uint256 quoteAmount)",
  "error SettlementAccountingMismatch()",
  "error AuthorizationNotBoundToQuote(bytes32 provided, bytes32 expected)",
]);

/// Standalone item so `getLogs` returns typed args instead of a hand-cast record.
export const x402ReceiptSettledEvent = parseAbiItem(
  "event X402ReceiptSettled(uint256 indexed receiptId, address indexed seller, address indexed buyer, uint256 listingId, bytes32 purchaseRef, uint256 amount, bytes32 metadataHash, bytes32 agentId, bytes32 authorizationNonce)",
);

export const notaReceiptStoreAbi = parseAbi([
  "struct SignedReceiptQuote { uint256 listingId; address buyer; bytes32 purchaseRef; uint256 amount; bytes32 metadataHash; bytes32 agentId; address integratorFeeRecipient; uint256 integratorFeeAmount; uint64 issuedAt; uint64 expiresAt; }",
  "struct Listing { address seller; bytes32 listingHash; uint256 unitPrice; bool active; uint8 mode; }",
  "function createListing(bytes32 listingHash, uint256 unitPrice, uint8 mode) returns (uint256 listingId)",
  "function nextListingId() view returns (uint256)",
  "function getListing(uint256 listingId) view returns (Listing)",
  "function hashPurchaseRef(address seller, uint256 listingId, string rawPurchaseRef, bytes32 purchaseRefNonce) view returns (bytes32)",
  "function hashSignedReceiptQuote(SignedReceiptQuote quote) view returns (bytes32)",
  "function purchasesPaused() view returns (bool)",
  "function SETTLEMENT_TOKEN() view returns (address)",
  "function PURCHASE_REF_REGISTRY() view returns (address)",
]);

export const purchaseRefRegistryAbi = parseAbi([
  "function owner() view returns (address)",
  "function setConsumerAuthorization(address consumer, bool authorized)",
  "function authorizedConsumers(address consumer) view returns (bool)",
  "function isConsumed(bytes32 purchaseRef) view returns (bool)",
  "function consumedBy(bytes32 purchaseRef) view returns (address)",
]);

export const eip3009Abi = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function balanceOf(address account) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);
