# Upstream Dependency: Nota Receipt Protocol

This layer depends on the Nota receipt protocol, pinned as of **2026-09-06T15:56:58Z**, before any entitlement code was added to this repository.

## Upstream protocol

The upstream implementation lives in [`notaxyz/contracts`](https://github.com/notaxyz/contracts) at commit [`238cb210e1342892c122b794563b1db99bd4b891`](https://github.com/notaxyz/contracts/tree/238cb210e1342892c122b794563b1db99bd4b891). That repository is not copied into or modified by this project.

This layer depends on the following contracts deployed on Base mainnet:

| Contract | Address |
| --- | --- |
| `NotaReceiptStore` | [`0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88`](https://basescan.org/address/0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88) |
| `PurchaseRefRegistry` | [`0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991`](https://basescan.org/address/0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991) |
| USDC | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |

The upstream protocol provides a seller-signed EIP-712 quote flowing through USDC settlement to an immutable `ReceiptPurchasedV2` event. During settlement, `PurchaseRefRegistry` consumes the quote's `purchaseRef` globally and exactly once.

## What this repository adds

This repository adds two layers over the deployed Nota contracts.

The first is an entitlement layer. It reconstructs a paid purchase reference through the deployed `NotaReceiptStore`, verifies that the deployed registry consumed it, authorizes redemption by the listing seller, and records one redemption for that globally unique purchase reference.

The second is an x402 settlement adapter. It lets a buyer pay a seller-signed Nota quote with an EIP-3009 authorization instead of an `approve` + `transferFrom`, so a facilitator can submit the settlement and the buyer needs no ETH. It delegates validation and fee math to the deployed store's `validateSignedReceiptPurchase` and consumes the quote's purchase reference through the deployed registry.

Both contracts, their minimal deployed-ABI interfaces, Base-mainnet fork tests, the deployment script, and supporting documentation are part of this repository.
