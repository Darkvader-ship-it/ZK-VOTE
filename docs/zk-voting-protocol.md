# ZK Voting Protocol: Anti-Flash Loan Mechanism

## Overview

This document describes the anti-flash loan protection mechanism implemented in the ZK-VOTE protocol. Flash loan attacks allow an attacker to borrow large amounts of tokens, use them to gain voting power, vote, and return the tokens — all within a single transaction. The ZK-VOTE protocol prevents this through a combination of balance snapshotting, time-weighted average balances, and transfer cooldowns.

## Attack Vector

If election eligibility is gated on token balance (e.g., requiring governance token holdings to vote), without protection:

1. Attacker flash-loans a large amount of governance tokens from a lending protocol
2. Attacker registers for an election (which checks current balance)  
3. Attacker casts a vote with inflated voting power
4. Attacker returns the borrowed tokens
5. All within a single Stellar transaction (multi-operation)

## Protection Mechanisms

### 1. Balance Snapshotting

**Location**: `contracts/voting/src/lib.rs` — `DataKey::BalanceSnapshot`, `create_balance_snapshot()`

When a proposal (election) is created, the current ledger sequence is recorded as the snapshot point in `ProposalInfo.snapshot_ledger`. Token balances are frozen at this point for eligibility determination.

**Key components**:
- `BalanceSnapshotInfo` struct stores `snapshot_ledger` (ledger sequence) and `timestamp`
- `ProposalInfo.snapshot_ledger` field records when the proposal was created
- `create_balance_snapshot()` captures the snapshot
- `get_balance_snapshot()` retrieves the snapshot for verification

### 2. Voter Eligibility at Snapshot Time

**Location**: `contracts/voting/src/lib.rs` — `check_voter_eligibility()`

Voter eligibility checks the voter's balance at the snapshot ledger, not the current ledger. This prevents flash loans because:

- The snapshot was taken at proposal creation (before the attacker could borrow)
- Current balance is irrelevant for eligibility
- Flash loans cannot change historical balance data

**Flow**:
1. `ElectionConfig` stores `min_balance`, `twab_window`, and `snapshot_ledger`
2. `check_voter_eligibility()` verifies `balance_at_snapshot >= cfg.min_balance`
3. Token contracts call this function before allowing votes in token-gated elections

### 3. Election Configuration

**Location**: `contracts/voting/src/lib.rs` — `ElectionConfig`, `DataKey::ElectionConfig`

Each proposal can have an `ElectionConfig` that defines:

| Field | Type | Description |
|-------|------|-------------|
| `snapshot_ledger` | `u32` | Ledger sequence at configuration creation |
| `min_balance` | `i128` | Minimum token balance required to vote |
| `twab_window` | `u64` | Time window for TWAB computation (0 = disable TWAB) |
| `candidate_seed` | `Option<BytesN<32>>` | Finalized election randomness used for candidate ordering |

Configured via `set_election_config()` and retrieved via `get_election_config()`.

### 4. Time-Weighted Average Balance (TWAB)

**Location**: `contracts/voting/src/lib.rs` — `record_balance_checkpoint()`, `get_time_weighted_average_balance()`

TWAB provides Sybil resistance by measuring the average balance over time, not just at a single point. This prevents:

