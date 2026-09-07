// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Minimal ERC-1271 smart-contract wallet, standing in for an AgentKit or Coinbase Smart
///         Wallet buyer that signs EIP-3009 authorizations without being an EOA.
contract MockERC1271Wallet {
    bytes4 internal constant ERC1271_MAGIC_VALUE = 0x1626ba7e;

    address public immutable OWNER;

    constructor(address owner) {
        OWNER = owner;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);

        if (error == ECDSA.RecoverError.NoError && recovered == OWNER) {
            return ERC1271_MAGIC_VALUE;
        }

        return 0xffffffff;
    }
}
