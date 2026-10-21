# Curve Migration Implementation Roadmap

## Overview

Migrate ZK-VOTE's cryptographic backend from BN254 (100-bit security) to BLS12-381 (128-bit security) with zero-downtime proof format versioning and a coordinated circuit freeze window.

## Architecture: Dual-Curve Verification

```
                    ┌──────────────────┐
                    │   Verification   │
                    │   Dispatcher     │
                    ├──────────────────┤
                    │ CurveId::BN254   │──→ zkvote-groth16 (BN254 impl)
                    │ CurveId::BLS381  │──→ zkvote-groth16 (BLS12-381 impl)
                    └──────────────────┘

VK storage per DAO:
  vk_version 1 → CurveId::BN254   (active since genesis)
  vk_version 2 → CurveId::BLS381  (new proposals)
  vk_version 3+ → CurveId::BLS381 (future upgrades)
```

## Phase 1: Contract Refactoring (Q4 2026, ~4 weeks)

### Week 1-2: Trait Abstraction

| Task | Files | Effort |
|------|-------|--------|
| Define `Groth16Curve` trait | `poc-bls12-381/src/lib.rs` | Done |
| Refactor `zkvote-groth16` to use trait | `contracts/zkvote-groth16/src/lib.rs` | 2 days |
| Implement `Bn254Curve` | `contracts/zkvote-groth16/src/bn254.rs` | 1 day |
| Implement `Bls12381Curve` | `contracts/zkvote-groth16/src/bls12_381.rs` | 1 day |
| Add `CurveId` enum + dispatch | `contracts/zkvote-groth16/src/lib.rs` | 1 day |
| Update `VerificationKey` sizes | `contracts/zkvote-groth16/src/lib.rs` | 1 day |

### Week 3-4: Contract Updates

| Task | Files | Effort |
|------|-------|--------|
| Refactor `voting` contract | `contracts/voting/src/lib.rs` | 2 days |
| Refactor `comments` contract | `contracts/comments/src/lib.rs` | 1 day |
| Refactor `dao-registry` VK struct | `contracts/dao-registry/src/lib.rs` | 1 day |
| Refactor `membership-tree` Poseidon field | `contracts/membership-tree/src/lib.rs` | 1 day |
| Replace `poseidon_params.rs` with BLS12-381 params | `contracts/membership-tree/src/poseidon_params.rs` | 2 days |
| Add per-VK-version `CurveId` storage | `contracts/voting/src/lib.rs` | 1 day |

**Deliverable**: All contracts compile with both BN254 and BLS12-381 support. VK versioning tracks which curve a VK uses. Existing BN254 tests pass unchanged.

## Phase 2: Circuit Regeneration (Q1 2027, ~3 weeks)

### Circuit Freeze Window

```
┌─────────────────────────────────────────────────────────┐
│                 CIRCUIT FREEZE WINDOW                    │
│                                                          │
│  Week 1: Last BN254 trusted setup ceremony               │
│  Week 2: No new BN254 circuit deployments                │
│  Week 3: BLS12-381 circuits + KAT generation             │
│                                                          │
│  All BN254 proofs generated AFTER freeze date are        │
│  rejected on-chain. Proofs generated BEFORE freeze       │
│  remain valid until their proposal closes.               │
└─────────────────────────────────────────────────────────┘
```

### Tasks

| Task | Files | Effort |
|------|-------|--------|
| Replace `circomlib` Poseidon with `poseidon-bls12381-circom` | `circuits/package.json` | 1 day |
| Rewrite `vote.circom` for BLS12-381 field | `circuits/vote.circom` | 2 days |
| Rewrite `comment.circom` for BLS12-381 field | `circuits/comment.circom` | 1 day |
| Rewrite `merkle_tree.circom` for BLS12-381 field | `circuits/merkle_tree.circom` | 1 day |
| Run trusted setup (Powers of Tau + phase2) | CI/scripts | 2 days |
| Generate BLS12-381 verification keys | CI/scripts | 1 day |
| Generate KAT vectors (Poseidon + Merkle + proof) | `circuits/utils/` | 2 days |
| Update `poseidon_params.rs` (BLS12-381 parameters) | `contracts/membership-tree/src/poseidon_params.rs` | 1 day |

### BLS12-381 Poseidon Parameters

The Poseidon hash is field-specific. BLS12-381 requires different parameters:

| Parameter | BN254 | BLS12-381 |
|-----------|-------|-----------|
| Scalar field | r ≈ 2^254 | r ≈ 2^255 |
| SBOX | x^5 | x^5 |
| t (rate+capacity) | 3 | 3 |
| Full rounds | 8 | 8 |
| Partial rounds | 57 | 57 |
| MDS matrix | 3×3 (BN254-specific) | 3×3 (BLS12-381-specific) |