- Flash loans (instant balance changes don't affect the average)
- Balance renting (temporary transfers for voting power)

**How it works**:
- `BalanceCheckpoint` stores (dao_id, address, ledger_seq) -> balance
- Token contracts call `record_balance_checkpoint()` when balances change
- `get_time_weighted_average_balance()` computes the average across a ledger range
- TWAB = Σ(balance_i × duration_i) / total_duration

### 5. Transfer Cooldown

**Location**: 
- `contracts/voting/src/lib.rs` — `set_voter_cooldown()`, `clear_voter_cooldown()`, `is_in_transfer_cooldown()`
- `contracts/membership-sbt/src/lib.rs` — `set_election_cooldown()`, `clear_election_cooldown()`, `is_in_cooldown()`

During an active election, registered voters enter a transfer cooldown that prevents them from:

- Transferring governance tokens out (reducing their stake)
- Leaving the DAO (bypassing membership requirements)
- Having their SBT revoked to avoid vote accountability

**Cooldown enforcement**:
- `set_voter_cooldown()` sets a 7-day cooldown when a voter registers/votes
- `is_in_transfer_cooldown()` is called by token contracts before allowing transfers
- `leave()` in SBT contract checks cooldown before allowing departure
- Cooldown is cleared when the election ends via `clear_voter_cooldown()`

## Election Randomness

Stellar has no native VRF oracle, so elections use a multi-party commit-reveal
protocol to produce a verifiable seed:

1. During the first hour after proposal creation, between two and 32 DAO members
   commit `SHA-256(dao_id || proposal_id || participant_xdr || secret)`.
2. During the next hour, each committer authenticates and reveals their
   32-byte secret. The contract rejects missing, repeated, or mismatched
   reveals.
3. Anyone may finalize after the commit window. The contract hashes the
   election identifiers and every reveal from the fixed on-chain committer
   list, then stores the result in `ElectionConfig.candidate_seed`.
4. Candidate ordering is derived by sorting candidates by
   `SHA-256(candidate_seed || candidate_id)`. Anyone can recompute and verify
   these order keys.

The election admin cannot provide or filter the reveal list at finalization.
Every recorded committer must reveal, so an admin cannot choose a favorable
subset after seeing the values. Domain separation prevents a commitment from
being reused for another election or participant.

This favors integrity over liveness: a committer who withholds a reveal can
prevent finalization. Clients should monitor both windows and treat an
unfinalized seed as a failed randomness round rather than falling back to
admin-selected or transaction PRNG data.

## Integration Guide

### For Token Contracts

Token contracts should integrate with the voting contract to enforce flash loan protection:

```rust
// Before allowing a transfer, check cooldown
fn transfer(..., from: Address, ...) {
    let voting_contract: Address = ...;
    let in_cooldown: bool = env.invoke_contract(
        &voting_contract,
        &Symbol::new(&env, "is_in_transfer_cooldown"),
        vec![&env, dao_id.into_val(&env), from.clone().into_val(&env)],
    );
    if in_cooldown {
        panic!("Transfer blocked: voter is in election cooldown");
    }
    // Proceed with transfer
}

// Record balance checkpoints for TWAB
fn after_balance_change(..., voter: Address, new_balance: i128) {
    let voting_contract: Address = ...;
    env.invoke_contract(
        &voting_contract,
        &Symbol::new(&env, "record_balance_checkpoint"),
        vec![&env, dao_id.into_val(&env), voter.into_val(&env), new_balance.into_val(&env)],
    );
}
```

### For Election Creation

```rust
// Create a token-gated election
fn create_token_gated_proposal(...) {
    let proposal_id = voting_contract.create_proposal(...);
    
    // Create balance snapshot
    voting_contract.create_balance_snapshot(dao_id, proposal_id);
    
    // Configure token-gating
    voting_contract.set_election_config(
        dao_id, 
        proposal_id, 
        min_balance: 1000 * 10^7, // 1000 tokens (7 decimal places)
        twab_window: 86400, // 24-hour TWAB window
    );
}
```

### For Voting

```rust
fn vote_with_token_gate(..., voter, proposal_id) {
    // Check eligibility at snapshot time (not current balance)
    let eligible = voting_contract.check_voter_eligibility(
        dao_id, 
        proposal_id, 
        voter,
        current_balance,
        balance_at_snapshot_ledger,
    );
    if !eligible {
        panic!("Insufficient balance at snapshot time");
    }
    
    // Set cooldown to prevent transfer after voting
    voting_contract.set_voter_cooldown(dao_id, voter);
    
    // Submit vote
    voting_contract.vote(...);
}
```

## Storage Keys

### Voting Contract

| DataKey | Type | Description |
|---------|------|-------------|
| `BalanceSnapshot(dao_id, proposal_id)` | `BalanceSnapshotInfo` | Balance snapshot at proposal creation |
| `ElectionConfig(dao_id, proposal_id)` | `ElectionConfig` | Token-gating configuration |
| `TransferCooldown(dao_id, address)` | `u64` | Cooldown end timestamp |
| `BalanceCheckpoint(dao_id, address, ledger)` | `i128` | Balance at a specific ledger |

### Membership SBT Contract

| DataKey | Type | Description |
|---------|------|-------------|
| `TransferCooldown(dao_id, address)` | `u64` | Cooldown end timestamp for SBT transfers |
| `InActiveElection(dao_id, address)` | `bool` | Whether member is in an active election |

## Error Codes

| Contract | Error | Code | Description |
|----------|-------|------|-------------|
| Voting | `TransferCooldownActive` | 27 | Transfer blocked during active election |
| Voting | `InsufficientSnapshotBalance` | 28 | Balance at snapshot time below minimum |
| SBT | `CooldownActive` | 6 | Cannot leave DAO during active election |

## Security Considerations

1. **Ledger sequence vs timestamp**: Snapshots use ledger sequence numbers which are monotonically increasing and cannot be manipulated. Timestamps are used only for cooldown expiry.

2. **TWAB granularity**: Balance checkpoints should be recorded at every balance change to ensure accurate TWAB computation. Sparse checkpoints reduce accuracy.

3. **Cooldown duration**: The 7-day cooldown is a default that should be adjusted based on the election duration. Short elections may use shorter cooldowns; long elections should extend it.

4. **Gas costs**: TWAB computation iterates over checkpoints within a range. For frequently-traded tokens, this could be expensive. Consider limiting the checkpoint range.
