use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockERC20<TState> {
    fn mint(ref self: TState, to: ContractAddress, amount: u256);
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn allowance(self: @TState, owner: ContractAddress, spender: ContractAddress) -> u256;
}

#[starknet::contract]
pub mod MockERC20 {
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
    pub impl MockERC20Impl of super::IMockERC20<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            self.balances.write(to, self.balances.read(to) + amount);
        }
        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            self.allowances.write((get_caller_address(), spender), amount);
            true
        }
        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let sender = get_caller_address();
            let bal = self.balances.read(sender);
            assert(bal >= amount, 'insufficient balance');
            self.balances.write(sender, bal - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.read(account)
        }
        fn allowance(self: @ContractState, owner: ContractAddress, spender: ContractAddress) -> u256 {
            self.allowances.read((owner, spender))
        }
    }
}