Poseidon constants for BLS12-381 are generated using the `poseidon` Rust crate or the `poseidon-bls12381-circom` npm package.

## Phase 3: On-Chain Cutover (Q2 2027, ~2 weeks)

### Zero-Downtime Deployment

```
Step 1: Deploy new contract versions to Soroban (same addresses via upgrade)
Step 2: Existing DAOs keep their BN254 VK (version 1)
Step 3: New DAOs use BLS12-381 by default
Step 4: Existing DAOs call set_vk() with new BLS12-381 VK at their convenience
```

### Proof Format Versioning

```rust
enum ProofFormat {
    V1Bn254,       // Original BN254 Groth16 proof
    V2Bls12381,    // BLS12-381 Groth16 proof
}

// Stored per-proposal:
struct ProposalInfo {
    // ... existing fields ...
    proof_format: ProofFormat,  // Determined at proposal creation
}
```

**Rules**:
- Proposals created with a BN254 VK only accept BN254 proofs
- Proposals created with a BLS12-381 VK only accept BLS12-381 proofs
- VK hash includes the curve identifier (prevents cross-curve replay)
- Old BN254 proposals remain votable until they close/archive

### Frontend/Backend Updates

| Layer | Changes |
|-------|---------|
| `backend/src/config.ts` | Add BLS12-381 field constants |
| `backend/src/validation/schemas.ts` | Add BLS12-381 field validator |
| `backend/src/types/index.ts` | Update proof types (new G1/G2 sizes) |
| `frontend/src/lib/zkproof.ts` | Detect curve from VK; use correct prover |
| `circuits/utils/proof_converter.ts` | Handle both proof formats |

### Off-Chain Proving Infrastructure

```
User votes →
  Is proposal VK BN254 or BLS12-381?
  ├── BN254 → generate proof with existing circuits/snarkjs
  └── BLS12-381 → generate proof with new circuits/snarkjs (slower)
```

## Phase 4: BN254 Deprecation (Q3 2027, ~2 weeks)

### Timeline

| Milestone | Date | Action |
|-----------|------|--------|
| BN254 freeze | Q1 2027 start | No new BN254 circuit deployments |
| BN254 deprecation notice | Q2 2027 start | UI shows "upgrade VK" warning for old DAOs |
| BN254 VK removal | Q3 2027 start | `set_vk` overwrites all BN254 VKs with BLS12-381 |
| BN254 contract code removal | Q3 2027 end | Delete `bn254.rs`; keep `Bls12381Curve` only |

### Grace Period

- DAOs that do NOT upgrade their VK by Q3 2027 will have their BN254 VK automatically superseded
- All proposals created before the deprecation date remain votable (proof format pinned at creation)
- After deprecation, `set_vk` with an explicit `CurveId::BN254` is rejected

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| BN254 broken to 80 bits before migration | Low | Critical | Accelerate timeline; emergency hot-swap via `Groth16Curve` trait |
| Soroban removes BLS12-381 host functions | Very Low | High | WASM software pairing (blst port) |
| Circom BLS12-381 proving too slow for users | Medium | Medium | Client-side proving in WASM; backend relay fallback |
| Poseidon parameters differ between circomlib and soroban SDK | Medium | High | Validate KATs; use same parameter generation methodology |
| Existing BN254 proof data unverifiable after deprecation | Low | Medium | Store proof format in proposal; old proofs remain valid |

## Effort Summary

| Phase | Duration | Contract Changes | Circuit Changes | TS/JS Changes |
|-------|----------|-----------------|-----------------|---------------|
| Phase 1: Refactoring | 4 weeks | 6 files, ~300 lines | 0 | 0 |
| Phase 2: Circuits | 3 weeks | 1 file, ~360 lines (poseidon params) | 3 files, ~210 lines | 3 files, ~50 lines |
| Phase 3: Cutover | 2 weeks | 0 (already deployed) | 0 | 5 files, ~100 lines |
| Phase 4: Deprecation | 2 weeks | 2 files, ~100 lines | 0 | 2 files, ~30 lines |
| **Total** | **11 weeks** | **~760 lines** | **~210 lines** | **~180 lines** |

## Verification Checklist

- [ ] All 6 contracts compile for both BN254 and BLS12-381
- [ ] Poseidon KATs match between circomlib (BN254), poseidon-bls12381-circom, and soroban SDK
- [ ] Merkle root computed on-chain matches circuit-computed root for BLS12-381
- [ ] Real Groth16 proof verifies with `env.crypto().bls12_381().pairing_check()`
- [ ] VK versioning correctly routes to curve implementation
- [ ] Old BN254 proposals remain votable after BLS12-381 cutover
- [ ] Double-vote prevention works for both curves
- [ ] Performance: BLS12-381 verification stays within Soroban instruction budget
