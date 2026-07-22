use soroban_sdk::{testutils::Address as _, Address, Env, U256};

use crate::{Bridge, BridgeClient};

fn create_test_env() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let voting_contract = Address::generate(&env);
    let relayer = Address::generate(&env);

    (env, voting_contract, relayer)
}

fn setup_bridge<'a>(env: &'a Env, voting_contract: &Address) -> (Address, BridgeClient<'a>) {
    let bridge_id = env.register(Bridge, (voting_contract.clone(),));
    let client = BridgeClient::new(env, &bridge_id);
    (bridge_id, client)
}

#[test]
fn test_constructor() {
    let (env, voting_contract, _) = create_test_env();
    let (bridge_id, client) = setup_bridge(&env, &voting_contract);

    assert_eq!(client.version(), 1);
    assert_eq!(client.voting_contract(), voting_contract);
    assert_eq!(bridge_id, client.address);
}

#[test]
fn test_relay_vote() {
    let (env, voting_contract, relayer) = create_test_env();
    let (_bridge_id, client) = setup_bridge(&env, &voting_contract);

    let dao_id: u64 = 1;
    let proposal_id: u64 = 1;
    let vote_choice = true;
    let nullifier = U256::from_u32(&env, 12345);
    let vote_root = U256::from_u32(&env, 67890);

    client.relay_vote(
        &dao_id,
        &proposal_id,
        &vote_choice,
        &nullifier,
        &vote_root,
        &relayer,
    );

    // Verify nullifier is marked as used
    assert!(client.is_nullifier_used(&dao_id, &proposal_id, &nullifier));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_double_vote_rejection() {
    let (env, voting_contract, relayer) = create_test_env();
    let (_bridge_id, client) = setup_bridge(&env, &voting_contract);

    let dao_id: u64 = 1;
    let proposal_id: u64 = 1;
    let nullifier = U256::from_u32(&env, 12345);
    let vote_root = U256::from_u32(&env, 67890);

    // First vote succeeds
    client.relay_vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier,
        &vote_root,
        &relayer,
    );

    // Second vote with same nullifier should panic
    client.relay_vote(
        &dao_id,
        &proposal_id,
        &false,
        &nullifier,
        &vote_root,
        &relayer,
    );
}

#[test]
fn test_different_nullifiers_allowed() {
    let (env, voting_contract, relayer) = create_test_env();
    let (_bridge_id, client) = setup_bridge(&env, &voting_contract);

    let dao_id: u64 = 1;
    let proposal_id: u64 = 1;
    let vote_root = U256::from_u32(&env, 67890);

    // Two different nullifiers should both succeed
    let nullifier1 = U256::from_u32(&env, 111);
    let nullifier2 = U256::from_u32(&env, 222);

    client.relay_vote(
        &dao_id,
        &proposal_id,
        &true,
        &nullifier1,
        &vote_root,
        &relayer,
    );

    client.relay_vote(
        &dao_id,
        &proposal_id,
        &false,
        &nullifier2,
        &vote_root,
        &relayer,
    );

    assert!(client.is_nullifier_used(&dao_id, &proposal_id, &nullifier1));
    assert!(client.is_nullifier_used(&dao_id, &proposal_id, &nullifier2));
}

#[test]
#[should_panic(expected = "HostError")]
fn test_zero_nullifier_rejection() {
    let (env, voting_contract, relayer) = create_test_env();
    let (_bridge_id, client) = setup_bridge(&env, &voting_contract);

    let nullifier = U256::from_u32(&env, 0);

    client.relay_vote(
        &1u64,
        &1u64,
        &true,
        &nullifier,
        &U256::from_u32(&env, 0),
        &relayer,
    );
}
