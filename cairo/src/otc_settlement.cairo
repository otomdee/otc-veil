use starknet::ContractAddress;

// Must match privacy::objects::OpenNoteDeposit (positional Serde).
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

/// Minimal ERC-20 surface used by the settlement logic.
#[starknet::interface]
pub trait IErc20<TState> {
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
}

fn approve(token: ContractAddress, spender: ContractAddress, amount: u128) {
    IErc20Dispatcher { contract_address: token }.approve(spender, amount.into());
}

fn transfer(token: ContractAddress, recipient: ContractAddress, amount: u128) {
    IErc20Dispatcher { contract_address: token }.transfer(recipient, amount.into());
}

/// A resting order. Sell tokens are held by this contract from Fill until the
/// seller Claims proceeds (filled) or reclaims (expired, unfilled).
#[derive(Serde, Copy, Drop, PartialEq, Debug, starknet::Store)]
pub struct Order {
    pub sell_token: ContractAddress,
    pub sell_amount: u128,
    pub buy_token: ContractAddress,
    pub buy_amount: u128,
    /// Block timestamp after which an unfilled order can be reclaimed by the seller.
    pub expiry: u64,
    /// True once a buyer settled this order (also true after a reclaim - terminal).
    pub filled: bool,
}

/// Operations dispatched inside `privacy_invoke`.
///
/// - `FILL`   - seller leg. The pool withdrew `sell_amount` of `sell_token` to this
///   contract; the order is stored against the commitment hash and rests until
///   settled or expired. Returns an empty span.
/// - `SETTLE` - buyer leg. The pool withdrew `buy_amount` of `buy_token`; the order
///   must exist, be unfilled and unexpired with matching buy terms. Takes the fee,
///   marks the order filled, credits the buyer's open note with the sold tokens.
///   Returns one OpenNoteDeposit for the buyer.
/// - `CLAIM`  - seller exit. No pool withdrawal involved. Recomputes
///   `order_id = poseidon(ORDER_COMMITMENT_TAG, secret)`; if filled, credits the
///   seller's open note with net proceeds; if expired and unfilled, credits the
///   sell-token refund instead.
///
/// Fee collection is NOT part of `privacy_invoke`: the pool is always
/// `msg.sender` there, so the treasury cannot be authenticated. See
/// `ITreasuryFees::collect_fees`.
#[starknet::interface]
pub trait IOtcSettlement<T> {
    fn privacy_invoke(
        ref self: T,
        operation: felt252,
        order_id: felt252,
        sell_token: ContractAddress,
        sell_amount: u128,
        buy_token: ContractAddress,
        buy_amount: u128,
        expiry: u64,
        note_id_buyer: felt252,
        note_id_seller: felt252,
        secret: felt252,
    ) -> Span<OpenNoteDeposit>;

    fn get_order(self: @T, order_id: felt252) -> Order;
    fn get_proceeds(self: @T, order_id: felt252) -> u128;
    fn get_accrued_fees(self: @T, token: ContractAddress) -> u128;
    fn get_treasury(self: @T) -> ContractAddress;
    fn get_privacy_contract(self: @T) -> ContractAddress;
    fn compute_order_id(self: @T, secret: felt252) -> felt252;

    /// Treasury-only. Pulls all accrued fees of `token` out of the contract via a
    /// plain ERC-20 transfer (fee flows are public by design).
    fn collect_fees(ref self: T, token: ContractAddress) -> bool;
}

pub const OP_FILL: felt252 = 'FILL';
pub const OP_SETTLE: felt252 = 'SETTLE';
pub const OP_CLAIM: felt252 = 'CLAIM';

/// Fee in basis points taken from the buy leg on settlement (10 bps = 0.1%).
pub const FEE_BPS: u128 = 10;
pub const BPS_DENOM: u128 = 10_000;

/// Domain-separation tag for order commitment hashes.
pub const ORDER_COMMITMENT_TAG: felt252 = 'OTC_ORDER_V1';

pub mod errors {
    pub const CALLER_NOT_PRIVACY: felt252 = 'CALLER_NOT_PRIVACY';
    pub const ZERO_SECRET: felt252 = 'ZERO_SECRET';
    pub const ZERO_TOKEN: felt252 = 'ZERO_TOKEN';
    pub const ZERO_AMOUNT: felt252 = 'ZERO_AMOUNT';
    pub const EXPIRY_IN_PAST: felt252 = 'EXPIRY_IN_PAST';
    pub const UNKNOWN_OP: felt252 = 'UNKNOWN_OP';
    pub const ORDER_EXISTS: felt252 = 'ORDER_EXISTS';
    pub const ORDER_NOT_FOUND: felt252 = 'ORDER_NOT_FOUND';
    pub const ALREADY_FILLED: felt252 = 'ALREADY_FILLED';
    pub const ORDER_EXPIRED: felt252 = 'ORDER_EXPIRED';
    pub const NOT_EXPIRED: felt252 = 'NOT_EXPIRED';
    pub const TERMS_MISMATCH: felt252 = 'TERMS_MISMATCH';
    pub const NOTHING_TO_CLAIM: felt252 = 'NOTHING_TO_CLAIM';
    pub const ZERO_NOTE_ID: felt252 = 'ZERO_NOTE_ID';
    pub const NOT_TREASURY: felt252 = 'NOT_TREASURY';
    pub const NO_FEES_ACCRUED: felt252 = 'NO_FEES_ACCRUED';
}

