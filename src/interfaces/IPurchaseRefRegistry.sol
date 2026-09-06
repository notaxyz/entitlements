// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @notice Minimal interface for the PurchaseRefRegistry deployed on Base mainnet.
/// @dev The signatures match the deployed ABI at
///      0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991.
interface IPurchaseRefRegistry {
    function consumedBy(bytes32 purchaseRef) external view returns (address);
}
