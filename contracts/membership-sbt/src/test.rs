use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Events as _, testutils::Ledger as _, Env};

// Mock registry contract for testing
mod mock_registry {
    use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

    #[contract]
    pub struct MockRegistry;

    #[contractimpl]
    impl MockRegistry {
        pub fn set_admin(env: Env, dao_id: u64, admin: Address) {
            let admin_key = (symbol_short!("admin"), dao_id);
            env.storage().persistent().set(&admin_key, &admin);
        }

        pub fn get_admin(env: Env, dao_id: u64) -> Address {
            let admin_key = (symbol_short!("admin"), dao_id);
            env.storage().persistent().get(&admin_key).unwrap()
        }

        pub fn set_membership_open(env: Env, dao_id: u64, is_open: bool) {
            let open_key = (Symbol::new(&env, "is_open"), dao_id);
            env.storage().persistent().set(&open_key, &is_open);
        }

        pub fn is_membership_open(env: Env, dao_id: u64) -> bool {
            let open_key = (Symbol::new(&env, "is_open"), dao_id);
            env.storage().persistent().get(&open_key).unwrap_or(false)
        }
    }
}

fn setup_env() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let registry_id = env.register(mock_registry::MockRegistry, ());
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Register SBT with constructor
    let sbt_id = env.register(MembershipSbt, (registry_id.clone(),));
    let _sbt_client = MembershipSbtClient::new(&env, &sbt_id);

    let admin = Address::generate(&env);
    let member = Address::generate(&env);

    // Set up mock registry with admin for DAO 1
    registry_client.set_admin(&1u64, &admin);

    (env, sbt_id, registry_id, admin, member)
}

#[test]
fn test_constructor() {
    let env = Env::default();
    env.mock_all_auths();

    let registry_id = env.register(mock_registry::MockRegistry, ());
    let sbt_id = env.register(MembershipSbt, (registry_id.clone(),));
    let client = MembershipSbtClient::new(&env, &sbt_id);

    assert_eq!(client.registry(), registry_id);
}

#[test]
fn test_mint() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    assert!(!client.has(&1u64, &member));
    client.mint(&1u64, &member, &admin, &None);
    assert!(client.has(&1u64, &member));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_mint_twice_fails() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.mint(&1u64, &member, &admin, &None);
    client.mint(&1u64, &member, &admin, &None); // Should panic
}

#[test]
fn test_has_returns_false_for_non_member() {
    let (env, sbt_id, _, _, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let non_member = Address::generate(&env);
    assert!(!client.has(&1u64, &non_member));
}

#[test]
fn test_mint_multiple_members_same_dao() {
    let (env, sbt_id, _, admin, member1) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let member2 = Address::generate(&env);
    let member3 = Address::generate(&env);

    client.mint(&1u64, &member1, &admin, &None);
    client.mint(&1u64, &member2, &admin, &None);
    client.mint(&1u64, &member3, &admin, &None);

    assert!(client.has(&1u64, &member1));
    assert!(client.has(&1u64, &member2));
    assert!(client.has(&1u64, &member3));
}

#[test]
fn test_same_member_different_daos() {
    let (env, sbt_id, registry_id, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Set up admin for DAO 2
    registry_client.set_admin(&2u64, &admin);

    // Member joins both DAOs
    client.mint(&1u64, &member, &admin, &None);
    client.mint(&2u64, &member, &admin, &None);

    assert!(client.has(&1u64, &member));
    assert!(client.has(&2u64, &member));
}

#[test]
fn test_different_daos_isolated() {
    let (env, sbt_id, registry_id, admin1, member1) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    let admin2 = Address::generate(&env);
    let member2 = Address::generate(&env);

    // Set up admin for DAO 2
    registry_client.set_admin(&2u64, &admin2);

    // Mint to different DAOs
    client.mint(&1u64, &member1, &admin1, &None);
    client.mint(&2u64, &member2, &admin2, &None);

    // Members are isolated per DAO
    assert!(client.has(&1u64, &member1));
    assert!(!client.has(&1u64, &member2));
    assert!(!client.has(&2u64, &member1));
    assert!(client.has(&2u64, &member2));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_wrong_admin_cannot_mint() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let wrong_admin = Address::generate(&env);
    client.mint(&1u64, &member, &wrong_admin, &None); // Should panic
}

#[test]
fn test_events_emitted_on_mint() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.mint(&1u64, &member, &admin, &None);

    let events = env.events().all().filter_by_contract(&sbt_id);
    assert!(!events.events().is_empty());
}

#[test]
#[should_panic(expected = "HostError")]
fn test_mint_to_nonexistent_dao_fails() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    // DAO 999 doesn't exist in registry
    client.mint(&999u64, &member, &admin, &None);
}

