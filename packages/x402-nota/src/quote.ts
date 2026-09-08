import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";

import { eip3009Abi } from "./abi.js";
import type { ReceiveAuthorization, SignedReceiptQuote } from "./types.js";

/**
 * The store hashes thirteen members, and `seller` is one of them even though it is not a field of
 * `SignedReceiptQuote` -- the contract takes it from the listing. Signing therefore needs the
 * seller passed alongside the quote.
 */
export const SIGNED_RECEIPT_QUOTE_TYPES = {
  SignedReceiptQuote: [
    { name: "listingId", type: "uint256" },
    { name: "seller", type: "address" },
    { name: "buyer", type: "address" },
    { name: "purchaseRef", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "metadataHash", type: "bytes32" },
    { name: "agentId", type: "bytes32" },
    { name: "settlementToken", type: "address" },
    { name: "purchaseRefRegistry", type: "address" },
    { name: "integratorFeeRecipient", type: "address" },
    { name: "integratorFeeAmount", type: "uint256" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface QuoteSigningContext {
  chainId: number;
  store: Address;
  settlementToken: Address;
  purchaseRefRegistry: Address;
  seller: Address;
}

export function signedQuoteTypedData(quote: SignedReceiptQuote, context: QuoteSigningContext) {
  return {
    domain: {
      name: "NotaReceiptStore",
      version: "2",
      chainId: context.chainId,
      verifyingContract: context.store,
    },
    types: SIGNED_RECEIPT_QUOTE_TYPES,
    primaryType: "SignedReceiptQuote",
    message: {
      listingId: quote.listingId,
      seller: context.seller,
      buyer: quote.buyer,
      purchaseRef: quote.purchaseRef,
      amount: quote.amount,
      metadataHash: quote.metadataHash,
      agentId: quote.agentId,
      settlementToken: context.settlementToken,
      purchaseRefRegistry: context.purchaseRefRegistry,
      integratorFeeRecipient: quote.integratorFeeRecipient,
      integratorFeeAmount: quote.integratorFeeAmount,
      issuedAt: quote.issuedAt,
      expiresAt: quote.expiresAt,
    },
  } as const;
}

export async function signQuote(
  wallet: WalletClient<Transport, Chain | undefined, Account>,
  quote: SignedReceiptQuote,
  context: QuoteSigningContext,
): Promise<Hex> {
  const typedData = signedQuoteTypedData(quote, context);
  return wallet.signTypedData({
    account: wallet.account,
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}

export interface TokenDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/**
 * Reads the settlement token's own EIP-712 domain fields rather than hardcoding them, so a buyer
 * signs against what the deployed token actually reports.
 */
export async function readTokenDomain(
  client: PublicClient,
  token: Address,
  chainId: number,
): Promise<TokenDomain> {
  const [name, version] = await Promise.all([
    client.readContract({ address: token, abi: eip3009Abi, functionName: "name" }),
    client.readContract({ address: token, abi: eip3009Abi, functionName: "version" }),
  ]);

  return { name, version, chainId, verifyingContract: token };
}

export function receiveAuthorizationTypedData(
  authorization: ReceiveAuthorization,
  domain: TokenDomain,
) {
  return {
    domain,
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  } as const;
}

export async function signReceiveAuthorization(
  wallet: WalletClient<Transport, Chain | undefined, Account>,
  authorization: ReceiveAuthorization,
  domain: TokenDomain,
): Promise<Hex> {
  const typedData = receiveAuthorizationTypedData(authorization, domain);
  return wallet.signTypedData({
    account: wallet.account,
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });
}