/// Computes the order commitment hash from the seller's secret using
/// domain-separated Poseidon. Mirrored off-chain by starknet.js `poseidonHash`.
pub fn compute_order_id(secret: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span([ORDER_COMMITMENT_TAG, secret].span())
}

#[starknet::contract]
pub mod OtcSettlement {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address};
    use super::{
        BPS_DENOM, FEE_BPS, IOtcSettlement, OpenNoteDeposit, Order, OP_CLAIM, OP_FILL, OP_SETTLE,
        approve, compute_order_id, errors, transfer,
    };

    #[storage]
    struct Storage {
        privacy_contract: ContractAddress,
        treasury: ContractAddress,
        orders: Map<felt252, Order>,
        /// Net proceeds owed to the seller of a filled order.
        proceeds: Map<felt252, u128>,
        /// Fees accrued per token, claimable by the treasury.
        accrued_fees: Map<ContractAddress, u128>,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        privacy_contract: ContractAddress,
        treasury: ContractAddress,
    ) {
        assert(privacy_contract.is_non_zero(), errors::ZERO_TOKEN);
        self.privacy_contract.write(privacy_contract);
        self.treasury.write(treasury);
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        OrderCreated: OrderCreated,
        Settled: Settled,
        Claimed: Claimed,
        FeesCollected: FeesCollected,
    }

    #[derive(Drop, starknet::Event)]
    struct OrderCreated {
        #[key]
        order_id: felt252,
        sell_token: ContractAddress,
        sell_amount: u128,
        buy_token: ContractAddress,
        buy_amount: u128,
        expiry: u64,
    }

    #[derive(Drop, starknet::Event)]
    struct Settled {
        #[key]
        order_id: felt252,
        /// Amount credited to the buyer's open note.
        buyer_credit: u128,
        /// Net proceeds owed to the seller after fee.
        seller_proceeds: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct Claimed {
        #[key]
        order_id: felt252,
        token: ContractAddress,
        amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct FeesCollected {
        token: ContractAddress,
        amount: u128,
    }

    #[abi(embed_v0)]
    pub impl OtcSettlementImpl of super::IOtcSettlement<ContractState> {
        fn privacy_invoke(
            ref self: ContractState,
            operation: felt252,
            order_id: felt252,
            sell_token: ContractAddress,
            sell_amount: u128,
            buy_token: ContractAddress,
            buy_amount: u128,
            expiry: u64,
            note_id_buyer: felt252,
            note_id_seller: felt252,
            secret: felt252,
        ) -> Span<OpenNoteDeposit> {
            assert(get_caller_address() == self.privacy_contract.read(), errors::CALLER_NOT_PRIVACY);

            if operation == OP_FILL {
                return HelpersTrait::fill(
                    ref self, order_id, sell_token, sell_amount, buy_token, buy_amount, expiry,
                );
            } else if operation == OP_SETTLE {
                return HelpersTrait::settle(ref self, order_id, buy_token, buy_amount, note_id_buyer);
            } else if operation == OP_CLAIM {
                return HelpersTrait::claim(ref self, note_id_seller, secret);
            }
            assert(false, errors::UNKNOWN_OP);
            [].span()
        }

        fn get_order(self: @ContractState, order_id: felt252) -> Order {
            self.orders.read(order_id)
        }

        fn get_proceeds(self: @ContractState, order_id: felt252) -> u128 {
            self.proceeds.read(order_id)
        }

        fn get_accrued_fees(self: @ContractState, token: ContractAddress) -> u128 {
            self.accrued_fees.read(token)
        }

        fn get_treasury(self: @ContractState) -> ContractAddress {
            self.treasury.read()
        }

        fn get_privacy_contract(self: @ContractState) -> ContractAddress {
            self.privacy_contract.read()
        }

        fn compute_order_id(self: @ContractState, secret: felt252) -> felt252 {
            compute_order_id(secret)
        }
        fn collect_fees(ref self: ContractState, token: ContractAddress) -> bool {
            assert(get_caller_address() == self.treasury.read(), errors::NOT_TREASURY);

            let amount = self.accrued_fees.read(token);
            assert(amount.is_non_zero(), errors::NO_FEES_ACCRUED);

            self.accrued_fees.write(token, Zero::zero());
            transfer(token, self.treasury.read(), amount);
            self.emit(Event::FeesCollected(FeesCollected { token, amount }));
            true
        }
    }

    #[generate_trait]
    pub impl Helpers of HelpersTrait {
        /// Seller leg. Tokens were already withdrawn by the pool into this contract.
        fn fill(
            ref self: ContractState,
            order_id: felt252,
            sell_token: ContractAddress,
            sell_amount: u128,
            buy_token: ContractAddress,
            buy_amount: u128,
            expiry: u64,
        ) -> Span<OpenNoteDeposit> {
            assert(order_id.is_non_zero(), errors::ZERO_SECRET);
            assert(sell_token.is_non_zero() && buy_token.is_non_zero(), errors::ZERO_TOKEN);
            assert(sell_amount.is_non_zero() && buy_amount.is_non_zero(), errors::ZERO_AMOUNT);
            assert(expiry > get_block_timestamp(), errors::EXPIRY_IN_PAST);

            let existing = self.orders.read(order_id);
            assert(existing.sell_token.is_zero(), errors::ORDER_EXISTS);

            let order = Order { sell_token, sell_amount, buy_token, buy_amount, expiry, filled: false };
            self.orders.write(order_id, order);
            self.emit(
                Event::OrderCreated(
                    OrderCreated { order_id, sell_token, sell_amount, buy_token, buy_amount, expiry },
                )
            );
            // Tokens stay in escrow here; nothing to credit back yet.
            [].span()
        }

        /// Buyer leg. Buy tokens were already withdrawn by the pool into this
        /// contract. Atomic: if any check fails, the whole private tx reverts and
        /// funds return to the pool.
        fn settle(
            ref self: ContractState,
            order_id: felt252,
            buy_token: ContractAddress,
            buy_amount: u128,
            note_id_buyer: felt252,
        ) -> Span<OpenNoteDeposit> {
            assert(note_id_buyer.is_non_zero(), errors::ZERO_NOTE_ID);

            let order = self.orders.read(order_id);
            assert(order.sell_token.is_non_zero(), errors::ORDER_NOT_FOUND);
            assert(!order.filled, errors::ALREADY_FILLED);
            assert(get_block_timestamp() <= order.expiry, errors::ORDER_EXPIRED);
            assert(buy_token == order.buy_token && buy_amount == order.buy_amount, errors::TERMS_MISMATCH);

            let fee = (order.buy_amount * FEE_BPS) / BPS_DENOM;
            let proceeds = order.buy_amount - fee;

            self.orders.write(order_id, Order { filled: true, ..order });
            self.proceeds.write(order_id, proceeds);
            if fee.is_non_zero() {
                self.accrued_fees.write(buy_token, self.accrued_fees.read(buy_token) + fee);
            }

            // Approve the pool to pull the escrowed sell tokens into the buyer's note.
            approve(order.sell_token, self.privacy_contract.read(), order.sell_amount);
            self.emit(
                Event::Settled(Settled { order_id, buyer_credit: order.sell_amount, seller_proceeds: proceeds })
            );
            [
                OpenNoteDeposit { note_id: note_id_buyer, token: order.sell_token, amount: order.sell_amount },
            ]
                .span()
        }

        /// Seller exit, gated by the secret preimage. Filled orders pay out net
        /// proceeds in the buy token; expired unfilled orders refund the sell tokens.
        fn claim(ref self: ContractState, note_id_seller: felt252, secret: felt252) -> Span<OpenNoteDeposit> {
            assert(note_id_seller.is_non_zero(), errors::ZERO_NOTE_ID);
            assert(secret.is_non_zero(), errors::ZERO_SECRET);

            let order_id = compute_order_id(secret);
            let order = self.orders.read(order_id);
            assert(order.sell_token.is_non_zero(), errors::ORDER_NOT_FOUND);

            if order.filled {
                let proceeds = self.proceeds.read(order_id);
                assert(proceeds.is_non_zero(), errors::NOTHING_TO_CLAIM);
                self.proceeds.write(order_id, Zero::zero());
                approve(order.buy_token, self.privacy_contract.read(), proceeds);
                self.emit(Event::Claimed(Claimed { order_id, token: order.buy_token, amount: proceeds }));
                [
                    OpenNoteDeposit { note_id: note_id_seller, token: order.buy_token, amount: proceeds },
                ]
                    .span()
            } else {
                // Reclaim path: expired, unfilled orders go back to the seller.
                assert(get_block_timestamp() > order.expiry, errors::NOT_EXPIRED);
                self.orders.write(order_id, Order { filled: true, ..order });
                approve(order.sell_token, self.privacy_contract.read(), order.sell_amount);
                self.emit(
                    Event::Claimed(
                        Claimed { order_id, token: order.sell_token, amount: order.sell_amount },
                    )
                );
                [
                    OpenNoteDeposit {
                        note_id: note_id_seller,
                        token: order.sell_token,
                        amount: order.sell_amount,
                    },
                ]
                    .span()
            }
        }
    }
}
