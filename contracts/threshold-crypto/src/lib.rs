#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, String, Symbol, Vec, U256,
};

const VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");
const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;
const MAX_AUTHORITIES: u32 = 32;
const MAX_AUTHORITY_NAME_LEN: u32 = 64;
const MAX_VERIFIER_ID_LEN: u32 = 64;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum ThresholdError {
    AlreadyInitialized = 1,
    ElectionNotFound = 2,
    AuthorityAlreadyRegistered = 3,
    AuthorityNotRegistered = 4,
    AuthorityLimitReached = 5,
    InvalidThreshold = 6,
    InvalidAuthorityCount = 7,
    NotAuthorized = 8,
    DkgPhaseMismatch = 9,
    DkgNotCompleted = 10,
    AlreadyCompleted = 11,
    DecryptionShareAlreadySubmitted = 12,
    InsufficientShares = 13,
    InvalidPublicKey = 14,
    InvalidCiphertext = 15,
    InvalidDecryptionShare = 16,
    TallyAlreadyDecrypted = 17,
    TallyNotDecrypted = 18,
    VoteNotEncrypted = 19,
    InvalidProof = 20,
    AuthorityNameTooLong = 21,
    VerifierIdTooLong = 22,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DkgPhase {
    Registration,
    Commitment,
    Completed,
}

#[contracttype]
#[derive(Clone)]
pub struct Authority {
    pub address: Address,
    pub name: String,
    pub registered_at: u64,
    pub dkg_commitment: Option<BytesN<64>>,
    pub decryption_share: Option<BytesN<64>>,
    pub decryption_share_submitted_at: Option<u64>,
    pub verifier_id: String,
}

#[contracttype]
#[derive(Clone)]
pub struct Ciphertext {
    pub c1: BytesN<64>,
    pub c2: BytesN<64>,
}

#[contracttype]
#[derive(Clone)]
pub struct ElectionCryptoConfig {
    pub dao_id: u64,
    pub proposal_id: u64,
    pub threshold_n: u32,
    pub threshold_t: u32,
    pub phase: DkgPhase,
    pub joint_public_key: Option<BytesN<64>>,
    pub encrypted_tally: Option<Ciphertext>,
    pub decrypted_tally: Option<U256>,
    pub tally_proof: Option<BytesN<64>>,
    pub created_at: u64,
    pub created_by: Address,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Election(u64, u64),
    Authority(u64, u64, Address),
    AuthorityList(u64, u64),
    AuthorityCount(u64, u64),
    EncryptedVoteCount(u64, u64),
    VerifierId(Address),
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug)]
pub struct ElectionInitializedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub threshold_n: u32,
    pub threshold_t: u32,
    pub created_by: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug)]
pub struct AuthorityRegisteredEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub authority: Address,
    pub name: String,
    pub verifier_id: String,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug)]
pub struct DkgCommitmentSubmittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub authority: Address,
    pub commitment: BytesN<64>,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug)]
pub struct JointPublicKeySetEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub joint_public_key: BytesN<64>,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug)]
pub struct EncryptedVoteSubmittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub vote_index: u32,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug)]
pub struct DecryptionShareSubmittedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub authority: Address,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug)]
pub struct TallyDecryptedEvent {
    #[topic]
    pub dao_id: u64,
    #[topic]
    pub proposal_id: u64,
    pub decrypted_tally: U256,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug)]
pub struct ContractUpgraded {
    pub from: u32,
    pub to: u32,
}

#[contract]
pub struct ThresholdCrypto;

#[contractimpl]
impl ThresholdCrypto {
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

