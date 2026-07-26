use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    Env,
};

fn setup_token() -> (Env, Address, TokenClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    (env, admin, client)
}

fn setup_token_with_balance() -> (Env, Address, Address, Address, TokenClient<'static>) {
    let (env, admin, client) = setup_token();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.mint(&alice, &1000i128);

    (env, admin, alice, bob, client)
}

// ── Approve: zero-to-non-zero (baseline, must not regress) ────────────────────

#[test]
fn test_approve_from_zero_to_non_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &50i128, &expiration);

    assert_eq!(client.allowance(&alice, &bob), 50);
}

// ── Approve: non-zero-to-zero (baseline, must not regress) ────────────────────

#[test]
fn test_approve_from_non_zero_to_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 50);

    client.approve(&alice, &bob, &0i128, &0u32);

    assert_eq!(client.allowance(&alice, &bob), 0);
}

// ── Approve: race condition rejection (the core of the fix) ───────────────────

#[test]
#[should_panic(expected = "HostError")]
fn test_approve_race_rejects_non_zero_to_different_non_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    client.approve(&alice, &bob, &50i128, &expiration);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_approve_race_rejects_non_zero_to_higher_non_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 50);

    client.approve(&alice, &bob, &150i128, &expiration);
}

// ── Approve: safe two-step pattern still works ────────────────────────────────

#[test]
fn test_approve_safe_two_step_pattern() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    client.approve(&alice, &bob, &0i128, &0u32);
    assert_eq!(client.allowance(&alice, &bob), 0);

    client.approve(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 50);
}

// ── Approve: same non-zero value (no-op) is allowed ──────────────────────────

#[test]
fn test_approve_same_non_zero_allowed() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &75i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 75);

    client.approve(&alice, &bob, &75i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 75);
}

// ── increase_allowance ───────────────────────────────────────────────────────

#[test]
fn test_increase_allowance_adds_to_existing() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 50);

    client.increase_allowance(&alice, &bob, &30i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 80);
}

#[test]
fn test_increase_allowance_from_zero_starts_at_value() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.increase_allowance(&alice, &bob, &25i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 25);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_increase_allowance_overflow_panics() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &i128::MAX, &expiration);
    assert_eq!(client.allowance(&alice, &bob), i128::MAX);

    client.increase_allowance(&alice, &bob, &1i128, &expiration);
}

// ── decrease_allowance ───────────────────────────────────────────────────────

#[test]
fn test_decrease_allowance_subtracts_from_existing() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    client.decrease_allowance(&alice, &bob, &40i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 60);
}

#[test]
fn test_decrease_allowance_floors_at_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &30i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 30);

    client.decrease_allowance(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 0);
}

#[test]
fn test_decrease_allowance_exact_amount_goes_to_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 50);

    client.decrease_allowance(&alice, &bob, &50i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 0);
}

#[test]
fn test_decrease_allowance_from_zero_stays_zero() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.decrease_allowance(&alice, &bob, &10i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 0);
}

// ── The exact Alice/Bob race scenario from the issue ─────────────────────────

#[test]
#[should_panic(expected = "HostError")]
fn test_alice_bob_race_scenario_rejected() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;

    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    client.approve(&alice, &bob, &50i128, &expiration);
}

// ── Negative amount rejection ────────────────────────────────────────────────

#[test]
#[should_panic(expected = "HostError")]
fn test_increase_allowance_negative_rejected() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let expiration = 9999999;

    client.increase_allowance(&alice, &bob, &(-10i128), &expiration);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_decrease_allowance_negative_rejected() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let expiration = 9999999;

    client.decrease_allowance(&alice, &bob, &(-10i128), &expiration);
}

// ── transfer_from consumes allowance ─────────────────────────────────────────

#[test]
fn test_transfer_from_consumes_allowance() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let charlie = Address::generate(&_env);

    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    client.transfer_from(&bob, &alice, &charlie, &30i128);

    assert_eq!(client.allowance(&alice, &bob), 70);
    assert_eq!(client.balance(&alice), 970);
    assert_eq!(client.balance(&charlie), 30);
}

