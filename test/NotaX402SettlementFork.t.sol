// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { EntitlementRedemption } from "../src/EntitlementRedemption.sol";
import { NotaX402Settlement } from "../src/NotaX402Settlement.sol";
import { MockERC1271Wallet } from "./mocks/MockERC1271Wallet.sol";
import { IEIP3009 } from "../src/interfaces/IEIP3009.sol";
import { INotaReceiptStore } from "../src/interfaces/INotaReceiptStore.sol";
import { INotaSignedQuoteStore } from "../src/interfaces/INotaSignedQuoteStore.sol";
import { IPurchaseRefRegistry } from "../src/interfaces/IPurchaseRefRegistry.sol";

/// @notice Base-mainnet fork coverage for the x402 settlement adapter.
/// @dev Every settlement consumes a purchase reference, so `setUp` pranks the registry owner to
///      authorize the adapter. Without that one owner transaction every test here would revert
///      with `UnauthorizedConsumer`, which is exactly what happens on a real deployment until the
///      post-deploy step in the README is run. `test_RevertsWhenAdapterIsNotAnAuthorizedConsumer`
///      pins that behaviour deliberately.
contract NotaX402SettlementForkTest is Test {
    address internal constant NOTA_RECEIPT_STORE = 0xf6062F3F52D3E19cb9cc3e027491a5c11D101F88;
    address internal constant PURCHASE_REF_REGISTRY = 0x9AaFfA5787ca332a40B9C98E3e5323A97F96D991;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    uint256 internal constant AMOUNT = 10e6;
    uint256 internal constant BUYER_FUNDING = 1000e6;

    INotaSignedQuoteStore internal store;
    IPurchaseRefRegistry internal registry;
    IEIP3009 internal usdc;
    NotaX402Settlement internal adapter;

    address internal seller;
    uint256 internal sellerKey;
    address internal buyer;
    uint256 internal buyerKey;
    address internal submitter;
    address internal integrator;

    uint256 internal listingId;
    bytes32 internal quoteTypehash;
    bytes32 internal storeDomainSeparator;
    bytes32 internal usdcDomainSeparator;
    bytes32 internal receiveTypehash;

    event X402ReceiptSettled(
        uint256 indexed receiptId,
        address indexed seller,
        address indexed buyer,
        bytes32 purchaseRef,
        uint256 amount,
        bytes32 metadataHash,
        bytes32 agentId,
        bytes32 authorizationNonce
    );

    function setUp() public {
        string memory baseRpcUrl = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(baseRpcUrl).length == 0) {
            vm.skip(true, "BASE_RPC_URL is not set");
        }

        vm.createSelectFork(baseRpcUrl);

        store = INotaSignedQuoteStore(NOTA_RECEIPT_STORE);
        registry = IPurchaseRefRegistry(PURCHASE_REF_REGISTRY);
        usdc = IEIP3009(USDC);

        (seller, sellerKey) = makeAddrAndKey("x402-seller");
        (buyer, buyerKey) = makeAddrAndKey("x402-buyer");
        submitter = makeAddr("x402-facilitator");
        integrator = makeAddr("x402-integrator");

        adapter = new NotaX402Settlement(NOTA_RECEIPT_STORE);

        assertEq(address(adapter.PURCHASE_REF_REGISTRY()), PURCHASE_REF_REGISTRY);
        assertEq(address(adapter.SETTLEMENT_TOKEN()), USDC);

        // The critical post-deploy dependency: the registry owner must authorize the adapter.
        vm.prank(registry.owner());
        registry.setConsumerAuthorization(address(adapter), true);
        assertTrue(registry.authorizedConsumers(address(adapter)));

        vm.prank(seller);
        listingId = store.createListing(
            keccak256("x402-listing"), 0, INotaReceiptStore.ListingMode.SignedQuoteOnly
        );

        quoteTypehash = store.SIGNED_RECEIPT_QUOTE_TYPEHASH();
        storeDomainSeparator = _buildStoreDomainSeparator();
        usdcDomainSeparator = _buildUsdcDomainSeparator();
        receiveTypehash = usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH();

        // The separator is rebuilt from the deployed token's own name, version, and chain id
        // rather than hardcoded, then checked against what the token itself reports.
        assertEq(usdcDomainSeparator, usdc.DOMAIN_SEPARATOR(), "USDC domain separator mismatch");

        deal(USDC, buyer, BUYER_FUNDING);
        assertEq(IERC20(USDC).balanceOf(buyer), BUYER_FUNDING);
    }

    // -------------------------------------------------------------------------
    // Happy path
    // -------------------------------------------------------------------------

    function test_ThirdPartySubmitterSettlesSignedQuote() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("happy-path");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);

        // The whole point: the account paying gas is neither the buyer nor the seller.
        assertNotEq(submitter, buyer);
        assertNotEq(submitter, seller);

        uint256 sellerBefore = IERC20(USDC).balanceOf(seller);

        vm.expectEmit(true, true, true, true, address(adapter));
        emit X402ReceiptSettled(
            1,
            seller,
            buyer,
            quote.purchaseRef,
            quote.amount,
            quote.metadataHash,
            quote.agentId,
            authorization.nonce
        );

        vm.prank(submitter);
        uint256 receiptId = adapter.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, _signAuthorization(authorization)
        );

        assertEq(receiptId, 1);
        assertEq(adapter.nextAdapterReceiptId(), 2);

        assertEq(IERC20(USDC).balanceOf(buyer), BUYER_FUNDING - AMOUNT, "buyer not debited");
        assertEq(IERC20(USDC).balanceOf(seller), sellerBefore + AMOUNT, "seller not paid");
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0, "adapter must hold no funds");

        assertTrue(registry.isConsumed(quote.purchaseRef), "purchaseRef not consumed");
        assertEq(
            registry.consumedBy(quote.purchaseRef),
            address(adapter),
            "purchaseRef must be attributed to the adapter"
        );
        assertTrue(usdc.authorizationState(buyer, authorization.nonce), "nonce not burned");
    }

    /// @dev Adapter receipt ids live in their own id space. The deployed store's counter is
    ///      untouched by a settlement that never enters the store.
    function test_AdapterReceiptIdsAreSeparateFromStoreReceiptIds() public {
        uint256 storeNextReceiptIdBefore = store.nextReceiptId();

        _settle(_defaultQuote("id-space-a"));
        assertEq(adapter.nextAdapterReceiptId(), 2);

        uint256 secondReceiptId = _settle(_defaultQuote("id-space-b"));

        assertEq(secondReceiptId, 2);
        assertEq(store.nextReceiptId(), storeNextReceiptIdBefore, "store counter must not move");
    }

    function test_PaysProtocolIntegratorAndSellerLegs() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("integrator-fee");
        quote.integratorFeeRecipient = integrator;
        quote.integratorFeeAmount = 4e5; // 4% of 10 USDC, inside the 450 bps cap.

        INotaReceiptStore.SignedReceiptPurchaseValidation memory validation =
            store.validateSignedReceiptPurchase(quote, _signQuote(quote), buyer, address(0));

        assertEq(validation.grossAmount, AMOUNT);
        assertEq(validation.integratorFee, quote.integratorFeeAmount);
        assertEq(
            validation.protocolFee + validation.integratorFee + validation.sellerNet,
            AMOUNT,
            "legs must sum to the gross"
        );

        uint256 protocolBefore = IERC20(USDC).balanceOf(validation.protocolFeeRecipient);
        uint256 integratorBefore = IERC20(USDC).balanceOf(integrator);
        uint256 sellerBefore = IERC20(USDC).balanceOf(seller);

        _settle(quote);

        assertEq(IERC20(USDC).balanceOf(integrator), integratorBefore + validation.integratorFee);
        assertEq(IERC20(USDC).balanceOf(seller), sellerBefore + validation.sellerNet);
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0, "adapter must hold no funds");

        if (validation.protocolFee > 0) {
            assertEq(
                IERC20(USDC).balanceOf(validation.protocolFeeRecipient),
                protocolBefore + validation.protocolFee
            );
        } else {
            // The deployed store runs PROTOCOL_FEE_BPS == 0 with a zero FEE_RECIPIENT, so the
            // protocol leg is skipped. Paying it unconditionally would transfer to address(0).
            assertEq(validation.protocolFeeRecipient, address(0));
        }
    }

    /// @dev The whole ETHOnline path in one test: seller quotes, buyer authorizes, a facilitator
    ///      settles through the adapter, and the seller then redeems the entitlement. This is the
    ///      case that used to fail: the registry attributes consumption to the adapter, so a
    ///      redemption contract that accepted only the store rejected every x402 purchase.
    function test_AdapterSettlementIsRedeemable() public {
        address[] memory additionalConsumers = new address[](1);
        additionalConsumers[0] = address(adapter);
        EntitlementRedemption redemption =
            new EntitlementRedemption(NOTA_RECEIPT_STORE, additionalConsumers);

        assertTrue(redemption.isAcceptedConsumer(address(adapter)));
        assertTrue(redemption.isAcceptedConsumer(NOTA_RECEIPT_STORE));

        // The redemption preimage bundle. `purchaseRefNonce` is generated independently of the
        // EIP-3009 authorization nonce and never reaches the adapter or any settlement calldata.
        string memory rawPurchaseRef = "nota_x402_demo_order_1";
        bytes32 purchaseRefNonce = keccak256("independently-generated-redemption-nonce");

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("redeemable");
        quote.purchaseRef =
            store.hashPurchaseRef(seller, listingId, rawPurchaseRef, purchaseRefNonce);

        _settle(quote);

        assertEq(
            registry.consumedBy(quote.purchaseRef),
            address(adapter),
            "the adapter, not the store, is recorded as the consumer"
        );

        vm.prank(seller);
        bytes32 redeemed = redemption.redeemEntitlement(listingId, rawPurchaseRef, purchaseRefNonce);

        assertEq(redeemed, quote.purchaseRef);
        assertEq(uint256(redemption.redeemedAt(quote.purchaseRef)), block.timestamp);

        // Still exactly once.
        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementRedemption.EntitlementAlreadyRedeemed.selector, quote.purchaseRef
            )
        );
        vm.prank(seller);
        redemption.redeemEntitlement(listingId, rawPurchaseRef, purchaseRefNonce);
    }

    /// @dev A redemption contract that does not accept the adapter still rejects its settlements.
    ///      Pins the deploy-time configuration as the thing that matters.
    function test_AdapterSettlementIsNotRedeemableWhenAdapterIsNotAccepted() public {
        EntitlementRedemption redemption =
            new EntitlementRedemption(NOTA_RECEIPT_STORE, new address[](0));

        string memory rawPurchaseRef = "nota_x402_unaccepted_order";
        bytes32 purchaseRefNonce = keccak256("unaccepted-adapter-nonce");

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("not-redeemable");
        quote.purchaseRef =
            store.hashPurchaseRef(seller, listingId, rawPurchaseRef, purchaseRefNonce);

        _settle(quote);

        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementRedemption.EntitlementNotPaid.selector, quote.purchaseRef
            )
        );
        vm.prank(seller);
        redemption.redeemEntitlement(listingId, rawPurchaseRef, purchaseRefNonce);
    }

    // -------------------------------------------------------------------------
    // Authorization binding
    // -------------------------------------------------------------------------

    function test_RevertsWhenAuthorizationPayerIsNotQuoteBuyer() public {
        (address otherPayer, uint256 otherPayerKey) = makeAddrAndKey("x402-other-payer");
        deal(USDC, otherPayer, BUYER_FUNDING);

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("payer-mismatch");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);
        authorization.from = otherPayer;

        // Signed correctly by the other payer, so USDC itself would accept it. The adapter must
        // reject it first because the seller never quoted that buyer.
        vm.expectRevert(
            abi.encodeWithSelector(
                NotaX402Settlement.AuthorizationPayerMismatch.selector, otherPayer, buyer
            )
        );
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote,
            _signQuote(quote),
            address(0),
            authorization,
            _signAuthorizationWith(authorization, otherPayerKey)
        );
    }

    function test_RevertsWhenAuthorizationRecipientIsNotAdapter() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("recipient-mismatch");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);
        authorization.to = seller;

        vm.expectRevert(
            abi.encodeWithSelector(
                NotaX402Settlement.AuthorizationRecipientMismatch.selector, seller, address(adapter)
            )
        );
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_RevertsWhenAuthorizationValueIsNotQuoteAmount() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("value-mismatch");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);
        authorization.value = AMOUNT - 1;

        vm.expectRevert(
            abi.encodeWithSelector(
                NotaX402Settlement.AuthorizationValueMismatch.selector, AMOUNT - 1, AMOUNT
            )
        );
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_RevertsForUnboundQuote() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("unbound");
        quote.buyer = address(0);

        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);

        // The store would happily validate this quote for any payer. The adapter will not.
        vm.expectRevert(NotaX402Settlement.UnboundQuote.selector);
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_RevertsWhenTokenRejectsTheBuyerSignature() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("bad-buyer-signature");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);

        // The adapter does not pre-validate the signature; the token is the single rejection
        // point, exactly as the store delegates seller signatures to SignatureChecker.
        vm.expectRevert(bytes("ECRecover: invalid signature length"));
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, new bytes(64)
        );
    }

    /// @dev The buyer is an ERC-1271 contract wallet, not an EOA. Day four's AgentKit buyer may
    ///      be a Coinbase Smart Wallet, so the adapter uses the token's `bytes`-signature
    ///      overload rather than the ECDSA-only `(v, r, s)` one.
    function test_SmartContractWalletBuyerCanPay() public {
        (address walletOwner, uint256 walletOwnerKey) = makeAddrAndKey("x402-smart-wallet-owner");
        address wallet = address(new MockERC1271Wallet(walletOwner));
        deal(USDC, wallet, BUYER_FUNDING);

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("erc1271-buyer");
        quote.buyer = wallet;

        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);
        assertEq(authorization.from, wallet);

        uint256 sellerBefore = IERC20(USDC).balanceOf(seller);

        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote,
            _signQuote(quote),
            address(0),
            authorization,
            _signAuthorizationWith(authorization, walletOwnerKey)
        );

        assertEq(IERC20(USDC).balanceOf(wallet), BUYER_FUNDING - AMOUNT, "wallet not debited");
        assertEq(IERC20(USDC).balanceOf(seller), sellerBefore + AMOUNT, "seller not paid");
        assertTrue(registry.isConsumed(quote.purchaseRef));
    }

    function test_RevertsWhenSmartWalletDisownsTheSignature() public {
        (address walletOwner,) = makeAddrAndKey("x402-other-wallet-owner");
        address wallet = address(new MockERC1271Wallet(walletOwner));
        deal(USDC, wallet, BUYER_FUNDING);

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("erc1271-wrong-signer");
        quote.buyer = wallet;

        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);

        // Signed by the ordinary buyer key, which this wallet does not recognise.
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, _signAuthorization(authorization)
        );
    }

    // -------------------------------------------------------------------------
    // Replay and expiry
    // -------------------------------------------------------------------------

    function test_RevertsWhenAuthorizationNonceIsReplayed() public {
        INotaReceiptStore.SignedReceiptQuote memory firstQuote = _defaultQuote("nonce-replay-a");
        NotaX402Settlement.ReceiveAuthorization memory authorization =
            _defaultAuthorization(firstQuote);

        vm.prank(submitter);
        adapter.settleWithAuthorization(
            firstQuote,
            _signQuote(firstQuote),
            address(0),
            authorization,
            _signAuthorization(authorization)
        );

        // A fresh purchaseRef clears the store and the registry, so the only thing left to stop
        // this is USDC's own nonce bookkeeping.
        INotaReceiptStore.SignedReceiptQuote memory secondQuote = _defaultQuote("nonce-replay-b");

        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            secondQuote,
            _signQuote(secondQuote),
            address(0),
            authorization,
            _signAuthorization(authorization)
        );
    }

    /// @dev A consumed reference is rejected twice over. The store's view is the first gate, so
    ///      that is the revert callers actually see; the registry's own guard sits underneath it
    ///      and is asserted directly here.
    function test_RevertsWhenPurchaseRefIsReplayed() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("ref-replay");
        _settle(quote);

        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);
        authorization.nonce = keccak256("ref-replay-second-nonce");

        vm.expectRevert(INotaReceiptStore.PurchaseRefAlreadyUsed.selector);
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, _signAuthorization(authorization)
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                IPurchaseRefRegistry.PurchaseRefAlreadyConsumed.selector,
                quote.purchaseRef,
                address(adapter)
            )
        );
        vm.prank(address(adapter));
        registry.consume(quote.purchaseRef);
    }

    function test_RevertsForExpiredAuthorization() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("expired-authorization");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);
        authorization.validBefore = block.timestamp - 1;

        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_RevertsForExpiredQuote() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("expired-quote");
        quote.issuedAt = uint64(block.timestamp - 2 hours);
        quote.expiresAt = uint64(block.timestamp - 1 hours);

        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);

        vm.expectRevert(INotaReceiptStore.QuoteExpired.selector);
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_RevertsForQuoteSignedByAnotherKey() public {
        (, uint256 impostorKey) = makeAddrAndKey("x402-impostor");

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("bad-seller-signature");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);

        vm.expectRevert(INotaReceiptStore.InvalidQuoteSigner.selector);
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote,
            _signQuoteWith(quote, impostorKey),
            address(0),
            authorization,
            _signAuthorization(authorization)
        );
    }

    // -------------------------------------------------------------------------
    // Registry authorization
    // -------------------------------------------------------------------------

    /// @dev Pins the post-deploy dependency: without the registry owner's
    ///      `setConsumerAuthorization` call, every settlement reverts.
    function test_RevertsWhenAdapterIsNotAnAuthorizedConsumer() public {
        NotaX402Settlement unauthorized = new NotaX402Settlement(NOTA_RECEIPT_STORE);
        assertFalse(registry.authorizedConsumers(address(unauthorized)));

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("unauthorized-consumer");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);
        authorization.to = address(unauthorized);

        vm.expectRevert(
            abi.encodeWithSelector(
                IPurchaseRefRegistry.UnauthorizedConsumer.selector, address(unauthorized)
            )
        );
        vm.prank(submitter);
        unauthorized.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, _signAuthorization(authorization)
        );
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _settle(INotaReceiptStore.SignedReceiptQuote memory quote)
        internal
        returns (uint256 receiptId)
    {
        NotaX402Settlement.ReceiveAuthorization memory authorization = _defaultAuthorization(quote);

        vm.prank(submitter);
        receiptId = adapter.settleWithAuthorization(
            quote, _signQuote(quote), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function _defaultQuote(string memory label)
        internal
        view
        returns (INotaReceiptStore.SignedReceiptQuote memory quote)
    {
        quote = INotaReceiptStore.SignedReceiptQuote({
            listingId: listingId,
            buyer: buyer,
            purchaseRef: keccak256(abi.encodePacked("x402-purchase-ref:", label)),
            amount: AMOUNT,
            metadataHash: keccak256(abi.encodePacked("x402-metadata:", label)),
            agentId: keccak256("x402-agent"),
            integratorFeeRecipient: address(0),
            integratorFeeAmount: 0,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 hours)
        });
    }

    function _defaultAuthorization(INotaReceiptStore.SignedReceiptQuote memory quote)
        internal
        view
        returns (NotaX402Settlement.ReceiveAuthorization memory)
    {
        return NotaX402Settlement.ReceiveAuthorization({
            from: quote.buyer == address(0) ? buyer : quote.buyer,
            to: address(adapter),
            value: quote.amount,
            validAfter: 0,
            validBefore: block.timestamp + 1 hours,
            // Deliberately unrelated to any purchaseRefNonce: this value becomes public the
            // moment the payment is submitted.
            nonce: keccak256(abi.encodePacked("x402-authorization-nonce:", quote.purchaseRef))
        });
    }

    function _signQuote(INotaReceiptStore.SignedReceiptQuote memory quote)
        internal
        view
        returns (bytes memory)
    {
        return _signQuoteWith(quote, sellerKey);
    }

    function _signQuoteWith(INotaReceiptStore.SignedReceiptQuote memory quote, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        return _sign(key, _quoteDigest(quote));
    }

    function _signAuthorization(NotaX402Settlement.ReceiveAuthorization memory authorization)
        internal
        view
        returns (bytes memory)
    {
        return _signAuthorizationWith(authorization, buyerKey);
    }

    function _signAuthorizationWith(
        NotaX402Settlement.ReceiveAuthorization memory authorization,
        uint256 key
    ) internal view returns (bytes memory) {
        return _sign(key, _authorizationDigest(authorization));
    }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _quoteDigest(INotaReceiptStore.SignedReceiptQuote memory quote)
        internal
        view
        returns (bytes32)
    {
        // Encoded in two halves exactly as the store does. Every member is a 32-byte value type,
        // so the concatenation is byte-identical to a single abi.encode of all thirteen members.
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(
                    quoteTypehash,
                    quote.listingId,
                    seller,
                    quote.buyer,
                    quote.purchaseRef,
                    quote.amount,
                    quote.metadataHash,
                    quote.agentId
                ),
                abi.encode(
                    USDC,
                    PURCHASE_REF_REGISTRY,
                    quote.integratorFeeRecipient,
                    quote.integratorFeeAmount,
                    quote.issuedAt,
                    quote.expiresAt
                )
            )
        );

        return keccak256(abi.encodePacked(hex"1901", storeDomainSeparator, structHash));
    }

    function _authorizationDigest(NotaX402Settlement.ReceiveAuthorization memory authorization)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                receiveTypehash,
                authorization.from,
                authorization.to,
                authorization.value,
                authorization.validAfter,
                authorization.validBefore,
                authorization.nonce
            )
        );

        return keccak256(abi.encodePacked(hex"1901", usdcDomainSeparator, structHash));
    }

    /// @dev Built from what the deployed store reports through EIP-5267, not hardcoded.
    function _buildStoreDomainSeparator() internal view returns (bytes32) {
        (
            ,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,,
        ) = store.eip712Domain();

        return _domainSeparator(name, version, chainId, verifyingContract);
    }

    /// @dev Built from the deployed token's own name, version, and chain id, not hardcoded.
    function _buildUsdcDomainSeparator() internal view returns (bytes32) {
        return _domainSeparator(usdc.name(), usdc.version(), block.chainid, USDC);
    }

    function _domainSeparator(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }
}
