#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, String, Symbol,
};

use zkvote_groth16::VerificationKey;

const VERSION: u32 = 1;
const VERSION_KEY: Symbol = symbol_short!("ver");
const GOVERNANCE: Symbol = symbol_short!("gov");

const INSTANCE_TTL_THRESHOLD: u32 = 120_960;
const INSTANCE_TTL_EXTEND: u32 = 535_680;
const PERSISTENT_TTL_THRESHOLD: u32 = 120_960;
const PERSISTENT_TTL_EXTEND: u32 = 535_680;

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum RegistryError {
    NotGovernance = 1,
    CircuitNotFound = 2,
    CircuitAlreadyRegistered = 3,
    InvalidCircuitType = 4,
    MigrationNotFound = 5,
    MigrationAlreadyExists = 6,
    MigrationDeadlinePassed = 7,
    CircuitExpired = 8,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CircuitType {
    Vote,
    Comment,
}

#[contracttype]
#[derive(Clone)]
pub struct CircuitInfo {
    pub circuit_id: String,
    pub circuit_type: CircuitType,
    pub vk: VerificationKey,
    pub wasm_hash: BytesN<32>,
    pub registered_at: u64,
    pub expiration: u64,
    pub num_public_signals: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct DaoMigration {
    pub dao_id: u64,
    pub from_circuit_id: String,
    pub to_circuit_id: String,
    pub migration_start: u64,
    pub deadline: u64,
    pub active: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct CircuitVKMap {
    pub vk: VerificationKey,
    pub num_public_signals: u32,
}

#[contracttype]
pub enum DataKey {
    Circuit(String, CircuitType),
    DaoMigration(u64),
    DaoCurrentCircuit(u64, CircuitType),
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CircuitRegisteredEvent {
    #[topic]
    pub circuit_id: String,
    pub circuit_type: CircuitType,
    pub registered_at: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct DaoMigrationEvent {
    #[topic]
    pub dao_id: u64,
    pub from_circuit_id: String,
    pub to_circuit_id: String,
    pub deadline: u64,
}

#[soroban_sdk::contractevent]
#[derive(Clone, Debug, PartialEq)]
pub struct CircuitUpgradedEvent {
    #[topic]
    pub dao_id: u64,
    pub circuit_type: CircuitType,
    pub to_circuit_id: String,
}

#[contract]
pub struct CircuitRegistry;

#[contractimpl]
impl CircuitRegistry {
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

    pub fn __constructor(env: Env, governance: Address) {
        if env.storage().instance().has(&VERSION_KEY) {
            panic_with_error!(&env, RegistryError::NotGovernance);
        }
        env.storage().instance().set(&VERSION_KEY, &VERSION);
        env.storage().instance().set(&GOVERNANCE, &governance);
    }

    fn assert_governance(env: &Env) {
        let governance: Address = env.storage().instance().get(&GOVERNANCE).unwrap();
        governance.require_auth();
    }

    pub fn register_circuit(
        env: Env,
        circuit_id: String,
        circuit_type: CircuitType,
        vk: VerificationKey,
        wasm_hash: BytesN<32>,
        expiration: u64,
        num_public_signals: u32,
    ) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);

        let key = DataKey::Circuit(circuit_id.clone(), circuit_type.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, RegistryError::CircuitAlreadyRegistered);
        }

        let circuit = CircuitInfo {
            circuit_id: circuit_id.clone(),
            circuit_type: circuit_type.clone(),
            vk,
            wasm_hash,
            registered_at: env.ledger().timestamp(),
            expiration,
            num_public_signals,
        };

        env.storage().persistent().set(&key, &circuit);
        Self::bump_persistent(&env, &key);

        CircuitRegisteredEvent {
            circuit_id,
            circuit_type,
            registered_at: env.ledger().timestamp(),
        }
        .publish(&env);
    }

    pub fn get_circuit(env: Env, circuit_id: String, circuit_type: CircuitType) -> CircuitInfo {
        Self::bump_instance(&env);
        let key = DataKey::Circuit(circuit_id.clone(), circuit_type.clone());
        let circuit: CircuitInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::CircuitNotFound));
        Self::bump_persistent(&env, &key);
        circuit
    }

    pub fn get_vk(
        env: Env,
        circuit_id: String,
        circuit_type: CircuitType,
    ) -> CircuitVKMap {
        Self::bump_instance(&env);
        let key = DataKey::Circuit(circuit_id.clone(), circuit_type.clone());
        let circuit: CircuitInfo = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::CircuitNotFound));

        let now = env.ledger().timestamp();
        if circuit.expiration != 0 && now > circuit.expiration {
            panic_with_error!(&env, RegistryError::CircuitExpired);
        }

        Self::bump_persistent(&env, &key);
        CircuitVKMap {
            vk: circuit.vk,
            num_public_signals: circuit.num_public_signals,
        }
    }

    pub fn migrate_dao(
        env: Env,
        dao_id: u64,
        from_circuit_id: String,
        to_circuit_id: String,
        circuit_type: CircuitType,
        deadline: u64,
    ) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);

        let from_key = DataKey::Circuit(from_circuit_id.clone(), circuit_type.clone());
        if !env.storage().persistent().has(&from_key) {
            panic_with_error!(&env, RegistryError::CircuitNotFound);
        }

        let to_key = DataKey::Circuit(to_circuit_id.clone(), circuit_type.clone());
        if !env.storage().persistent().has(&to_key) {
            panic_with_error!(&env, RegistryError::CircuitNotFound);
        }

        let migration_key = DataKey::DaoMigration(dao_id);
        if env.storage().persistent().has(&migration_key) {
            let existing: DaoMigration = env.storage().persistent().get(&migration_key).unwrap();
            if existing.active {
                panic_with_error!(&env, RegistryError::MigrationAlreadyExists);
            }
        }

        let now = env.ledger().timestamp();
        if deadline <= now {
            panic_with_error!(&env, RegistryError::MigrationDeadlinePassed);
        }

        let migration = DaoMigration {
            dao_id,
            from_circuit_id: from_circuit_id.clone(),
            to_circuit_id: to_circuit_id.clone(),
            migration_start: now,
            deadline,
            active: true,
        };

        env.storage().persistent().set(&migration_key, &migration);
        Self::bump_persistent(&env, &migration_key);

        DaoMigrationEvent {
            dao_id,
            from_circuit_id,
            to_circuit_id,
            deadline,
        }
        .publish(&env);
    }

    pub fn finalize_migration(env: Env, dao_id: u64, circuit_type: CircuitType) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);

        let migration_key = DataKey::DaoMigration(dao_id);
        let mut migration: DaoMigration = env
            .storage()
            .persistent()
            .get(&migration_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::MigrationNotFound));

        let now = env.ledger().timestamp();
        if now < migration.deadline {
            panic_with_error!(&env, RegistryError::MigrationDeadlinePassed);
        }

        migration.active = false;
        env.storage().persistent().set(&migration_key, &migration);
        Self::bump_persistent(&env, &migration_key);

        let current_key = DataKey::DaoCurrentCircuit(dao_id, circuit_type.clone());
        env.storage()
            .persistent()
            .set(&current_key, &migration.to_circuit_id);
        Self::bump_persistent(&env, &current_key);

        CircuitUpgradedEvent {
            dao_id,
            circuit_type,
            to_circuit_id: migration.to_circuit_id,
        }
        .publish(&env);
    }

    pub fn get_migration(env: Env, dao_id: u64) -> DaoMigration {
        Self::bump_instance(&env);
        let migration_key = DataKey::DaoMigration(dao_id);
        let migration: DaoMigration = env
            .storage()
            .persistent()
            .get(&migration_key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::MigrationNotFound));
        Self::bump_persistent(&env, &migration_key);
        migration
    }

    pub fn is_in_overlap_window(env: Env, dao_id: u64) -> bool {
        Self::bump_instance(&env);
        let migration_key = DataKey::DaoMigration(dao_id);
        if !env.storage().persistent().has(&migration_key) {
            return false;
        }
        let migration: DaoMigration = env.storage().persistent().get(&migration_key).unwrap();
        if !migration.active {
            return false;
        }
        let now = env.ledger().timestamp();
        now >= migration.migration_start && now < migration.deadline
    }

    pub fn get_dao_current_circuit(
        env: Env,
        dao_id: u64,
        circuit_type: CircuitType,
    ) -> String {
        Self::bump_instance(&env);
        let key = DataKey::DaoCurrentCircuit(dao_id, circuit_type);
        env.storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, RegistryError::CircuitNotFound))
    }

    pub fn set_dao_current_circuit(
        env: Env,
        dao_id: u64,
        circuit_type: CircuitType,
        circuit_id: String,
    ) {
        Self::bump_instance(&env);
        Self::assert_governance(&env);

        let circuit_key = DataKey::Circuit(circuit_id.clone(), circuit_type.clone());
        if !env.storage().persistent().has(&circuit_key) {
            panic_with_error!(&env, RegistryError::CircuitNotFound);
        }

        let current_key = DataKey::DaoCurrentCircuit(dao_id, circuit_type);
        env.storage().persistent().set(&current_key, &circuit_id.clone());
        Self::bump_persistent(&env, &current_key);
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
