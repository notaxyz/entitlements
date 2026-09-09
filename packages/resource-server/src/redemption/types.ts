import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";

export interface RedemptionInput {
  listingId: string;
  purchaseTxHash: Hex;
  rawPurchaseRef: string;
  purchaseRefNonce: Hex;
}

/** Only static, reviewed messages may cross the HTTP/log boundary. Never wrap RPC errors. */
export class RedemptionError extends Error {
  constructor(
    public code: string,
    public step: number,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseInput(value: unknown): RedemptionInput {
  const fail = () =>
    new RedemptionError(
      "INVALID_REQUEST",
      0,
      400,
      "Invalid redemption request",
    );
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const input = value as Record<string, unknown>;
  const keys = [
    "listingId",
    "purchaseTxHash",
    "rawPurchaseRef",
    "purchaseRefNonce",
  ];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw fail();
  if (
    typeof input.listingId !== "string" ||
    !/^[1-9][0-9]{0,77}$/.test(input.listingId) ||
    BigInt(input.listingId) >= 2n ** 256n
  )
    throw fail();
  if (
    typeof input.rawPurchaseRef !== "string" ||
    Buffer.byteLength(input.rawPurchaseRef) > 4096
  )
    throw fail();
  for (const key of ["purchaseTxHash", "purchaseRefNonce"] as const) {
    if (
      typeof input[key] !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(input[key])
    )
      throw fail();
  }
  return {
    listingId: input.listingId,
    purchaseTxHash: (input.purchaseTxHash as string).toLowerCase() as Hex,
    rawPurchaseRef: input.rawPurchaseRef,
    purchaseRefNonce: (input.purchaseRefNonce as string).toLowerCase() as Hex,
  };
}

export function inputDigest(input: RedemptionInput): Hex {
  // This is a request binding, NOT a reimplementation of Nota's purchaseRef hash.
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "bytes32" },
        { type: "string" },
        { type: "bytes32" },
      ],
      [
        BigInt(input.listingId),
        input.purchaseTxHash,
        input.rawPurchaseRef,
        input.purchaseRefNonce,
      ],
    ),
  );
}

export function requireAddress(value: unknown): Address {
  if (
    typeof value !== "string" ||
    !isAddress(value) ||
    /^0x0{40}$/i.test(value)
  ) {
    throw new RedemptionError(
      "INVALID_ADDRESS",
      0,
      400,
      "A nonzero wallet address is required",
    );
  }
  return getAddress(value);
}
