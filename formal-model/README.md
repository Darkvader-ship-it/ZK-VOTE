# ZK-VOTE Formal Model (TLA+)

## Overview

This directory contains a TLA+ formal specification of the ZK-VOTE system's
combined state machine across 5 Soroban contracts:

| Contract | File | Lines | Role |
|----------|------|-------|------|
| DaoRegistry | `contracts/dao-registry/src/lib.rs` | 551 | DAO factory + admin management |
| MembershipSBT | `contracts/membership-sbt/src/lib.rs` | 460 | Soulbound token membership |
| MembershipTree | `contracts/membership-tree/src/lib.rs` | 1300 | On-chain Poseidon Merkle tree |
| Voting | `contracts/voting/src/lib.rs` | 992 | Anonymous voting with ZK proofs |
| zkvote-groth16 | `contracts/zkvote-groth16/src/lib.rs` | 252 | Groth16 verification library |

## Files

| File | Purpose |
|------|---------|
| `ZKVote.tla` | TLA+ specification of combined state machine |
| `ZKVote.cfg` | TLC model checker configuration |
| `CI-RECOMMENDATION.md` | CI integration guide |

## Invariants Modeled

| # | Invariant | Description |
|---|-----------|-------------|
| I1 | NoDoubleVoting | Each (dao_id, proposal_id, nullifier) used at most once |
| I2 | RootGroundedVoting | Every accepted proof's root is a valid Merkle root |
| I3 | AdminContinuity | Exactly one admin per DAO at all times |
| I4 | ProposalFSM | Active -> Closed -> Archived, no backward edges |
| I5 | NullifierGlobalUniqueness | No nullifier reused across DAOs/proposals |
| I6 | FIFOSafety | Fixed-mode proposals always reference an existing root |
| I7 | MinRootCorrectness | min_valid_root_idx never exceeds nextRootIndex |
| I8 | AuthDelegationSoundness | _from_registry requires registry auth |

## How to Run

### Prerequisites
- Java 11+ (for TLC)
- Download TLA+ tools: https://github.com/tlaplus/tlaplus/releases

### Run TLC model checker
```bash
cd formal-model
java -cp /path/to/tla2tools.jar tlc2.TLC ZKVote.tla -config ZKVote.cfg -depth 20
```

### Run Apalache (symbolic)
```bash
apalache typecheck ZKVote.tla
apalache mc --invariant=Invariants --length=20 ZKVote.tla
```

## Known Limitations of This Model

1. **Abstract Merkle tree**: The model uses symbolic root values rather than
   computing actual Poseidon hashes. A bug in `hash_pair` would not be caught.

2. **Abstract BN254 pairing**: The `proofOk` parameter is a boolean — the model
   does not encode the pairing equation. A subtle malleability in the Groth16
   verification would not be detected.

3. **No budget/TTL modeling**: Soroban's budget limits and TTL expiration are
   not modeled. A real attack could exploit budget exhaustion.

4. **No WASM semantics**: The model abstracts Soroban's sandbox. A bug in
   the host function implementation would not be caught.

5. **Bounded model checking**: TLC explores all states up to a depth limit.
   Unbounded correctness requires Apalache or a proof assistant.

## Next Steps

1. Install TLA+ Toolbox: https://github.com/tlaplus/tlaplus/releases
2. Run `java -cp tla2tools.jar tlc2.TLC ZKVote.tla -config ZKVote.cfg -depth 20`
3. Add the GitHub Action to `.github/workflows/formal-model.yml`
4. For deeper analysis, install Apalache: https://apalache.informal.systems/
