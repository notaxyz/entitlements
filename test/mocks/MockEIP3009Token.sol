// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Deterministic stand-in for the EIP-3009 settlement token, modelled on the
///         FiatTokenV2_2 deployment of USDC on Base.
/// @dev Only the `bytes`-signature overload of `receiveWithAuthorization` is implemented, which
///      is the one the adapter uses. Signatures are checked with `SignatureChecker`, so EOA and
///      ERC-1271 signers both work, matching the deployed token.
///
///      The `msg.sender == to` rule is the security-relevant part: it is what makes a signed
///      authorization safe to hand to a facilitator, so it is enforced here rather than stubbed.
contract MockEIP3009Token is ERC20, EIP712 {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address authorizer => mapping(bytes32 nonce => bool used)) public authorizationState;

    error CallerMustBeThePayee(address caller, address payee);
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidAuthorizationSignature();

    constructor() ERC20("Mock USD Coin", "mUSDC") EIP712("Mock USD Coin", "2") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 value) external {
        _mint(to, value);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        // The reason the adapter uses this call rather than transferWithAuthorization: only the
        // named payee can submit it, so an observer cannot execute the transfer standalone.
        if (msg.sender != to) revert CallerMustBeThePayee(msg.sender, to);
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationAlreadyUsed();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                    from,
                    to,
                    value,
                    validAfter,
                    validBefore,
                    nonce
                )
            )
        );

        if (!SignatureChecker.isValidSignatureNow(from, digest, signature)) {
            revert InvalidAuthorizationSignature();
        }

        authorizationState[from][nonce] = true;

        _transfer(from, to, value);
    }
}
