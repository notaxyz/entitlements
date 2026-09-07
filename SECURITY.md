# Security Model

## Entitlement redemption

`EntitlementRedemption` enforces only the following properties:

1. The listing exists. The deployed `NotaReceiptStore` enforces this and reverts before returning a nonexistent listing.
2. The caller is the listing seller returned by that store.
3. The deployed store reconstructs the purchase reference from the seller, listing ID, raw purchase reference, and nonce.
4. The deployed `PurchaseRefRegistry` reports that the reconstructed reference was consumed specifically by the configured `NotaReceiptStore`.
5. The purchase reference has not already been redeemed through this entitlement contract.

The purchase-reference preimage includes the seller, so a purchase reference is globally unique. Redemption state is therefore keyed directly by `purchaseRef`.

`listingId` is used when resolving and validating the seller but is not independently committed into `purchaseRef`. For that reason, `EntitlementRedeemed` does not emit a listing ID. Consumers must join it to the original `ReceiptPurchasedV2` event by `purchaseRef` when they need the authoritative listing.

### What the contract does not guarantee

The contract does not identify or authenticate the buyer or purchasing agent. Possession of the raw purchase reference and nonce does not establish an agent identity on-chain, and the contract has no record of which agent should receive the entitlement.

In particular, the policy **“a stolen receipt is not enough” is not enforced by this contract**. It is a merchant-side authorization rule. The AgentKit-protected redemption endpoint planned for day three must authenticate the intended agent and apply that rule before causing the listing seller to submit the on-chain redemption.

The contract also does not validate off-chain fulfillment, inspect receipt metadata, or require that a listing remains active after purchase.

### Redemption preimage bundle

The raw purchase reference is not necessarily secret. The `purchaseRefNonce` provides the cryptographic secrecy for the redemption preimage bundle. Both values are supplied as transaction calldata and become public once the transaction is published, so the bundle must be treated as a single-use redemption input rather than a long-lived authentication credential.

Seller authorization prevents another address from redeeming directly, but it does not replace merchant-side agent authentication or seller-key security.

## x402 settlement adapter

`NotaX402Settlement` enforces the following properties:

1. The quote passes `NotaReceiptStore.validateSignedReceiptPurchase`, which applies the same validation path as `purchaseSignedReceipt`: the listing exists and is active, the seller signature is valid and comes from the seller or a listing-authorized quote signer, the quote is inside its `issuedAt`/`expiresAt` window and its `MAX_QUOTE_TTL`, the amount and integrator fee are inside protocol bounds, and the purchase reference is not already consumed.
2. `quote.buyer` is non-zero. The store treats a zero buyer as an unbound quote that any wallet may pay and skips its buyer check entirely; an EIP-3009 authorization must bind to one payer, so the adapter rejects unbound quotes rather than settling against whoever the authorization happens to name.
3. The store's `purchasesPaused` switch is not set. This is the only check `purchaseSignedReceipt` performs that `validateSignedReceiptPurchase` does not repeat, so the adapter checks it directly and the store owner's kill switch still covers this path.
4. The buyer authorization is bound to that exact quote: `authorization.from == quote.buyer`, `authorization.value == quote.amount`, and `authorization.to == address(this)`.
5. Payment is pulled with `receiveWithAuthorization`, never `transferWithAuthorization`. The token requires `msg.sender == to`, so an authorization naming the adapter is executable only through the adapter. A front-runner who observes it cannot execute the transfer standalone.
6. The purchase reference is consumed exactly once in the shared `PurchaseRefRegistry`, after funds arrive and before any payout.
7. Proceeds are paid using the fee breakdown the store returned, not a local recomputation. The three legs sum to the gross by construction, so the adapter retains no balance.

The submitter is untrusted. Both signatures are verified on-chain and every amount is bound to the quote, so any address may pay the gas.

### Two unrelated nonces

Two values in this system are called a nonce. They are unrelated, and **neither is ever derived from the other**.

| | `authorization.nonce` | `purchaseRefNonce` |
| --- | --- | --- |
| Purpose | EIP-3009 payment replay protection, scoped to the settlement token | Cryptographic secrecy for the redemption preimage bundle |
| Lifetime | Public the moment the payment is submitted | Must stay secret until redemption |
| On-chain | Emitted in `X402ReceiptSettled` and burned in the token's `authorizationState` | Never appears in a quote, in settlement calldata, or in any adapter event |

Deriving one from the other would leak the redemption credential to anyone watching the payment, so they must be generated independently from a CSPRNG. The adapter never sees `purchaseRefNonce` and must never be given it. Do not log it, do not put it in metadata, and do not commit it into `metadataHash`.

### What the adapter does not guarantee

The adapter does not identify or authenticate the buyer's agent. A valid buyer authorization proves control of the buyer key at signing time and nothing more.

`buyerSignature` is a 65-byte ECDSA signature, split and handed to the token, which applies the EIP-2 low-`s` and `v` rules and rejects a recovered address that is not the authorizer. **The buyer must therefore be an EOA.** The deployed USDC also exposes a `bytes`-signature overload of `receiveWithAuthorization` that accepts ERC-1271 contract-wallet signatures; the adapter does not use it. A smart-contract buyer wallet — including a Coinbase Smart Wallet — cannot pay through this adapter as written. Seller signatures are unaffected: the store verifies those with `SignatureChecker` and accepts ERC-1271.

The adapter has no owner, no pause switch, and no upgrade path, and holds no funds between transactions. It cannot recover tokens sent to it directly.

### Registry consumer authorization

Settlement consumes a purchase reference, which only registry-owner-authorized modules may do. The registry owner must call `setConsumerAuthorization(<adapter address>, true)` before the adapter can settle anything; until then every call reverts with `UnauthorizedConsumer`. That authorization is also a revocation point: the registry owner can disable the adapter at any time without the adapter having a pause switch of its own.

### Adapter settlements are not redeemable through `EntitlementRedemption`

`PurchaseRefRegistry.consume` attributes a reference to the calling module. A reference settled through the adapter is recorded as consumed by the adapter, not by the store, and `EntitlementRedemption` requires `consumedBy(purchaseRef) == address(STORE)`. Purchases settled through x402 are therefore rejected with `EntitlementNotPaid`.

This is a known gap, not a defended boundary. It is left open deliberately: `EntitlementRedemption` is already deployed-behaviour-compatible and is not modified here. Whichever way day three closes it — accepting a set of authorized consumers, or deploying a separate redemption contract for adapter settlements — the choice widens who can mint an entitlement and needs to be made explicitly rather than patched in.

## Administration and funds

Neither contract holds funds. Both intentionally have no owner, pause mechanism, or upgrade path.
