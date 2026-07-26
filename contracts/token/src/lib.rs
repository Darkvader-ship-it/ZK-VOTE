#![no_std]

mod allowance;

use allowance::{read_allowance, read_allowance_amount, write_allowance};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, String,
};

const ADMIN_KEY: soroban_sdk::Symbol = symbol_short!("admin");
const NAME_KEY: soroban_sdk::Symbol = symbol_short!("name");
const SYMBOL_KEY: soroban_sdk::Symbol = symbol_short!("symbol");
const DECIMALS_KEY: soroban_sdk::Symbol = symbol_short!("decim");
const VERSION: u32 = 1;
const VERSION_KEY: soroban_sdk::Symbol = symbol_short!("ver");

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum TokenError {
    AlreadyInitialized = 1,
    InsufficientBalance = 2,
    InsufficientAllowance = 3,
    Unauthorized = 4,
    InvalidAmount = 5,
    Overflow = 6,
    AllowanceRaceRejected = 7,
    NotAdmin = 8,
    NegativeAllowance = 9,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Balance(Address),
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ApproveEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct TransferEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct MintEvent {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct BurnEvent {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

#[contract]
pub struct Token;

#[contractimpl]
impl Token {
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    fn bump_persistent<K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &K) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    pub fn __constructor(env: Env, admin: Address, name: String, symbol: String, decimals: u32) {
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, TokenError::AlreadyInitialized);
        }
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        ContractUpgraded {
            from: 0,
            to: VERSION,
        }
        .publish(&env);

        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&NAME_KEY, &name);
        env.storage().instance().set(&SYMBOL_KEY, &symbol);
        env.storage().instance().set(&DECIMALS_KEY, &decimals);
    }

    pub fn name(env: Env) -> String {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&NAME_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::AlreadyInitialized))
    }

    pub fn symbol(env: Env) -> String {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&SYMBOL_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::AlreadyInitialized))
    }

    pub fn decimals(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&DECIMALS_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::AlreadyInitialized))
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        Self::bump_instance(&env);
        let key = DataKey::Balance(id.clone());
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if bal > 0 {
            Self::bump_persistent(&env, &key);
        }
        bal
    }

    pub fn admin(env: Env) -> Address {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&ADMIN_KEY)
            .unwrap_or_else(|| panic_with_error!(&env, TokenError::AlreadyInitialized))
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let current_admin: Address = Self::admin(env.clone());
        current_admin.require_auth();
        Self::bump_instance(&env);
        env.storage().instance().set(&ADMIN_KEY, &new_admin);
    }

    // ── Balance helpers ─────────────────────────────────────────────────────

    fn receive_balance(env: &Env, to: &Address, amount: i128) {
        if amount == 0 {
            return;
        }
        let key = DataKey::Balance(to.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new = current.checked_add(amount).unwrap_or_else(|| {
            panic_with_error!(env, TokenError::Overflow);
        });
        env.storage().persistent().set(&key, &new);
        Self::bump_persistent(env, &key);
    }

    fn spend_balance(env: &Env, from: &Address, amount: i128) {
        if amount == 0 {
            return;
        }
        let key = DataKey::Balance(from.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if current < amount {
            panic_with_error!(env, TokenError::InsufficientBalance);
        }
        let new = current - amount;
        if new == 0 {
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &new);
            Self::bump_persistent(env, &key);
        }
    }

    fn xfer(env: &Env, from: &Address, to: &Address, amount: i128) {
        Self::spend_balance(env, from, amount);
        Self::receive_balance(env, to, amount);
    }

    fn spend_allowance(env: &Env, from: &Address, spender: &Address, amount: i128) {
        let (current_allowance, expiration_ledger) =
            read_allowance(env, from.clone(), spender.clone());
        if current_allowance < amount {
            panic_with_error!(env, TokenError::InsufficientAllowance);
        }
        let new_allowance = current_allowance - amount;
        write_allowance(
            env,
            from.clone(),
            spender.clone(),
            new_allowance,
            expiration_ledger,
        );
    }

    // ── Token Interface: Allowance ──────────────────────────────────────────

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        Self::bump_instance(&env);
        read_allowance_amount(&env, from, spender)
    }

    /// Approve spender to transfer `amount` from `from`'s balance.
    ///
    /// ## Race-condition mitigation
    ///
    /// This function REJECTS any call that would change a non-zero allowance to
    /// a *different* non-zero value.  Only the following transitions are
    /// allowed:
    ///
    /// | Current allowance | Requested amount | Result               |
    /// |-------------------|------------------|----------------------|
    /// | 0                 | any              | allowed (set)        |
    /// | non-zero          | 0                | allowed (clear)      |
    /// | non-zero          | same non-zero    | allowed (no‑op)      |
    /// | non-zero          | different non‑zero| **REJECTED**        |
    ///
    /// To safely change an existing non-zero allowance, callers MUST use
    /// [`increase_allowance`] or [`decrease_allowance`] instead.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        Self::bump_instance(&env);

        let current = read_allowance_amount(&env, from.clone(), spender.clone());

        let is_race_rejected = current != 0 && amount != 0 && current != amount;

        if is_race_rejected {
            panic_with_error!(&env, TokenError::AllowanceRaceRejected);
        }

        write_allowance(
            &env,
            from.clone(),
            spender.clone(),
            amount,
            expiration_ledger,
        );

        ApproveEvent {
            from,
            spender,
            amount,
            expiration_ledger,
        }
        .publish(&env);
    }

    /// Increase the allowance for `spender` by `add_amount`.
    ///
    /// Reads the current allowance, adds `add_amount` (with overflow check),
    /// and writes the new total with the given `expiration_ledger`.
    ///
    /// This is the safe alternative to `approve` for adjusting an existing
    /// non-zero allowance — it cannot be front-run the way a direct
    /// `approve(from, spender, new_amount, …)` call can.
    pub fn increase_allowance(
        env: Env,
        from: Address,
        spender: Address,
        add_amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        Self::bump_instance(&env);

        if add_amount < 0 {
            panic_with_error!(&env, TokenError::NegativeAllowance);
        }

        let (current, _) = read_allowance(&env, from.clone(), spender.clone());
        let new = current.checked_add(add_amount).unwrap_or_else(|| {
            panic_with_error!(&env, TokenError::Overflow);
        });

        write_allowance(&env, from.clone(), spender.clone(), new, expiration_ledger);

        ApproveEvent {
            from,
            spender,
            amount: new,
            expiration_ledger,
        }
        .publish(&env);
    }

    /// Decrease the allowance for `spender` by `sub_amount`.
    ///
    /// Reads the current allowance and subtracts `sub_amount`.  If
    /// `sub_amount` is greater than or equal to the current allowance, the
    /// allowance is set to 0 (floor-at-zero semantics).
    ///
    /// This is the safe alternative to `approve` for reducing an existing
    /// non-zero allowance.
    pub fn decrease_allowance(
        env: Env,
        from: Address,
        spender: Address,
        sub_amount: i128,
        expiration_ledger: u32,
    ) {
        from.require_auth();
        Self::bump_instance(&env);

        if sub_amount < 0 {
            panic_with_error!(&env, TokenError::NegativeAllowance);
        }

        let (current, _) = read_allowance(&env, from.clone(), spender.clone());
        let new = if sub_amount >= current {
            0
        } else {
            current - sub_amount
        };

        write_allowance(&env, from.clone(), spender.clone(), new, expiration_ledger);

        ApproveEvent {
            from,
            spender,
            amount: new,
            expiration_ledger,
        }
        .publish(&env);
    }

    // ── Token Interface: Transfers ──────────────────────────────────────────

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        Self::xfer(&env, &from, &to, amount);

        TransferEvent { from, to, amount }.publish(&env);
    }

    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        Self::spend_allowance(&env, &from, &spender, amount);
        Self::xfer(&env, &from, &to, amount);

        TransferEvent { from, to, amount }.publish(&env);
    }

    // ── Token Interface: Burn ───────────────────────────────────────────────

    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        Self::spend_balance(&env, &from, amount);

        BurnEvent { from, amount }.publish(&env);
    }

    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) {
        spender.require_auth();
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        Self::spend_allowance(&env, &from, &spender, amount);
        Self::spend_balance(&env, &from, amount);

        BurnEvent { from, amount }.publish(&env);
    }

    // ── Admin: Mint ─────────────────────────────────────────────────────────

    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = Self::admin(env.clone());
        admin.require_auth();
        Self::bump_instance(&env);

        if amount < 0 {
            panic_with_error!(&env, TokenError::InvalidAmount);
        }

        Self::receive_balance(&env, &to, amount);

        MintEvent { to, amount }.publish(&env);
    }

    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }
}

#[cfg(test)]
mod test;
