// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @notice Minimal interface for the PurchaseRefRegistry deployed on Base mainnet.
/// @dev The signatures match the deployed ABI at
///      0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991.
interface IPurchaseRefRegistry {
    error UnauthorizedConsumer(address consumer);
    error PurchaseRefAlreadyConsumed(bytes32 purchaseRef, address consumer);

    /// @notice Consume a purchase reference once globally, attributed to `msg.sender`.
    /// @dev Reverts with `UnauthorizedConsumer` unless the registry owner has authorized the
    ///      caller with `setConsumerAuthorization`.
    function consume(bytes32 purchaseRef) external;

    /// @notice Registry-owner-only. Listed here for deployment scripts and fork tests; no
    ///         contract in this repository is ever the registry owner.
    function setConsumerAuthorization(address consumer, bool authorized) external;

    function isConsumed(bytes32 purchaseRef) external view returns (bool);

    function consumedBy(bytes32 purchaseRef) external view returns (address);

    function authorizedConsumers(address consumer) external view returns (bool);

    function owner() external view returns (address);
}