// ── Expiration ledger handling ───────────────────────────────────────────────

#[test]
fn test_expired_allowance_treated_as_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &1000i128);

    let current_ledger = env.ledger().sequence();
    let expiration = current_ledger + 5;

    client.approve(&alice, &bob, &100i128, &expiration);
    assert_eq!(client.allowance(&alice, &bob), 100);

    env.ledger().with_mut(|l| l.sequence_number = expiration + 1);

    assert_eq!(client.allowance(&alice, &bob), 0);
}

#[test]
fn test_increase_allowance_sets_new_expiration() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &1000i128);

    let current = env.ledger().sequence();
    let expiration1 = current + 10;
    let expiration2 = current + 50;

    client.approve(&alice, &bob, &50i128, &expiration1);

    client.increase_allowance(&alice, &bob, &25i128, &expiration2);

    env.ledger().with_mut(|l| l.sequence_number = expiration1 + 1);

    assert_eq!(client.allowance(&alice, &bob), 75);
}

#[test]
fn test_decrease_allowance_preserves_expiration() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "TestToken"),
            String::from_str(&env, "TT"),
            18u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.mint(&alice, &1000i128);

    let current = env.ledger().sequence();
    let expiration = current + 50;

    client.approve(&alice, &bob, &100i128, &expiration);
    client.decrease_allowance(&alice, &bob, &30i128, &expiration);

    assert_eq!(client.allowance(&alice, &bob), 70);
}

// ── Events ───────────────────────────────────────────────────────────────────

#[test]
fn test_approve_emits_event() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let token_id = client.address.clone();

    let expiration = 9999999;
    client.approve(&alice, &bob, &100i128, &expiration);

    let contract_events = env.events().all().filter_by_contract(&token_id);
    assert!(!contract_events.events().is_empty());
}

#[test]
fn test_increase_allowance_emits_event() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let token_id = client.address.clone();

    let expiration = 9999999;
    client.increase_allowance(&alice, &bob, &30i128, &expiration);

    let contract_events = env.events().all().filter_by_contract(&token_id);
    assert!(!contract_events.events().is_empty());
}

#[test]
fn test_decrease_allowance_emits_event() {
    let (env, admin, alice, bob, client) = setup_token_with_balance();
    let _ = admin;
    let token_id = client.address.clone();
    let expiration = 9999999;

    client.approve(&alice, &bob, &100i128, &expiration);
    client.decrease_allowance(&alice, &bob, &30i128, &expiration);

    let contract_events = env.events().all().filter_by_contract(&token_id);
    assert!(!contract_events.events().is_empty());
}

// ── Standard token functions still work ──────────────────────────────────────

#[test]
fn test_transfer_basic() {
    let (_env, admin, alice, bob, client) = setup_token_with_balance();
    let _admin = admin;

    client.transfer(&alice, &bob, &200i128);

    assert_eq!(client.balance(&alice), 800);
    assert_eq!(client.balance(&bob), 200);
}

#[test]
fn test_mint_admin_only() {
    let (_env, admin, _alice, _bob, client) = setup_token_with_balance();
    let _admin = admin;

    let charlie = Address::generate(&_env);
    client.mint(&charlie, &500i128);
    assert_eq!(client.balance(&charlie), 500);
}

#[test]
fn test_name_symbol_decimals() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token_id = env.register(
        Token,
        (
            admin.clone(),
            String::from_str(&env, "MyToken"),
            String::from_str(&env, "MTK"),
            6u32,
        ),
    );
    let client = TokenClient::new(&env, &token_id);

    assert_eq!(client.name(), String::from_str(&env, "MyToken"));
    assert_eq!(client.symbol(), String::from_str(&env, "MTK"));
    assert_eq!(client.decimals(), 6);
}
