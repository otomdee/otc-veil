use core::num::traits::Zero;
use otc_veil::otc_settlement::{
    BPS_DENOM, FEE_BPS, IOtcSettlementDispatcher, IOtcSettlementDispatcherTrait,
    IOtcSettlementSafeDispatcher, IOtcSettlementSafeDispatcherTrait, OtcSettlement,
    OpenNoteDeposit, OP_CLAIM, OP_FILL, OP_SETTLE,
};
use snforge_std::{
    ContractClassTrait, DeclareResult, DeclareResultTrait, declare, start_cheat_block_timestamp,
    start_cheat_caller_address, stop_cheat_block_timestamp, stop_cheat_caller_address,
};
use starknet::{ContractAddress, contract_address_const};

// ─── Mock ERC-20 (no allowance checks - the settlement contract only approves/transfers) ───

#[starknet::interface]
pub trait IMockErc20<TState> {
    fn mint(ref self: TState, to: ContractAddress, amount: u256);
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn allowance(self: @TState, owner: ContractAddress, spender: ContractAddress) -> u256;
}

fn mint_to(token: ContractAddress, to: ContractAddress, amount: u128) {
    IMockErc20Dispatcher { contract_address: token }.mint(to, amount.into());
}

#[starknet::contract]
pub mod MockErc20 {
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address};

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, _salt: felt252) {}

    #[abi(embed_v0)]
    pub impl MockErc20Impl of super::IMockErc20<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            self.balances.write(to, self.balances.read(to) + amount);
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            let key = (get_caller_address(), spender);
            self.allowances.write(key, amount);
            true
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let sender = get_caller_address();
            let from_balance = self.balances.read(sender);
            assert(from_balance >= amount, 'insufficient balance');
            self.balances.write(sender, from_balance - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }

        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.read(account)
        }

        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress
        ) -> u256 {
            self.allowances.read((owner, spender))
        }
    }
}

// ─── Test constants ───

fn pool() -> ContractAddress {
    contract_address_const::<0xbeef>()
}
fn treasury() -> ContractAddress {
    contract_address_const::<0xcafe>()
}
const BUYER_NOTE: felt252 = 0x1234;
const SELLER_NOTE: felt252 = 0x5678;
const SECRET: felt252 = 0x9999;

const SELL_AMOUNT: u128 = 1_000_000;
const BUY_AMOUNT: u128 = 500_000;
const EXPIRY_TS: u64 = 1000;

fn deploy(name: ByteArray, salt: felt252) -> ContractAddress {
    let declare_result: DeclareResult = declare(name).unwrap();
    let contract = declare_result.contract_class();
    let (address, _) = contract.deploy(@array![salt]).unwrap();
    address
}

/// Deploys two mock tokens and the settlement contract wired to POOL/TREASURY.
fn setup() -> (ContractAddress, ContractAddress, ContractAddress) {
    let token_a = deploy("MockErc20", 'TOKEN_A');
    let token_b = deploy("MockErc20", 'TOKEN_B');

    let declare_result: DeclareResult = declare("OtcSettlement").unwrap();
    let contract = declare_result.contract_class();
    let (otc, _) =
        contract.deploy(@array![pool().into(), treasury().into()]).unwrap();

    (token_a, token_b, otc)
}

fn order_id_of(secret: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span(['OTC_ORDER_V1', secret].span())
}

fn fill(otc: ContractAddress, order_id: felt252, token_a: ContractAddress, token_b: ContractAddress) {
    let mut dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    dispatcher.privacy_invoke(
        OP_FILL, order_id, token_a, SELL_AMOUNT, token_b, BUY_AMOUNT, EXPIRY_TS, BUYER_NOTE,
        SELLER_NOTE, SECRET,
    );
}

fn settle(otc: ContractAddress, order_id: felt252, token_a: ContractAddress, token_b: ContractAddress) -> Span<OpenNoteDeposit> {
    let mut dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    dispatcher.privacy_invoke(
        OP_SETTLE, order_id, token_a, 0, token_b, BUY_AMOUNT, 0, BUYER_NOTE, SELLER_NOTE, 0,
    )
}

// ─── Tests ───

#[test]
fn test_compute_order_id_matches_poseidon() {
    let (_, _, otc) = setup();
    let dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    assert(dispatcher.compute_order_id(SECRET) == order_id_of(SECRET), 'id mismatch');
}

#[test]
fn test_fill_stores_order() {
    let (token_a, token_b, otc) = setup();

    start_cheat_caller_address(otc, pool());
    fill(otc, order_id_of(SECRET), token_a, token_b);
    stop_cheat_caller_address(otc);

    let dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    let order = dispatcher.get_order(order_id_of(SECRET));
    assert(order.sell_token == token_a, 'sell token');
    assert(order.sell_amount == SELL_AMOUNT, 'sell amount');
    assert(order.buy_token == token_b, 'buy token');
    assert(order.buy_amount == BUY_AMOUNT, 'buy amount');
    assert(order.expiry == EXPIRY_TS, 'expiry');
    assert(!order.filled, 'not filled');
}

