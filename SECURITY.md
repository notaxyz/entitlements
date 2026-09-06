# Security Model

## On-chain guarantees

`EntitlementRedemption` enforces only the following properties:

1. The listing exists. The deployed `NotaReceiptStore` enforces this and reverts before returning a nonexistent listing.
2. The caller is the listing seller returned by that store.
3. The deployed store reconstructs the purchase reference from the seller, listing ID, raw purchase reference, and nonce.
4. The deployed `PurchaseRefRegistry` reports that the reconstructed reference was consumed specifically by the configured `NotaReceiptStore`.
5. The purchase reference has not already been redeemed through this entitlement contract.

The purchase-reference preimage includes the seller, so a purchase reference is globally unique. Redemption state is therefore keyed directly by `purchaseRef`.

`listingId` is used when resolving and validating the seller but is not independently committed into `purchaseRef`. For that reason, `EntitlementRedeemed` does not emit a listing ID. Consumers must join it to the original `ReceiptPurchasedV2` event by `purchaseRef` when they need the authoritative listing.

## What the contract does not guarantee

The contract does not identify or authenticate the buyer or purchasing agent. Possession of the raw purchase reference and nonce does not establish an agent identity on-chain, and the contract has no record of which agent should receive the entitlement.

In particular, the policy **“a stolen receipt is not enough” is not enforced by this contract**. It is a merchant-side authorization rule. The AgentKit-protected redemption endpoint planned for day three must authenticate the intended agent and apply that rule before causing the listing seller to submit the on-chain redemption.

The contract also does not validate off-chain fulfillment, inspect receipt metadata, or require that a listing remains active after purchase.

## Redemption preimage bundle

The raw purchase reference is not necessarily secret. The `purchaseRefNonce` provides the cryptographic secrecy for the redemption preimage bundle. Both values are supplied as transaction calldata and become public once the transaction is published, so the bundle must be treated as a single-use redemption input rather than a long-lived authentication credential.

Seller authorization prevents another address from redeeming directly, but it does not replace merchant-side agent authentication or seller-key security.

## Administration and funds

The contract holds no funds. It intentionally has no owner, pause mechanism, or upgrade path.