#[test]
fn test_has_on_nonexistent_dao_returns_false() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    // DAO 999 doesn't exist, but has() should just return false
    assert!(!client.has(&999u64, &member));
}

#[test]
fn test_mint_from_registry() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    assert!(!client.has(&1u64, &member));
    client.mint_from_registry(&1u64, &member);
    assert!(client.has(&1u64, &member));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_mint_from_registry_twice_fails() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.mint_from_registry(&1u64, &member);
    client.mint_from_registry(&1u64, &member); // Should panic
}

#[test]
fn test_mint_from_registry_multiple_members() {
    let (env, sbt_id, _, _, member1) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let member2 = Address::generate(&env);
    let member3 = Address::generate(&env);

    client.mint_from_registry(&1u64, &member1);
    client.mint_from_registry(&1u64, &member2);
    client.mint_from_registry(&1u64, &member3);

    assert!(client.has(&1u64, &member1));
    assert!(client.has(&1u64, &member2));
    assert!(client.has(&1u64, &member3));
}

#[test]
fn test_events_emitted_on_mint_from_registry() {
    let (env, sbt_id, _, _, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    client.mint_from_registry(&1u64, &member);

    let events = env.events().all().filter_by_contract(&sbt_id);
    assert!(!events.events().is_empty());
}

#[test]
fn test_self_join_open_dao() {
    let (env, sbt_id, registry_id, _, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Set DAO 2 to have open membership
    registry_client.set_membership_open(&2u64, &true);

    let new_member = Address::generate(&env);

    assert!(!client.has(&2u64, &new_member));
    client.self_join(&2u64, &new_member, &None);
    assert!(client.has(&2u64, &new_member));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_self_join_closed_dao_fails() {
    let (env, sbt_id, registry_id, _, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Set DAO 2 to have closed membership (default is false)
    registry_client.set_membership_open(&2u64, &false);

    let new_member = Address::generate(&env);
    client.self_join(&2u64, &new_member, &None);
}

#[test]
#[should_panic(expected = "HostError")]
fn test_self_join_twice_fails() {
    let (env, sbt_id, registry_id, _, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    let registry_client = mock_registry::MockRegistryClient::new(&env, &registry_id);

    // Set DAO 2 to have open membership
    registry_client.set_membership_open(&2u64, &true);

    let new_member = Address::generate(&env);
    client.self_join(&2u64, &new_member, &None);
    client.self_join(&2u64, &new_member, &None); // Should panic
}

// ── Soulbound guarantee: transfer/approval attempts always reject (#357) ──

#[test]
fn test_transfer_is_rejected() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    client.mint(&1u64, &member, &admin, &None);

    let recipient = Address::generate(&env);
    let result = client.try_transfer(&1u64, &member, &recipient, &1i128);

    assert!(result.is_err());
    // The soulbound invariant holds: nothing moved.
    assert!(client.has(&1u64, &member));
    assert!(!client.has(&1u64, &recipient));
}

#[test]
fn test_transfer_from_is_rejected() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    client.mint(&1u64, &member, &admin, &None);

    let spender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let result = client.try_transfer_from(&1u64, &spender, &member, &recipient, &1i128);

    assert!(result.is_err());
    assert!(client.has(&1u64, &member));
}

#[test]
fn test_approve_is_rejected() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    client.mint(&1u64, &member, &admin, &None);

    let spender = Address::generate(&env);
    let result = client.try_approve(&1u64, &member, &spender, &1i128, &1000u32);

    assert!(result.is_err());
}

#[test]
#[should_panic(expected = "HostError")]
fn test_transfer_panics_even_without_an_existing_membership() {
    // The reject-trap fires before any membership lookup: an address that
    // was never minted an SBT still can't "transfer" one.
    let (env, sbt_id, _, _, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let stranger = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.transfer(&1u64, &stranger, &recipient, &1i128);
}

// ── State-expiry regression tests (#audit-H1) ─────────────────────────────────
//
// The finding that motivated these was missed by every other test in this file
// because `Env::default()` never advances the ledger: no TTL threshold is ever
// crossed, so the expiry behaviour is completely unobserved. These tests
// advance the ledger explicitly and assert the membership survives, which is
// the only way the 31-day window that this contract used to run on could have
// been caught.

/// Advance the ledger far enough to cross what the *old* window would have
/// archived: 535_680 ledgers at 5s/ledger is ~31 days, so 40 days of silence
/// used to be enough to lose a membership record.
const DAYS_40: u32 = 40;

fn advance_days(env: &Env, days: u32) {
    env.ledger()
        .with_mut(|li| li.timestamp += u64::from(days) * 86_400);
}

#[test]
fn test_membership_survives_forty_days_of_inactivity() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    client.mint(&1u64, &member, &admin, &None);
    assert!(client.has(&1u64, &member));

    advance_days(&env, DAYS_40);

    // The whole point: the record is still there after a window that used to
    // archive it. `Env::default()`'s ledger config keeps entries live, so this
    // asserts the code's *choice* of window and bumping discipline, not a
    // storage-class race.
    assert!(client.has(&1u64, &member));
    assert_eq!(client.get_member_count(&1u64), 1);
}

#[test]
fn test_mint_time_anchor_is_not_lost_or_rewritten_after_inactivity() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    // Mint at t0, then age the identity past the first weight threshold.
    client.mint(&1u64, &member, &admin, &None);
    advance_days(&env, 40);
    // Reading it must refresh the record rather than let it lapse.
    assert_eq!(client.member_age_days(&1u64, &member), 40);

    // A revoke/re-mint cycle must not reset the age anchor: `record_mint_time`
    // is documented as write-once precisely so a burnt identity cannot be
    // recycled into a fresh-looking one.
    client.revoke(&1u64, &member, &admin);
    client.mint(&1u64, &member, &admin, &None);

    assert_eq!(
        client.member_age_days(&1u64, &member),
        40,
        "re-minting must not reset the SBT age anchor"
    );
}

#[test]
fn test_sweep_dao_refreshes_passive_members_and_enumerates_nobody() {
    let (env, sbt_id, _, admin, _) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);

    let m1 = Address::generate(&env);
    let m2 = Address::generate(&env);
    let m3 = Address::generate(&env);
    client.mint(&1u64, &m1, &admin, &None);
    client.mint(&1u64, &m2, &admin, &None);
    client.mint(&1u64, &m3, &admin, &None);
    let count_before = client.get_member_count(&1u64);

    // The sweep is a pure keepalive: it must not add a member, must not mint,
    // and must not change who has an SBT.
    let swept = client.sweep_dao(&1u64, &0u64, &10u32);
    assert_eq!(swept, 3);
    assert_eq!(client.get_member_count(&1u64), count_before);
    assert!(client.has(&1u64, &m1));
    assert!(client.has(&1u64, &m2));
    assert!(client.has(&1u64, &m3));

    // Pagination: a second page past the end is a no-op.
    assert_eq!(client.sweep_dao(&1u64, &3u64, &10u32), 0);
    // An oversized limit is clamped rather than blowing the budget.
    assert_eq!(client.sweep_dao(&1u64, &0u64, &10_000u32), 3);
}

#[test]
fn test_registration_cooldown_state_survives_inactivity() {
    let (env, sbt_id, _, admin, member) = setup_env();
    let client = MembershipSbtClient::new(&env, &sbt_id);
    client.mint(&1u64, &member, &admin, &None);

    // Park the member in a cooldown that is still far in the future.
    let now = env.ledger().timestamp();
    client.set_election_cooldown(&1u64, &member, &(now + 7 * 86_400));
    assert!(client.is_in_cooldown(&1u64, &member));

    advance_days(&env, 3);

    // Reading `is_in_cooldown` used to forget to refresh the record it
    // consulted, so a member could simply wait out the cooldown by going quiet.
    assert!(client.is_in_cooldown(&1u64, &member));
}