#[test]
#[should_panic(expected: ('CALLER_NOT_PRIVACY',))]
fn test_fill_rejects_non_pool_caller() {
    let (token_a, token_b, otc) = setup();
    fill(otc, order_id_of(SECRET), token_a, token_b);
}

#[test]
#[should_panic(expected: ('ORDER_EXISTS',))]
fn test_fill_rejects_duplicate_order() {
    let (token_a, token_b, otc) = setup();
    start_cheat_caller_address(otc, pool());
    fill(otc, order_id_of(SECRET), token_a, token_b);
    fill(otc, order_id_of(SECRET), token_a, token_b);
}

#[test]
fn test_settle_credits_buyer_and_accrues_fee() {
    let (token_a, token_b, otc) = setup();
    let oid = order_id_of(SECRET);

    start_cheat_caller_address(otc, pool());
    // Mirror the pool's withdraw legs: tokens land in the settlement contract
    // before privacy_invoke runs.
    mint_to(token_a, otc, SELL_AMOUNT);
    mint_to(token_b, otc, BUY_AMOUNT);
    fill(otc, oid, token_a, token_b);

    let mut dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    let result = settle(otc, oid, token_a, token_b);
    stop_cheat_caller_address(otc);

    // Buyer credited the full sell amount of token A.
    assert(result.len() == 1, 'one deposit');
    let dep = *result.at(0);
    assert(dep.note_id == BUYER_NOTE, 'buyer note');
    assert(dep.token == token_a, 'credit token');
    assert(dep.amount == SELL_AMOUNT, 'credit amount');

    // Fee accrued to treasury: 10 bps of buy amount.
    let expected_fee = (BUY_AMOUNT * FEE_BPS) / BPS_DENOM;
    let dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    assert(dispatcher.get_accrued_fees(token_b) == expected_fee, 'fee');

    let proceeds = BUY_AMOUNT - expected_fee;
    assert(dispatcher.get_proceeds(oid) == proceeds, 'proceeds');

    let order = dispatcher.get_order(oid);
    assert(order.filled, 'filled flag');

    // Pool was approved to pull exactly the escrowed sell tokens.
    let token_a_d = IMockErc20Dispatcher { contract_address: token_a };
    assert(token_a_d.allowance(otc, pool()) == SELL_AMOUNT.into(), 'settle approval');
}

#[test]
#[should_panic(expected: ('TERMS_MISMATCH',))]
fn test_settle_rejects_wrong_buy_terms() {
    let (token_a, token_b, otc) = setup();
    let oid = order_id_of(SECRET);

    start_cheat_caller_address(otc, pool());
    fill(otc, oid, token_a, token_b);
    let mut dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    dispatcher.privacy_invoke(
        OP_SETTLE, oid, token_a, 0, token_b, BUY_AMOUNT - 1, 0, BUYER_NOTE, SELLER_NOTE, 0,
    );
}

#[test]
#[should_panic(expected: ('ALREADY_FILLED',))]
fn test_settle_rejects_double_fill() {
    let (token_a, token_b, otc) = setup();
    let oid = order_id_of(SECRET);

    start_cheat_caller_address(otc, pool());
    fill(otc, oid, token_a, token_b);
    settle(otc, oid, token_a, token_b);
    settle(otc, oid, token_a, token_b);
}

#[test]
fn test_claim_pays_seller_proceeds_after_settle() {
    let (token_a, token_b, otc) = setup();
    let oid = order_id_of(SECRET);

    start_cheat_caller_address(otc, pool());
    fill(otc, oid, token_a, token_b);
    settle(otc, oid, token_a, token_b);

    // Seller claims proceeds by revealing the secret.
    let mut dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    let result: Span<OpenNoteDeposit> = dispatcher.privacy_invoke(
        OP_CLAIM, 0, token_a, 0, token_b, 0, 0, BUYER_NOTE, SELLER_NOTE, SECRET,
    );
    stop_cheat_caller_address(otc);

    let expected_proceeds = BUY_AMOUNT - ((BUY_AMOUNT * FEE_BPS) / BPS_DENOM);
    assert(result.len() == 1, 'one deposit');
    let dep = *result.at(0);
    assert(dep.note_id == SELLER_NOTE, 'seller note');
    assert(dep.token == token_b, 'proceeds token');
    assert(dep.amount == expected_proceeds, 'proceeds amount');

    // Proceeds are consumed.
    assert(dispatcher.get_proceeds(oid) == 0, 'zeroed');

    // Pool was approved to pull exactly the proceeds for the seller's note.
    let token_b_d = IMockErc20Dispatcher { contract_address: token_b };
    let expected_proceeds2 = BUY_AMOUNT - ((BUY_AMOUNT * FEE_BPS) / BPS_DENOM);
    assert(token_b_d.allowance(otc, pool()) == expected_proceeds2.into(), 'claim approval');
}

