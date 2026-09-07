// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @notice Minimal EIP-3009 interface for the USDC deployment on Base mainnet
///         (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, FiatTokenV2_2).
interface IEIP3009 {
    /// @notice Pull `value` from `from` using a signed authorization.
    /// @dev The token requires `msg.sender == to`, so only the named recipient can submit the
    ///      authorization. That is what makes an authorization safe to hand to a facilitator:
    ///      nobody else can execute the transfer standalone.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);

    function name() external view returns (string memory);

    function version() external view returns (string memory);
}
