use soroban_sdk::{Address, Env};

const ALLOWANCE_KEY: soroban_sdk::Symbol = soroban_sdk::symbol_short!("allow");

const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

pub fn read_allowance(env: &Env, from: Address, spender: Address) -> (i128, u32) {
    let key = (ALLOWANCE_KEY, from, spender);
    if let Some(allowance) = env.storage().persistent().get::<_, (i128, u32)>(&key) {
        let (amount, expiration_ledger) = allowance;
        if env.ledger().sequence() <= expiration_ledger {
            (amount, expiration_ledger)
        } else {
            env.storage().persistent().remove(&key);
            (0, 0)
        }
    } else {
        (0, 0)
    }
}

pub fn read_allowance_amount(env: &Env, from: Address, spender: Address) -> i128 {
    read_allowance(env, from, spender).0
}

pub fn is_allowance_expired(env: &Env, from: Address, spender: Address) -> bool {
    let key = (ALLOWANCE_KEY, from, spender);
    if let Some(allowance) = env.storage().persistent().get::<_, (i128, u32)>(&key) {
        let (_, expiration_ledger) = allowance;
        env.ledger().sequence() > expiration_ledger
    } else {
        true
    }
}

pub fn write_allowance(
    env: &Env,
    from: Address,
    spender: Address,
    amount: i128,
    expiration_ledger: u32,
) {
    let key = (ALLOWANCE_KEY, from, spender);
    if amount == 0 && expiration_ledger == 0 {
        env.storage().persistent().remove(&key);
    } else {
        env.storage()
            .persistent()
            .set(&key, &(amount, expiration_ledger));

        let current_seq = env.ledger().sequence();
        if expiration_ledger > current_seq {
            let remaining = expiration_ledger - current_seq;
            let ttl_threshold = remaining.max(PERSISTENT_TTL_THRESHOLD);
            let ttl_extend = remaining.max(PERSISTENT_TTL_EXTEND);
            env.storage()
                .persistent()
                .extend_ttl(&key, ttl_threshold, ttl_extend);
        } else {
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_TTL_THRESHOLD,
                PERSISTENT_TTL_EXTEND,
            );
        }
    }
}
