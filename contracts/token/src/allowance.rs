use soroban_sdk::{Address, Env};

const ALLOWANCE_KEY: soroban_sdk::Symbol = soroban_sdk::symbol_short!("allow");

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;

pub fn read_allowance(env: &Env, from: Address, spender: Address) -> (i128, u32) {
    let key = (ALLOWANCE_KEY, from, spender);
    if let Some(allowance) = env.storage().persistent().get::<_, (i128, u32)>(&key) {
        let (amount, expiration_ledger) = allowance;
        if env.ledger().sequence() <= expiration_ledger {
            env.storage()
                .persistent()
                .extend_ttl(&key, INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
            (amount, expiration_ledger)
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    }
}

pub fn read_allowance_amount(env: &Env, from: Address, spender: Address) -> i128 {
    read_allowance(env, from, spender).0
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
        env.storage()
            .persistent()
            .extend_ttl(&key, INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }
}
