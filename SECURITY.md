# Security Model

## Entitlement redemption

`EntitlementRedemption` enforces only the following properties:

1. The listing exists. The deployed `NotaReceiptStore` enforces this and reverts before returning a nonexistent listing.
2. The caller is the listing seller returned by that store.
3. The deployed store reconstructs the purchase reference from the seller, listing ID, raw purchase reference, and nonce.
4. The deployed `PurchaseRefRegistry` reports that the reconstructed reference was consumed by one of this contract's accepted settlement modules.
5. The purchase reference has not already been redeemed through this entitlement contract.

### Redemption trusts a set of settlement modules

`PurchaseRefRegistry.consume` attributes a reference to the module that called it. A purchase settled directly through `NotaReceiptStore` records the store; one settled through `NotaX402Settlement` records the adapter. Redemption therefore accepts a **set** of Nota settlement modules, not a single contract.

State that plainly rather than describing it as one contract: anything in that set can cause a reference to count as paid. The set is `STORE` plus whatever `additionalConsumers` the deployment was constructed with, and it is enumerable on-chain through `acceptedConsumers()`.

What holds the boundary is that each accepted module is itself constrained. `NotaX402Settlement` validates every quote through the store's own `validateSignedReceiptPurchase`, cannot consume a reference at all until the registry owner authorizes it, and is revocable by that owner at any time. Accepting a module that did not validate through the store, or that was not registry-authorized, would widen this materially — the registry owner's authorization list is the real gate, and this contract's set is a subset of it.

The set is fixed at construction, so this contract keeps its no-owner property and nobody can widen the trust boundary after deployment. Two consequences follow:

- Adding a settlement module means deploying a new `EntitlementRedemption` with the longer list. That is a configuration change, not a source change.
- **A redeployment starts with empty redemption state.** `redeemedAt` lives in this contract, so an entitlement already redeemed against an older deployment can be redeemed again against a newer one. Redeploying to widen the set is not free; a migration must account for already-redeemed references, and consumers must treat the redemption contract address as part of the entitlement's identity.

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
4. The buyer authorization is bound to that exact quote. `authorization.from == quote.buyer`, `authorization.value == quote.amount` and `authorization.to == address(this)` are necessary but **not sufficient**: all three match across two different sellers' quotes at the same price, so on their own they let an observed authorization be lifted and spent on an attacker's own listing. The binding that closes this is the nonce: `authorization.nonce` must equal `keccak256(AUTHORIZATION_NONCE_DOMAIN, storeQuoteDigest, paymentSalt)`. The buyer's signature covers the nonce, and the nonce commits to the store's own EIP-712 quote digest — seller, listing, amount, purchase reference and all — so an authorization is spendable on exactly one quote and nothing else.
5. Payment is pulled with `receiveWithAuthorization`, never `transferWithAuthorization`. The token requires `msg.sender == to`, so an authorization naming the adapter is executable only through the adapter. A front-runner who observes it cannot execute the transfer standalone.
6. The purchase reference is consumed exactly once in the shared `PurchaseRefRegistry`, after funds arrive and before any payout.
7. Proceeds are paid using the fee breakdown the store returned, not a local recomputation. The three legs sum to the gross by construction, so the adapter retains no balance.

The submitter is untrusted. Both signatures are verified on-chain and every amount is bound to the quote, so any address may pay the gas.

### Three values, one of which is secret

Three values in this system look like nonces. Two are public payment-path values and one is the redemption credential. **The secret is never derived from, and never derives, either of the others.**

| | `authorization.nonce` | `paymentSalt` | `purchaseRefNonce` |
| --- | --- | --- | --- |
| Purpose | EIP-3009 replay protection, and the binding of an authorization to one quote | Public entropy folded into that nonce so a cancelled authorization can be replaced | Cryptographic secrecy for the redemption preimage bundle |
| Secret? | No | No | **Yes, until redemption** |
| Where it appears | Settlement calldata; emitted in `X402ReceiptSettled` | Settlement calldata | Never in a quote, a 402 response, a settlement request, or any event |
| Derived from | `keccak256(AUTHORIZATION_NONCE_DOMAIN, quoteDigest, paymentSalt)` | Fresh CSPRNG output per payment attempt | Fresh CSPRNG output per purchase |

`authorization.nonce` being derived is what binds a payment to a quote, and every input to that derivation is public: the quote digest is published in the 402 response, and the salt travels in calldata. Deriving it from `purchaseRefNonce` instead would publish the redemption credential to anyone watching a settlement, so it must never be an input. The adapter never sees `purchaseRefNonce` and must never be given it. Do not log it, do not put it in metadata, and do not commit it into `metadataHash`.

### What the adapter does not guarantee

The adapter does not identify or authenticate the buyer's agent. A valid buyer authorization proves control of the buyer key at signing time and nothing more.

`buyerSignature` is passed to the token unmodified, using the `bytes`-signature overload of `receiveWithAuthorization`. FiatTokenV2_2 validates it with `SignatureChecker`, so both EOA ECDSA signatures and ERC-1271 contract-wallet signatures are accepted and a smart-wallet buyer — an AgentKit wallet or a Coinbase Smart Wallet — can pay. The adapter deliberately does not use the `(v, r, s)` overload, which is ECDSA-only. The token is the single rejection point for the buyer signature, matching how the store delegates seller signatures to `SignatureChecker`.

An ERC-1271 wallet decides for itself what signature it honours, so a valid buyer authorization proves whatever that wallet's own policy proves, and nothing more.

The adapter has no owner, no pause switch, and no upgrade path, and holds no funds between transactions. It cannot recover tokens sent to it directly.

### Registry consumer authorization

Settlement consumes a purchase reference, which only registry-owner-authorized modules may do. The registry owner must call `setConsumerAuthorization(<adapter address>, true)` before the adapter can settle anything; until then every call reverts with `UnauthorizedConsumer`. That authorization is also a revocation point: the registry owner can disable the adapter at any time without the adapter having a pause switch of its own.

### Redemption depends on deploy-time configuration

An adapter settlement is redeemable only through an `EntitlementRedemption` that was constructed with that adapter in its accepted set. Deploy the adapter first and pass its address to the redemption deployment; a redemption contract deployed without it rejects every x402 purchase with `EntitlementNotPaid`, permanently, because the set cannot be changed afterwards. `test_AdapterSettlementIsNotRedeemableWhenAdapterIsNotAccepted` pins that failure mode.

## Administration and funds

Neither contract holds funds. Both intentionally have no owner, pause mechanism, or upgrade path.