    pub fn __constructor(env: Env) {
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, ThresholdError::AlreadyInitialized);
        }
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        ContractUpgraded {
            from: 0,
            to: VERSION,
        }
        .publish(&env);
    }

    pub fn version(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage()
            .instance()
            .get(&VERSION_KEY)
            .unwrap_or(VERSION)
    }

    // ── Election Crypto Configuration ──────────────────────────────────

    pub fn initialize_election(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        threshold_n: u32,
        threshold_t: u32,
        created_by: Address,
    ) {
        Self::bump_instance(&env);
        created_by.require_auth();

        if threshold_t == 0 || threshold_t > threshold_n {
            panic_with_error!(&env, ThresholdError::InvalidThreshold);
        }
        if threshold_n == 0 || threshold_n > MAX_AUTHORITIES {
            panic_with_error!(&env, ThresholdError::InvalidAuthorityCount);
        }

        let key = DataKey::Election(dao_id, proposal_id);
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, ThresholdError::AlreadyInitialized);
        }

        let config = ElectionCryptoConfig {
            dao_id,
            proposal_id,
            threshold_n,
            threshold_t,
            phase: DkgPhase::Registration,
            joint_public_key: None,
            encrypted_tally: None,
            decrypted_tally: None,
            tally_proof: None,
            created_at: env.ledger().timestamp(),
            created_by: created_by.clone(),
        };

        env.storage().persistent().set(&key, &config);
        Self::bump_persistent(&env, &key);

        ElectionInitializedEvent {
            dao_id,
            proposal_id,
            threshold_n,
            threshold_t,
            created_by,
        }
        .publish(&env);
    }

    pub fn get_election_config(env: Env, dao_id: u64, proposal_id: u64) -> ElectionCryptoConfig {
        Self::bump_instance(&env);
        let key = DataKey::Election(dao_id, proposal_id);
        let config: ElectionCryptoConfig = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::ElectionNotFound));
        Self::bump_persistent(&env, &key);
        config
    }

    fn get_election_config_mut(env: &Env, dao_id: u64, proposal_id: u64) -> ElectionCryptoConfig {
        let key = DataKey::Election(dao_id, proposal_id);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(env, ThresholdError::ElectionNotFound))
    }

    fn save_election_config(env: &Env, config: &ElectionCryptoConfig) {
        let key = DataKey::Election(config.dao_id, config.proposal_id);
        env.storage().persistent().set(&key, config);
        Self::bump_persistent(env, &key);
    }

    fn require_phase(config: &ElectionCryptoConfig, expected: DkgPhase, env: &Env) {
        if config.phase != expected {
            panic_with_error!(env, ThresholdError::DkgPhaseMismatch);
        }
    }

    // ── Authority Management ───────────────────────────────────────────

    pub fn register_authority(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        authority: Address,
        name: String,
        verifier_id: String,
    ) {
        Self::bump_instance(&env);
        authority.require_auth();

        let mut config = Self::get_election_config_mut(&env, dao_id, proposal_id);
        Self::require_phase(&config, DkgPhase::Registration, &env);

        if name.len() > MAX_AUTHORITY_NAME_LEN {
            panic_with_error!(&env, ThresholdError::AuthorityNameTooLong);
        }
        if verifier_id.len() > MAX_VERIFIER_ID_LEN {
            panic_with_error!(&env, ThresholdError::VerifierIdTooLong);
        }

        let auth_key = DataKey::Authority(dao_id, proposal_id, authority.clone());
        if env.storage().persistent().has(&auth_key) {
            panic_with_error!(&env, ThresholdError::AuthorityAlreadyRegistered);
        }

        let count_key = DataKey::AuthorityCount(dao_id, proposal_id);
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        if count >= config.threshold_n {
            panic_with_error!(&env, ThresholdError::AuthorityLimitReached);
        }

        let auth = Authority {
            address: authority.clone(),
            name: name.clone(),
            registered_at: env.ledger().timestamp(),
            dkg_commitment: None,
            decryption_share: None,
            decryption_share_submitted_at: None,
            verifier_id: verifier_id.clone(),
        };

        env.storage().persistent().set(&auth_key, &auth);
        Self::bump_persistent(&env, &auth_key);

        let list_key = DataKey::AuthorityList(dao_id, proposal_id);
        let mut list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or_else(|| Vec::new(&env));
        list.push_back(authority.clone());
        env.storage().persistent().set(&list_key, &list);
        Self::bump_persistent(&env, &list_key);

        env.storage().persistent().set(&count_key, &(count + 1));
        Self::bump_persistent(&env, &count_key);

        if count + 1 == config.threshold_n {
            config.phase = DkgPhase::Commitment;
            Self::save_election_config(&env, &config);
        }

        AuthorityRegisteredEvent {
            dao_id,
            proposal_id,
            authority,
            name,
            verifier_id,
        }
        .publish(&env);
    }

    pub fn get_authority(env: Env, dao_id: u64, proposal_id: u64, authority: Address) -> Authority {
        Self::bump_instance(&env);
        let key = DataKey::Authority(dao_id, proposal_id, authority);
        let auth: Authority = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::AuthorityNotRegistered));
        Self::bump_persistent(&env, &key);
        auth
    }

    pub fn get_authority_count(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        Self::bump_instance(&env);
        let count_key = DataKey::AuthorityCount(dao_id, proposal_id);
        env.storage().persistent().get(&count_key).unwrap_or(0)
    }

    pub fn get_authority_list(env: Env, dao_id: u64, proposal_id: u64) -> Vec<Address> {
        Self::bump_instance(&env);
        let list_key = DataKey::AuthorityList(dao_id, proposal_id);
        env.storage()
            .persistent()
            .get(&list_key)
            .unwrap_or_else(|| Vec::new(&env))
    }

    // ── DKG Ceremony ────────────────────────────────────────────────────

    pub fn submit_dkg_commitment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        authority: Address,
        commitment: BytesN<64>,
    ) {
        Self::bump_instance(&env);
        authority.require_auth();

        let config = Self::get_election_config_mut(&env, dao_id, proposal_id);
        Self::require_phase(&config, DkgPhase::Commitment, &env);

        let auth_key = DataKey::Authority(dao_id, proposal_id, authority.clone());
        let mut auth: Authority = env
            .storage()
            .persistent()
            .get(&auth_key)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::AuthorityNotRegistered));

        if auth.dkg_commitment.is_some() {
            panic_with_error!(&env, ThresholdError::AlreadyCompleted);
        }

        auth.dkg_commitment = Some(commitment.clone());
        env.storage().persistent().set(&auth_key, &auth);
        Self::bump_persistent(&env, &auth_key);

        DkgCommitmentSubmittedEvent {
            dao_id,
            proposal_id,
            authority,
            commitment,
        }
        .publish(&env);
    }

    pub fn get_dkg_commitment(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        authority: Address,
    ) -> Option<BytesN<64>> {
        Self::bump_instance(&env);
        let key = DataKey::Authority(dao_id, proposal_id, authority);
        let auth: Authority = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::AuthorityNotRegistered));
        auth.dkg_commitment
    }

    pub fn get_all_dkg_commitments(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Vec<(Address, BytesN<64>)> {
        Self::bump_instance(&env);
        let mut commitments = Vec::new(&env);
        let list_key = DataKey::AuthorityList(dao_id, proposal_id);
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or_else(|| Vec::new(&env));
        for addr in list.iter() {
            let auth_key = DataKey::Authority(dao_id, proposal_id, addr.clone());
            if let Some(auth) = env
                .storage()
                .persistent()
                .get::<DataKey, Authority>(&auth_key)
            {
                if let Some(ref commitment) = auth.dkg_commitment {
                    commitments.push_back((addr, commitment.clone()));
                }
            }
        }
        commitments
    }

    pub fn set_joint_public_key(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        joint_public_key: BytesN<64>,
        caller: Address,
    ) {
        Self::bump_instance(&env);
        caller.require_auth();

        let mut config = Self::get_election_config_mut(&env, dao_id, proposal_id);
        Self::require_phase(&config, DkgPhase::Commitment, &env);

        let auth_key = DataKey::Authority(dao_id, proposal_id, caller.clone());
        let _auth: Authority = env
            .storage()
            .persistent()
            .get(&auth_key)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::AuthorityNotRegistered));

        let list_key = DataKey::AuthorityList(dao_id, proposal_id);
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or_else(|| Vec::new(&env));
        for addr in list.iter() {
            let ak = DataKey::Authority(dao_id, proposal_id, addr);
            let auth: Authority = env.storage().persistent().get(&ak).unwrap();
            if auth.dkg_commitment.is_none() {
                panic_with_error!(&env, ThresholdError::DkgNotCompleted);
            }
        }

        config.joint_public_key = Some(joint_public_key.clone());
        config.phase = DkgPhase::Completed;
        Self::save_election_config(&env, &config);

        JointPublicKeySetEvent {
            dao_id,
            proposal_id,
            joint_public_key,
        }
        .publish(&env);
    }

    // ── Encrypted Vote Submission ──────────────────────────────────────

    pub fn submit_encrypted_vote(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        c1: BytesN<64>,
        c2: BytesN<64>,
    ) {
        Self::bump_instance(&env);

        let mut config = Self::get_election_config_mut(&env, dao_id, proposal_id);
        if config.phase != DkgPhase::Completed {
            panic_with_error!(&env, ThresholdError::DkgNotCompleted);
        }
        if config.joint_public_key.is_none() {
            panic_with_error!(&env, ThresholdError::DkgNotCompleted);
        }

        let tally = match config.encrypted_tally {
            Some(ref existing) => {
                let new_c1 = Self::g1_add(&env, &existing.c1, &c1);
                let new_c2 = Self::g1_add(&env, &existing.c2, &c2);
                Ciphertext {
                    c1: new_c1,
                    c2: new_c2,
                }
            }
            None => Ciphertext {
                c1: c1.clone(),
                c2: c2.clone(),
            },
        };

        config.encrypted_tally = Some(tally);
        Self::save_election_config(&env, &config);

        let count_key = DataKey::EncryptedVoteCount(dao_id, proposal_id);
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage().persistent().set(&count_key, &(count + 1));
        Self::bump_persistent(&env, &count_key);

        EncryptedVoteSubmittedEvent {
            dao_id,
            proposal_id,
            vote_index: count,
        }
        .publish(&env);
    }

    pub fn get_encrypted_vote_count(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        Self::bump_instance(&env);
        let count_key = DataKey::EncryptedVoteCount(dao_id, proposal_id);
        env.storage().persistent().get(&count_key).unwrap_or(0)
    }

    pub fn get_encrypted_tally(env: Env, dao_id: u64, proposal_id: u64) -> Option<Ciphertext> {
        Self::bump_instance(&env);
        let config = Self::get_election_config_mut(&env, dao_id, proposal_id);
        config.encrypted_tally
    }

    // ── Decryption ─────────────────────────────────────────────────────

    pub fn submit_decryption_share(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        authority: Address,
        share: BytesN<64>,
    ) {
        Self::bump_instance(&env);
        authority.require_auth();

        let config = Self::get_election_config_mut(&env, dao_id, proposal_id);
        if config.joint_public_key.is_none() {
            panic_with_error!(&env, ThresholdError::DkgNotCompleted);
        }
        if config.decrypted_tally.is_some() {
            panic_with_error!(&env, ThresholdError::TallyAlreadyDecrypted);
        }

        let auth_key = DataKey::Authority(dao_id, proposal_id, authority.clone());
        let mut auth: Authority = env
            .storage()
            .persistent()
            .get(&auth_key)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::AuthorityNotRegistered));

        if auth.decryption_share.is_some() {
            panic_with_error!(&env, ThresholdError::DecryptionShareAlreadySubmitted);
        }

        auth.decryption_share = Some(share.clone());
        auth.decryption_share_submitted_at = Some(env.ledger().timestamp());
        env.storage().persistent().set(&auth_key, &auth);
        Self::bump_persistent(&env, &auth_key);

        DecryptionShareSubmittedEvent {
            dao_id,
            proposal_id,
            authority,
        }
        .publish(&env);
    }

    pub fn get_decryption_share(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        authority: Address,
    ) -> Option<BytesN<64>> {
        Self::bump_instance(&env);
        let auth_key = DataKey::Authority(dao_id, proposal_id, authority);
        let auth: Authority = env
            .storage()
            .persistent()
            .get(&auth_key)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::AuthorityNotRegistered));
        auth.decryption_share
    }

    pub fn get_all_decryption_shares(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Vec<(Address, BytesN<64>)> {
        Self::bump_instance(&env);
        let mut shares = Vec::new(&env);
        let list_key = DataKey::AuthorityList(dao_id, proposal_id);
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or_else(|| Vec::new(&env));
        for addr in list.iter() {
            let auth_key = DataKey::Authority(dao_id, proposal_id, addr.clone());
            if let Some(auth) = env
                .storage()
                .persistent()
                .get::<DataKey, Authority>(&auth_key)
            {
                if let Some(ref share) = auth.decryption_share {
                    shares.push_back((addr, share.clone()));
                }
            }
        }
        shares
    }

    pub fn get_decryption_share_count(env: Env, dao_id: u64, proposal_id: u64) -> u32 {
        Self::bump_instance(&env);
        let mut count: u32 = 0;
        let list_key = DataKey::AuthorityList(dao_id, proposal_id);
        let list: Vec<Address> = env
            .storage()
            .persistent()
            .get(&list_key)
            .unwrap_or_else(|| Vec::new(&env));
        for addr in list.iter() {
            let auth_key = DataKey::Authority(dao_id, proposal_id, addr);
            if let Some(auth) = env
                .storage()
                .persistent()
                .get::<DataKey, Authority>(&auth_key)
            {
                if auth.decryption_share.is_some() {
                    count += 1;
                }
            }
        }
        count
    }

    pub fn set_decrypted_tally(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
        decrypted_tally: U256,
        tally_proof: BytesN<64>,
        caller: Address,
    ) {
        Self::bump_instance(&env);
        caller.require_auth();

        let mut config = Self::get_election_config_mut(&env, dao_id, proposal_id);
        if config.joint_public_key.is_none() {
            panic_with_error!(&env, ThresholdError::DkgNotCompleted);
        }
        if config.decrypted_tally.is_some() {
            panic_with_error!(&env, ThresholdError::TallyAlreadyDecrypted);
        }
        if config.encrypted_tally.is_none() {
            panic_with_error!(&env, ThresholdError::VoteNotEncrypted);
        }

        let auth_key = DataKey::Authority(dao_id, proposal_id, caller.clone());
        let _auth: Authority = env
            .storage()
            .persistent()
            .get(&auth_key)
            .unwrap_or_else(|| panic_with_error!(&env, ThresholdError::AuthorityNotRegistered));

        let share_count = Self::get_decryption_share_count(env.clone(), dao_id, proposal_id);
        if share_count < config.threshold_t {
            panic_with_error!(&env, ThresholdError::InsufficientShares);
        }

        config.decrypted_tally = Some(decrypted_tally.clone());
        config.tally_proof = Some(tally_proof.clone());
        Self::save_election_config(&env, &config);

        TallyDecryptedEvent {
            dao_id,
            proposal_id,
            decrypted_tally,
        }
        .publish(&env);
    }

    pub fn get_decrypted_tally(
        env: Env,
        dao_id: u64,
        proposal_id: u64,
    ) -> Option<(U256, BytesN<64>)> {
        Self::bump_instance(&env);
        let config = Self::get_election_config_mut(&env, dao_id, proposal_id);
        match config.decrypted_tally {
            Some(tally) => match config.tally_proof {
                Some(proof) => Some((tally, proof)),
                None => Some((tally, BytesN::from_array(&env, &[0u8; 64]))),
            },
            None => None,
        }
    }

    // ── G1 Operations (BN254) ──────────────────────────────────────────

    fn g1_add(env: &Env, a: &BytesN<64>, b: &BytesN<64>) -> BytesN<64> {
        use soroban_sdk::crypto::bn254::Bn254G1Affine;
        let p1 = Bn254G1Affine::from_bytes(a.clone());
        let p2 = Bn254G1Affine::from_bytes(b.clone());
        let sum = p1 + p2;
        sum.to_array().into()
    }

    // ── Verifier ID ────────────────────────────────────────────────────

    pub fn set_verifier_id(env: Env, address: Address, verifier_id: String) {
        address.require_auth();
        Self::bump_instance(&env);
        if verifier_id.len() > MAX_VERIFIER_ID_LEN {
            panic_with_error!(&env, ThresholdError::VerifierIdTooLong);
        }
        let key = DataKey::VerifierId(address.clone());
        env.storage().persistent().set(&key, &verifier_id);
        Self::bump_persistent(&env, &key);
    }

    pub fn get_verifier_id(env: Env, address: Address) -> Option<String> {
        Self::bump_instance(&env);
        let key = DataKey::VerifierId(address);
        env.storage().persistent().get(&key)
    }
}
