// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { NotaX402Settlement } from "../src/NotaX402Settlement.sol";
import { INotaReceiptStore } from "../src/interfaces/INotaReceiptStore.sol";
import { IPurchaseRefRegistry } from "../src/interfaces/IPurchaseRefRegistry.sol";
import { MockEIP3009Token } from "./mocks/MockEIP3009Token.sol";
import { MockERC1271Wallet } from "./mocks/MockERC1271Wallet.sol";
import { MockPurchaseRefRegistry, MockSignedQuoteStore } from "./mocks/MockNota.sol";

/// @notice Deterministic coverage for the x402 settlement adapter.
/// @dev This is the suite CI runs: it needs no RPC and no deployed contracts. The Base-mainnet
///      fork suite in `NotaX402SettlementFork.t.sol` is the against-real-deployment layer and
///      covers what only the deployed store, registry, and USDC can prove.
contract NotaX402SettlementTest is Test {
    uint256 internal constant AMOUNT = 10e6;
    uint256 internal constant BUYER_FUNDING = 1000e6;

    MockPurchaseRefRegistry internal registry;
    MockSignedQuoteStore internal store;
    MockEIP3009Token internal token;
    NotaX402Settlement internal adapter;

    address internal seller;
    address internal buyer;
    uint256 internal buyerKey;
    address internal submitter;
    address internal integrator;
    address internal protocolFeeRecipient;

    uint256 internal listingId;
    bytes32 internal receiveTypehash;
    bytes32 internal tokenDomainSeparator;

    event X402ReceiptSettled(
        uint256 indexed receiptId,
        address indexed seller,
        address indexed buyer,
        uint256 listingId,
        bytes32 purchaseRef,
        uint256 amount,
        bytes32 metadataHash,
        bytes32 agentId,
        bytes32 authorizationNonce
    );

    function setUp() public {
        vm.warp(1_700_000_000);

        seller = makeAddr("seller");
        (buyer, buyerKey) = makeAddrAndKey("buyer");
        submitter = makeAddr("facilitator");
        integrator = makeAddr("integrator");
        protocolFeeRecipient = makeAddr("protocol-fee-recipient");

        registry = new MockPurchaseRefRegistry();
        token = new MockEIP3009Token();
        store = new MockSignedQuoteStore(address(registry), address(token));

        adapter = new NotaX402Settlement(address(store));
        registry.setConsumerAuthorization(address(adapter), true);

        vm.prank(seller);
        listingId = store.createListing(
            keccak256("listing"), 0, INotaReceiptStore.ListingMode.SignedQuoteOnly
        );

        token.mint(buyer, BUYER_FUNDING);

        // Cached because signing helpers run inside calls already armed with vm.expectRevert,
        // where a live external call to the token would be mistaken for the expected one.
        receiveTypehash = token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH();
        tokenDomainSeparator = token.DOMAIN_SEPARATOR();
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    function test_ConstructorDiscoversRegistryAndToken() public view {
        assertEq(address(adapter.STORE()), address(store));
        assertEq(address(adapter.PURCHASE_REF_REGISTRY()), address(registry));
        assertEq(address(adapter.SETTLEMENT_TOKEN()), address(token));
        assertEq(adapter.nextAdapterReceiptId(), 1);
    }

    function test_ConstructorRejectsZeroStore() public {
        vm.expectRevert(NotaX402Settlement.InvalidStore.selector);
        new NotaX402Settlement(address(0));
    }

    // -------------------------------------------------------------------------
    // Happy path
    // -------------------------------------------------------------------------

    function test_ThirdPartySubmitterSettlesSignedQuote() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("happy");

        assertNotEq(submitter, buyer);
        assertNotEq(submitter, seller);

        vm.prank(submitter);
        uint256 receiptId = _settle(quote);

        assertEq(receiptId, 1);
        assertEq(adapter.nextAdapterReceiptId(), 2);
        assertEq(token.balanceOf(buyer), BUYER_FUNDING - AMOUNT);
        assertEq(token.balanceOf(seller), AMOUNT);
        assertEq(token.balanceOf(address(adapter)), 0, "adapter must hold no funds");
        assertEq(registry.consumedBy(quote.purchaseRef), address(adapter));
    }

    function test_EmitsEveryEventFieldIncludingListingId() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("event-fields");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(quote);

        vm.expectEmit(true, true, true, true, address(adapter));
        emit X402ReceiptSettled(
            1,
            seller,
            buyer,
            listingId,
            quote.purchaseRef,
            AMOUNT,
            quote.metadataHash,
            quote.agentId,
            authorization.nonce
        );

        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _sellerSignature(), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_ReceiptIdsIncrementPerSettlement() public {
        vm.prank(submitter);
        assertEq(_settle(_defaultQuote("first")), 1);

        vm.prank(submitter);
        assertEq(_settle(_defaultQuote("second")), 2);
    }

    // -------------------------------------------------------------------------
    // Fee legs
    // -------------------------------------------------------------------------

    function test_PaysAllThreeLegsWhenIntegratorFeeIsPresent() public {
        store.setProtocolFee(50, protocolFeeRecipient);

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("three-legs");
        quote.integratorFeeRecipient = integrator;
        quote.integratorFeeAmount = 4e5;

        uint256 expectedProtocolFee = AMOUNT * 50 / 10_000;
        uint256 expectedSellerNet = AMOUNT - expectedProtocolFee - quote.integratorFeeAmount;

        vm.prank(submitter);
        _settle(quote);

        assertEq(token.balanceOf(protocolFeeRecipient), expectedProtocolFee, "protocol leg");
        assertEq(token.balanceOf(integrator), quote.integratorFeeAmount, "integrator leg");
        assertEq(token.balanceOf(seller), expectedSellerNet, "seller leg");
        assertEq(
            expectedProtocolFee + quote.integratorFeeAmount + expectedSellerNet,
            AMOUNT,
            "legs must sum to the gross"
        );
        assertEq(token.balanceOf(address(adapter)), 0, "adapter must hold no funds");
    }

    /// @dev The deployed store runs PROTOCOL_FEE_BPS == 0 with FEE_RECIPIENT == address(0), so
    ///      skipping a zero leg is load-bearing: paying it would transfer to address(0), which
    ///      any conforming ERC-20 rejects.
    function test_SkipsZeroProtocolLegRatherThanTransferringToAddressZero() public {
        assertEq(store.protocolFeeBps(), 0);
        assertEq(store.protocolFeeRecipient(), address(0));

        vm.prank(submitter);
        _settle(_defaultQuote("zero-protocol-leg"));

        assertEq(token.balanceOf(address(0)), 0, "nothing may be sent to address(0)");
        assertEq(token.balanceOf(seller), AMOUNT, "seller receives the whole gross");
    }

    function test_RevertsWhenStoreLegsDoNotSumToTheGross() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("bad-accounting");

        // A store whose breakdown leaves a unit behind would strand tokens in the adapter.
        store.setCannedValidation(
            INotaReceiptStore.SignedReceiptPurchaseValidation({
                grossAmount: AMOUNT,
                protocolFee: 0,
                integratorFee: 0,
                sellerNet: AMOUNT - 1,
                protocolFeeRecipient: address(0),
                integratorFeeRecipient: address(0),
                seller: seller,
                listingHash: keccak256("listing"),
                verifiedSigner: seller
            })
        );

        vm.expectRevert(NotaX402Settlement.SettlementAccountingMismatch.selector);
        vm.prank(submitter);
        _settle(quote);
    }

    function test_RevertsWhenStoreGrossDiffersFromQuoteAmount() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("bad-gross");

        store.setCannedValidation(
            INotaReceiptStore.SignedReceiptPurchaseValidation({
                grossAmount: AMOUNT - 1,
                protocolFee: 0,
                integratorFee: 0,
                sellerNet: AMOUNT - 1,
                protocolFeeRecipient: address(0),
                integratorFeeRecipient: address(0),
                seller: seller,
                listingHash: keccak256("listing"),
                verifiedSigner: seller
            })
        );

        vm.expectRevert(NotaX402Settlement.SettlementAccountingMismatch.selector);
        vm.prank(submitter);
        _settle(quote);
    }

    // -------------------------------------------------------------------------
    // Authorization binding
    // -------------------------------------------------------------------------

    function test_RevertsWhenAuthorizationPayerIsNotQuoteBuyer() public {
        (address otherPayer, uint256 otherPayerKey) = makeAddrAndKey("other-payer");
        token.mint(otherPayer, BUYER_FUNDING);

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("payer-mismatch");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(quote);
        authorization.from = otherPayer;

        vm.expectRevert(
            abi.encodeWithSelector(
                NotaX402Settlement.AuthorizationPayerMismatch.selector, otherPayer, buyer
            )
        );
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote,
            _sellerSignature(),
            address(0),
            authorization,
            _signAuthorizationWith(authorization, otherPayerKey)
        );
    }

    function test_RevertsWhenAuthorizationRecipientIsNotAdapter() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("recipient-mismatch");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(quote);
        authorization.to = seller;

        vm.expectRevert(
            abi.encodeWithSelector(
                NotaX402Settlement.AuthorizationRecipientMismatch.selector, seller, address(adapter)
            )
        );
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _sellerSignature(), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_RevertsWhenAuthorizationValueIsNotQuoteAmount() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("value-mismatch");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(quote);
        authorization.value = AMOUNT - 1;

        vm.expectRevert(
            abi.encodeWithSelector(
                NotaX402Settlement.AuthorizationValueMismatch.selector, AMOUNT - 1, AMOUNT
            )
        );
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _sellerSignature(), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_RevertsForUnboundQuote() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("unbound");
        quote.buyer = address(0);

        vm.expectRevert(NotaX402Settlement.UnboundQuote.selector);
        vm.prank(submitter);
        _settle(quote);
    }

    /// @dev Only the named payee can submit a `receiveWithAuthorization`, which is what makes an
    ///      authorization safe to hand to a facilitator. Nobody can execute it standalone.
    function test_AuthorizationCannotBeExecutedOutsideTheAdapter() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("standalone");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(quote);

        vm.expectRevert(
            abi.encodeWithSelector(
                MockEIP3009Token.CallerMustBeThePayee.selector, submitter, address(adapter)
            )
        );
        vm.prank(submitter);
        token.receiveWithAuthorization(
            authorization.from,
            authorization.to,
            authorization.value,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce,
            _signAuthorization(authorization)
        );
    }

    // -------------------------------------------------------------------------
    // Store and registry gates
    // -------------------------------------------------------------------------

    function test_RevertsWhenStorePurchasesArePaused() public {
        store.setPurchasesPaused(true);

        vm.expectRevert(NotaX402Settlement.StorePurchasesPaused.selector);
        vm.prank(submitter);
        _settle(_defaultQuote("paused"));
    }

    function test_RevertsWhenAdapterIsNotAnAuthorizedConsumer() public {
        registry.setConsumerAuthorization(address(adapter), false);

        vm.expectRevert(
            abi.encodeWithSelector(
                IPurchaseRefRegistry.UnauthorizedConsumer.selector, address(adapter)
            )
        );
        vm.prank(submitter);
        _settle(_defaultQuote("unauthorized"));
    }

    function test_RevertsWhenStoreRejectsTheQuote() public {
        store.setQuoteSignatureAccepted(false);

        vm.expectRevert(INotaReceiptStore.InvalidQuoteSigner.selector);
        vm.prank(submitter);
        _settle(_defaultQuote("bad-seller-signature"));
    }

    // -------------------------------------------------------------------------
    // Replay and expiry
    // -------------------------------------------------------------------------

    function test_RevertsWhenPurchaseRefIsReplayed() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("ref-replay");

        vm.prank(submitter);
        _settle(quote);

        vm.expectRevert(INotaReceiptStore.PurchaseRefAlreadyUsed.selector);
        vm.prank(submitter);
        _settle(quote);
    }

    function test_RevertsWhenAuthorizationNonceIsReplayed() public {
        INotaReceiptStore.SignedReceiptQuote memory first = _defaultQuote("nonce-replay-a");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(first);

        vm.prank(submitter);
        adapter.settleWithAuthorization(
            first, _sellerSignature(), address(0), authorization, _signAuthorization(authorization)
        );

        INotaReceiptStore.SignedReceiptQuote memory second = _defaultQuote("nonce-replay-b");

        vm.expectRevert(MockEIP3009Token.AuthorizationAlreadyUsed.selector);
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            second, _sellerSignature(), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_RevertsForExpiredAuthorization() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("expired-authorization");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(quote);
        authorization.validBefore = block.timestamp - 1;

        vm.expectRevert(MockEIP3009Token.AuthorizationExpired.selector);
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _sellerSignature(), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_RevertsForAuthorizationThatIsNotYetValid() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("premature-authorization");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(quote);
        authorization.validAfter = block.timestamp + 1 hours;

        vm.expectRevert(MockEIP3009Token.AuthorizationNotYetValid.selector);
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote, _sellerSignature(), address(0), authorization, _signAuthorization(authorization)
        );
    }

    function test_RevertsForExpiredQuote() public {
        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("expired-quote");
        quote.expiresAt = uint64(block.timestamp - 1);

        vm.expectRevert(INotaReceiptStore.QuoteExpired.selector);
        vm.prank(submitter);
        _settle(quote);
    }

    // -------------------------------------------------------------------------
    // Buyer signature
    // -------------------------------------------------------------------------

    function test_SmartContractWalletBuyerCanPay() public {
        (address walletOwner, uint256 walletOwnerKey) = makeAddrAndKey("smart-wallet-owner");
        address wallet = address(new MockERC1271Wallet(walletOwner));
        token.mint(wallet, BUYER_FUNDING);

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("erc1271");
        quote.buyer = wallet;

        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(quote);

        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote,
            _sellerSignature(),
            address(0),
            authorization,
            _signAuthorizationWith(authorization, walletOwnerKey)
        );

        assertEq(token.balanceOf(wallet), BUYER_FUNDING - AMOUNT);
        assertEq(token.balanceOf(seller), AMOUNT);
    }

    function test_RevertsWhenTokenRejectsTheBuyerSignature() public {
        (, uint256 impostorKey) = makeAddrAndKey("impostor");

        INotaReceiptStore.SignedReceiptQuote memory quote = _defaultQuote("bad-buyer-signature");
        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(quote);

        vm.expectRevert(MockEIP3009Token.InvalidAuthorizationSignature.selector);
        vm.prank(submitter);
        adapter.settleWithAuthorization(
            quote,
            _sellerSignature(),
            address(0),
            authorization,
            _signAuthorizationWith(authorization, impostorKey)
        );
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _settle(INotaReceiptStore.SignedReceiptQuote memory quote)
        internal
        returns (uint256 receiptId)
    {
        NotaX402Settlement.ReceiveAuthorization memory authorization = _authorization(quote);

        receiptId = adapter.settleWithAuthorization(
            quote, _sellerSignature(), address(0), authorization, _signAuthorization(authorization)
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
            purchaseRef: keccak256(abi.encodePacked("purchase-ref:", label)),
            amount: AMOUNT,
            metadataHash: keccak256(abi.encodePacked("metadata:", label)),
            agentId: keccak256("agent"),
            integratorFeeRecipient: address(0),
            integratorFeeAmount: 0,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 1 hours)
        });
    }

    function _authorization(INotaReceiptStore.SignedReceiptQuote memory quote)
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
            nonce: keccak256(abi.encodePacked("authorization-nonce:", quote.purchaseRef))
        });
    }

    /// @dev The mock store does not verify signatures, only that one was supplied. Real seller
    ///      signature verification is covered against the deployed store in the fork suite.
    function _sellerSignature() internal pure returns (bytes memory) {
        return hex"01";
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
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", tokenDomainSeparator, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
