#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, U256};

use crate::{Bridge, BridgeError};

fn create_test_env() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let voting_contract = Address::generate(&env);
    let relayer = Address::generate(&env);

    (env, voting_contract, relayer)
}

fn setup_bridge(env: &Env, voting_contract: &Address) -> Address {
    let bridge_contract = env.register_contract(None, Bridge);
    Bridge::constructor(
        env.clone(),
        bridge_contract.clone(),
        voting_contract.clone(),
    );
    bridge_contract
}

#[test]
fn test_constructor() {
    let (env, voting_contract, _) = create_test_env();
    let bridge = setup_bridge(&env, &voting_contract);

    assert_eq!(Bridge::version(&env, bridge.clone()), 1);
    assert_eq!(
        Bridge::voting_contract(&env, bridge.clone()),
        voting_contract
    );
}

#[test]
fn test_relay_vote() {
    let (env, voting_contract, relayer) = create_test_env();
    let bridge = setup_bridge(&env, &voting_contract);

    let dao_id: u64 = 1;
    let proposal_id: u64 = 1;
    let vote_choice = true;
    let nullifier = U256::from_u32(&env, 12345);
    let vote_root = U256::from_u32(&env, 67890);

    Bridge::relay_vote(
        env.clone(),
        bridge.clone(),
        dao_id,
        proposal_id,
        vote_choice,
        nullifier.clone(),
        vote_root,
        relayer.clone(),
    );

    // Verify nullifier is marked as used
    assert!(Bridge::is_nullifier_used(
        &env,
        bridge.clone(),
        dao_id,
        proposal_id,
        nullifier.clone(),
    ));
}

#[test]
fn test_double_vote_rejection() {
    let (env, voting_contract, relayer) = create_test_env();
    let bridge = setup_bridge(&env, &voting_contract);

    let dao_id: u64 = 1;
    let proposal_id: u64 = 1;
    let nullifier = U256::from_u32(&env, 12345);
    let vote_root = U256::from_u32(&env, 67890);

    // First vote succeeds
    Bridge::relay_vote(
        env.clone(),
        bridge.clone(),
        dao_id,
        proposal_id,
        true,
        nullifier.clone(),
        vote_root,
        relayer.clone(),
    );

    // Second vote with same nullifier should panic
    env.catch_contract_import_error(
        || {
            Bridge::relay_vote(
                env.clone(),
                bridge.clone(),
                dao_id,
                proposal_id,
                false,
                nullifier.clone(),
                vote_root,
                relayer.clone(),
            );
        },
        BridgeError::NullifierAlreadyUsed,
    );
}

#[test]
fn test_different_nullifiers_allowed() {
    let (env, voting_contract, relayer) = create_test_env();
    let bridge = setup_bridge(&env, &voting_contract);

    let dao_id: u64 = 1;
    let proposal_id: u64 = 1;
    let vote_root = U256::from_u32(&env, 67890);

    // Two different nullifiers should both succeed
    let nullifier1 = U256::from_u32(&env, 111);
    let nullifier2 = U256::from_u32(&env, 222);

    Bridge::relay_vote(
        env.clone(),
        bridge.clone(),
        dao_id,
        proposal_id,
        true,
        nullifier1.clone(),
        vote_root,
        relayer.clone(),
    );

    Bridge::relay_vote(
        env.clone(),
        bridge.clone(),
        dao_id,
        proposal_id,
        false,
        nullifier2.clone(),
        vote_root,
        relayer.clone(),
    );

    assert!(Bridge::is_nullifier_used(
        &env,
        bridge.clone(),
        dao_id,
        proposal_id,
        nullifier1,
    ));
    assert!(Bridge::is_nullifier_used(
        &env,
        bridge.clone(),
        dao_id,
        proposal_id,
        nullifier2,
    ));
}

#[test]
fn test_zero_nullifier_rejection() {
    let (env, voting_contract, relayer) = create_test_env();
    let bridge = setup_bridge(&env, &voting_contract);

    let nullifier = U256::from_u32(&env, 0);

    env.catch_contract_import_error(
        || {
            Bridge::relay_vote(
                env.clone(),
                bridge.clone(),
                1,
                1,
                true,
                nullifier,
                U256::from_u32(&env, 0),
                relayer.clone(),
            );
        },
        BridgeError::InvalidVoteChoice,
    );
}