#[test]
#[should_panic(expected: ('NOTHING_TO_CLAIM',))]
fn test_claim_twice_reverts() {
    let (token_a, token_b, otc) = setup();
    let oid = order_id_of(SECRET);

    start_cheat_caller_address(otc, pool());
    fill(otc, oid, token_a, token_b);
    settle(otc, oid, token_a, token_b);
    let mut dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    dispatcher.privacy_invoke(
        OP_CLAIM, 0, token_a, 0, token_b, 0, 0, BUYER_NOTE, SELLER_NOTE, SECRET,
    );
    dispatcher.privacy_invoke(
        OP_CLAIM, 0, token_a, 0, token_b, 0, 0, BUYER_NOTE, SELLER_NOTE, SECRET,
    );
}

#[test]
#[should_panic(expected: ('ORDER_NOT_FOUND',))]
fn test_claim_wrong_secret_reverts() {
    let (token_a, token_b, otc) = setup();
    let oid = order_id_of(SECRET);

    start_cheat_caller_address(otc, pool());
    fill(otc, oid, token_a, token_b);
    let mut dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    dispatcher.privacy_invoke(
        OP_CLAIM, 0, token_a, 0, token_b, 0, 0, BUYER_NOTE, SELLER_NOTE, SECRET + 1,
    );
}

#[test]
fn test_reclaim_refunds_seller_after_expiry() {
    let (token_a, token_b, otc) = setup();
    let oid = order_id_of(SECRET);

    start_cheat_caller_address(otc, pool());
    fill(otc, oid, token_a, token_b);

    // Advance time past expiry for the settlement contract.
    start_cheat_block_timestamp(otc, EXPIRY_TS + 1);

    let mut dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    let result: Span<OpenNoteDeposit> = dispatcher.privacy_invoke(
        OP_CLAIM, 0, token_a, 0, token_b, 0, 0, BUYER_NOTE, SELLER_NOTE, SECRET,
    );
    stop_cheat_block_timestamp(otc);
    stop_cheat_caller_address(otc);

    assert(result.len() == 1, 'one deposit');
    let dep = *result.at(0);
    assert(dep.note_id == SELLER_NOTE, 'seller note');
    assert(dep.token == token_a, 'refund token');
    assert(dep.amount == SELL_AMOUNT, 'refund amount');

    // Order terminal; buyer can no longer settle it.
    let order = dispatcher.get_order(oid);
    assert(order.filled, 'terminal');
}

#[test]
#[should_panic(expected: ('NOT_EXPIRED',))]
fn test_reclaim_before_expiry_reverts() {
    let (token_a, token_b, otc) = setup();
    let oid = order_id_of(SECRET);

    start_cheat_caller_address(otc, pool());
    fill(otc, oid, token_a, token_b);
    let mut dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    dispatcher.privacy_invoke(
        OP_CLAIM, 0, token_a, 0, token_b, 0, 0, BUYER_NOTE, SELLER_NOTE, SECRET,
    );
}

#[test]
fn test_collect_fees_pays_treasury_only_once() {
    let (token_a, token_b, otc) = setup();
    let oid = order_id_of(SECRET);

    start_cheat_caller_address(otc, pool());
    // Mirror the pool's withdraw legs: tokens land in the contract first.
    mint_to(token_a, otc, SELL_AMOUNT);
    mint_to(token_b, otc, BUY_AMOUNT);
    fill(otc, oid, token_a, token_b);
    settle(otc, oid, token_a, token_b);
    stop_cheat_caller_address(otc);

    let expected_fee = (BUY_AMOUNT * FEE_BPS) / BPS_DENOM;
    let dispatcher = IOtcSettlementDispatcher { contract_address: otc };
    assert(dispatcher.get_accrued_fees(token_b) == expected_fee, 'fee accrued');

    // Non-treasury collect reverts via SafeDispatcher Result.
    let mut safe = IOtcSettlementSafeDispatcher { contract_address: otc };
    match safe.collect_fees(token_b) {
        Result::Ok(_) => panic_if_true(true),
        Result::Err(_) => {},
    }

    // Treasury collects.
    start_cheat_caller_address(otc, treasury());
    let ok = dispatcher.collect_fees(token_b);
    stop_cheat_caller_address(otc);
    assert(ok, 'collected');
    assert(dispatcher.get_accrued_fees(token_b) == Zero::zero(), 'fees zeroed');
}

fn panic_if_true(v: bool) {
    assert(!v, 'should have reverted');
}
