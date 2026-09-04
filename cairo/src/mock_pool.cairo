use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockPool<TState> {
    fn forward_fill(
        ref self: TState,
        helper: ContractAddress,
        order_id: felt252,
        sell_token: ContractAddress,
        sell_amount: u128,
        buy_token: ContractAddress,
        buy_amount: u128,
        expiry: u64,
    );
    fn forward_settle(
        ref self: TState,
        helper: ContractAddress,
        order_id: felt252,
        buy_token: ContractAddress,
        buy_amount: u128,
        buyer_note: felt252,
    );
    fn forward_claim(
        ref self: TState, helper: ContractAddress, note_id: felt252, secret: felt252,
    );
}

#[starknet::contract]
pub mod MockPool {
    use starknet::ContractAddress;
    use otc_veil::otc_settlement::{
        IOtcSettlementDispatcher, IOtcSettlementDispatcherTrait, OP_CLAIM, OP_FILL, OP_SETTLE,
    };

    #[storage]
    struct Storage {}

    #[constructor]
    fn constructor(ref self: ContractState) {}

    #[abi(embed_v0)]
    pub impl MockPoolImpl of super::IMockPool<ContractState> {
        fn forward_fill(
            ref self: ContractState,
            helper: ContractAddress,
            order_id: felt252,
            sell_token: ContractAddress,
            sell_amount: u128,
            buy_token: ContractAddress,
            buy_amount: u128,
            expiry: u64,
        ) {
            let mut d = IOtcSettlementDispatcher { contract_address: helper };
            let _ = d.privacy_invoke(OP_FILL, order_id, sell_token, sell_amount, buy_token, buy_amount, expiry, 0, 0, 0);
        }

        fn forward_settle(
            ref self: ContractState,
            helper: ContractAddress,
            order_id: felt252,
            buy_token: ContractAddress,
            buy_amount: u128,
            buyer_note: felt252,
        ) {
            let mut d = IOtcSettlementDispatcher { contract_address: helper };
            // privacy_invoke layout: (op, order_id, sell_token, sell_amount, buy_token, buy_amount, expiry, note_buyer, note_seller, secret)
            // for SETTLE, sell_token/sell_amount/expiry/secret are ignored
            let _ = d.privacy_invoke(OP_SETTLE, order_id, buy_token, 0, buy_token, buy_amount, 0, buyer_note, 0, 0);
        }

        fn forward_claim(
            ref self: ContractState, helper: ContractAddress, note_id: felt252, secret: felt252,
        ) {
            let mut d = IOtcSettlementDispatcher { contract_address: helper };
            let _ = d.privacy_invoke(OP_CLAIM, 0, 0.try_into().unwrap(), 0, 0.try_into().unwrap(), 0, 0, 0, note_id, secret);
        }
    }
}
