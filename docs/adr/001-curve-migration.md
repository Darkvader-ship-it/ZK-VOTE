# ADR-001: BN254 to BLS12-381 Curve Migration

## Status

Accepted (Jul 2026). Full dual-curve support implemented across all 5 contracts. BLS12-381 PoC verified. CAP-0075 Poseidon resolution unblocks on-chain BLS12-381 Merkle trees. Pending proving-time regression testing with actual circuits before BLS12-381-only cutover.

## Context

ZK-VOTE uses BN254 (alt_bn128) for Groth16 proof verification and Poseidon hashing. BN254 provides ~100-bit security, below the 128-bit NIST minimum. The project requires a curve-agnostic architecture that supports hot-swap between BN254 (legacy) and BLS12-381 (production) without service interruption.

## Decision Drivers

1. **Security**: BN254's ~100-bit margin is below NIST 128-bit minimum; any TNFS improvement could drop it to 80-90 bits
2. **Soroban support**: SDK 25.3+ supports BLS12-381 pairing via `env.crypto().bls12_381()` (CAP-59, Protocol 22) AND field-generic Poseidon via `env.crypto().poseidon_permutation(field=0, ...)` (CAP-75, Protocol 25)
3. **Ecosystem alignment**: Ethereum EIP-2537 (Pectra), Zcash, Solana, and IETF CFRG all recommend BLS12-381 as the 128-bit security baseline
4. **Proving cost**: ~1.5x proving time regression (not 3-5x as initially estimated — empirical Gnark benchmarks show 1.53-1.57x for identical constraint counts)
5. **Scope**: ~1,100 lines across 28 files, all implemented

## BN254 Cryptanalysis Survey (2026)

### Current Security Estimate

| Source | Year | Estimate | Method |
|--------|------|----------|--------|
| Original BN254 spec | 2010 | 128 bits | Pre-exTNFS |
| Kim-Barbulescu | 2016 | ~100 bits | exTNFS |
| Barbulescu-Duquesne | 2018 | 100-110 bits | Refined exTNFS constants |
| gnark-crypto (consensys) | 2024 | 103 bits | eprint 2019/885 |
| Zellic audits | 2025 | ~102 bits | STNFS estimate |
| IETF CFRG draft | 2026 | "no more than 100 bits" | Consensus |

**Bottom line: BN254 provides ~100-103 bits as of mid-2026.** No further cryptanalytic reduction has been published since the 2019-2020 estimates stabilized. The curve is not broken — the original 128-bit claim was simply optimistic given later algorithmic improvements.

### Threat Scenarios

| Scenario | Probability | Impact | Mitigation |
|----------|------------|--------|------------|
| No further attack improvement | High (>80%) | ~100-bit continues to suffice for most threat models | Annual cryptanalysis review |
| TNFS constant-factor improvement (e.g., 100→85 bits) | Medium (15%) | Pairing inversion becomes feasible for well-funded adversaries | Immediate BLS12-381 cutover (ready, tested) |
| Major algorithmic breakthrough (e.g., 100→60 bits) | Low (<5%) | All BN254 proof privacy collapses | BLS12-381 + PQ contingency |
| Quantum computer breaks BN254 DLP | Very low (<1%) within 10yr | Pairing-based crypto obsolete | STARK / lattice-based migration |

### Urgency

**Not urgent but prudent.** The ~100-bit margin is safe for voting systems where the value at stake is governance power (votes) rather than direct financial assets. The primary motivation for migration is long-term standardization alignment (Ethereum, Solana, Zcash all adopting BLS12-381) rather than imminent cryptanalytic emergency. The dual-curve architecture allows a gradual, zero-downtime transition.

## Key Finding: CAP-0075 Poseidon Resolution

`env.crypto().poseidon_permutation()` was originally BN254-only. The current CAP-0075 spec (Final, Protocol 25 "X-Ray") makes both Poseidon host functions field-generic:

- **field=0**: BLS12-381 Fr
- **field=1**: BN254 Fr

This applies to both `poseidon_permutation` and `poseidon2_permutation`. Shipped on mainnet January 22, 2026. This unblocked Phase B (membership tree).

See [CAP-0075](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0075.md).

## Proving Time Regression

Empirical benchmarks (Gnark, M1 Pro, 2026):

| Circuit | Constraints | BN254 Groth16 | BLS12-381 Groth16 | Ratio |
|---------|------------|----------------|-------------------|-------|
| Integer ops | 200,335 | 8.69s | 13.61s | 1.57x |
| ECDSA | 293,814 | 42.68s | 66.66s | 1.56x |
| MiMC 100 hashes | 33,001 | 2.45s | 3.74s | 1.53x |

**Key insight**: Constraint count is identical across curves for the same R1CS circuit. The 1.5x slowdown is entirely due to larger field arithmetic (381-bit vs 254-bit) in FFTs and MSMs. The earlier 3-5x estimate was conservative; real-world data shows ~1.5x.

**Verification cost**: On Soroban, both BN254 and BLS12-381 are native host functions with comparable gas. The verification gas cost is NOT 2x as initially estimated — both pairings execute at native speed in the Soroban host.

## Decision Tree

```
BN254 security adequate?
├── YES (~100 bits sufficient for threat model)
│   ├── Keep BN254 as default, BLS12-381 as opt-in
│   └── Monitor cryptanalysis annually
│
└── NO (migration warranted for 128-bit standard)
    ├── Soroban BLS12-381 host functions available?
    │   ├── YES → env.crypto().bls12_381() (CAP-59, Protocol 22+)
    │   └── NO  → Fallback: blst WASM port (not needed)
    │
    ├── Poseidon over BLS12-381 Fr available?
    │   ├── YES → CAP-75 (Protocol 25+), field=0
    │   └── NO  → Software Poseidon in WASM (not needed)
    │
    ├── Proving time regression acceptable?
    │   ├── YES (1.5x) → Full BN254 → BLS12-381 migration
    │   └── NO → Stay hybrid: BN254 for proof gen, BLS12-381 on-chain
    │
    └── Contingency: cryptanalytic breakthrough?
        ├── Dual-curve ready → flip DAOs to BLS12-381 per-proposal
        └── Quantum threat → STARK / lattice migration
```

## Completed Work

### Phase A: Dual-Curve zkvote-groth16 (zkvote-groth16 crate) ✓
- `Groth16Curve` trait with `Bn254Curve` / `Bls12381Curve` impls
- `Bn254Curve` delegates to `env.crypto().bn254()` host functions
- `Bls12381Curve` delegates to `env.crypto().bls12_381()` host functions
- `CurveId` enum for runtime curve selection
- BLS12-381 sized `VerificationKeyBls381` (96/192-byte fields) and `ProofBls381`
- `verify_groth16()`, `assert_in_field()`, `is_in_field()`, `validate_nullifier()` for both curves
- 16 tests (8 BN254 + 8 BLS12-381)

### Phase B: Field-Agnostic Membership Tree ✓
- `hash_pair(field: &Symbol)` — dispatch to curve-specific Poseidon parameters
- Separate MDS/RC caches for BN254 and BLS12-381 (`poseidon_params_bls12_381` module)
- `DataKey::PoseidonField(u64)` per DAO for field selection
- BLS12-381 zeros cache (`ensure_zeros_cache_bls`, `zero_at_level_bls`)
- `init_tree(field: &Symbol)` — `dao-registry` passes `field` through
- 75+ `init_tree` call sites updated in integration tests

### Phase C: Proof Format Versioning ✓
- `DataKey::CurveId(u64)`, `ProposalCurve(u64,u64)`, `VotingKeyBls381(u64)`, `VkByVersionBls381(u64,u32)`, `VkVersionBls381(u64)`
- `set_vk_bls381()`, `set_vk_from_registry_bls381()` — BLS12-381 VK storage with separate version counter
- `vote_bls381()` — full BLS12-381 Groth16 verification with field checks, VK hash validation, per-proposal curve pinning
- `add_anonymous_comment_bls381()`, `edit_anonymous_comment_bls381()` — comments contract BLS12-381 support
- `get_vk_bls381()`, `vk_for_version_bls381()` — public query functions
- Proposal creation stores `ProposalCurve(dao_id, proposal_id)` for zero-downtime proof format versioning
- 218 tests passing across workspace

### BLS12-381 Verification PoC
- Software BLS12-381 pairing NOT needed — `env.crypto().bls12_381()` is native
- `Bls12381Curve` impl using host functions
- 8 BLS12-381 verification tests passing

## Phased Migration Roadmap

### Phase 0: Dual-Curve Readiness (done)
- All 5 contracts support both BN254 and BLS12-381
- New DAOs can be created with BLS12-381 via `create_and_init_dao_bls381()`
- Existing DAOs remain on BN254 with zero disruption

### Phase 1: BLS12-381 Circuit (next)
- Generate BLS12-381 Poseidon circuit constants (matching the on-chain parameters)
- Compile vote/comment/Merkle tree circuits targeting BLS12-381
- Run trusted setup ceremony for BLS12-381 proving key
- Generate verification key for contract deployment

### Phase 2: BLS12-381 Proving
- Benchmark actual proving time with BLS12-381 circuits (~1.5x expected)
- Optimize witness generation for mobile clients if needed
- Verify proof-output compatibility with on-chain `verify_groth16_bls381()`

### Phase 3: Cutover ("circuit freeze window")
- Freeze BN254 circuit deployment (no new BN254 circuits after date TBD)
- Deploy BLS12-381 verifying key to contracts
- New DAOs default to BLS12-381; existing DAOs migrate at their pace
- Phase out BN254 after 6-month coexistence window

Zero-downtime guarantee: per-proposal `CurveId` means active proposals are never invalidated — they finish voting with whatever curve they were created on.

## Fallback: Soroban Never Supports BLS12-381 Poseidon

**NOT NEEDED — CAP-0075 is Final and shipping since Protocol 25 (Jan 2026).**

Retained for reference in case CAP-0075 support is removed from future protocol versions:

| Option | Circuit Cost | On-Chain Cost | Proving Time | Feasibility |
|--------|-------------|---------------|-------------|-------------|
| WASM Poseidon (BLS12-381) using `fr_add`/`fr_mul` | None (keep Poseidon) | ~845 host calls/hash | Same | Expensive but viable |
| SHA256 Merkle tree (field-independent) | ~25K constraints/hash | Native `sha256` | ~30-60s | High — requires circuit rewrite |
| BN254 Poseidon + BLS12-381 Groth16 | None | Unchanged | N/A | Impossible — hash outputs differ |

## Post-Quantum Contingency

BLS12-381 is NOT post-quantum secure. For PQ readiness:
- Goldilocks (Ed448) is not pairing-friendly — not a drop-in replacement
- BLS48 offers 256-bit security but ~10x slower pairings
- **Long-term**: Monitor hash-based signatures (SPHINCS+), lattice-based ZK (Falcon), or STARKs (which need no pairing-friendly curve)
- ZK-VOTE architecture with `Groth16Curve` trait makes future curve additions follow the same pattern as BLS12-381

## Files Changed

### Phase A (zkvote-groth16) — Mar 2026
| File | Change |
|------|--------|
| `contracts/zkvote-groth16/src/lib.rs` | `Groth16Curve` trait, `Bn254Curve`, `Bls12381Curve`, `CurveId`, `VerificationKeyBls381`, `ProofBls381`, BLS12-381 verification + field checks |

### Phase B (membership-tree) — Jun 2026
| File | Change |
|------|--------|
| `contracts/membership-tree/src/lib.rs` | `hash_pair(field)`, `dao_field`, `init_tree(field)`, BLS12-381 zeros cache |
| `contracts/membership-tree/src/poseidon_params_bls12_381.rs` | New: BLS12-381 t=3 Poseidon constants |
| `contracts/dao-registry/src/lib.rs` | `create_and_init_dao` accepts `field: Symbol` |

### Phase C (voting + comments) — Jul 2026
| File | Change |
|------|--------|
| `contracts/voting/src/lib.rs` | `DataKey` variants for BLS12-381, `set_vk_bls381`, `vote_bls381`, `get_vk_bls381`, `hash_vk_bls381`, `verify_groth16_bls381`, curve-aware proposal creation |
| `contracts/comments/src/lib.rs` | `add_anonymous_comment_bls381`, `edit_anonymous_comment_bls381`, `get_vk_from_voting_bls381` |
| `docs/adr/001-curve-migration.md` | Updated with CAP-0075 resolution, cryptanalysis survey, proving benchmarks |

## References

- CAP-59 (BLS12-381 host functions): https://github.com/stellar/stellar-protocol/blob/master/core/cap-0059.md
- CAP-74 (BN254 host functions): https://github.com/stellar/stellar-protocol/blob/master/core/cap-0074.md
- CAP-75 (Poseidon host functions): https://github.com/stellar/stellar-protocol/blob/master/core/cap-0075.md
- IETF CFRG Pairing-Friendly Curves: https://datatracker.ietf.org/doc/draft-irtf-cfrg-pairing-friendly-curves/
- Kim-Barbulescu exTNFS (CRYPTO 2016): https://eprint.iacr.org/2015/1027
- Barbulescu-Duquesne (2019) security estimates: https://eprint.iacr.org/2019/885
- gnark BN254 security note: https://pkg.go.dev/github.com/consensys/gnark-crypto/ecc/bn254
- EIP-2537 (BLS12-381 precompiles): https://eips.ethereum.org/EIPS/eip-2537
- Soroban SDK v25.3.1 bls12_381 module: `src/crypto/bls12_381.rs`
- Gnark benchmark data: https://arxiv.org/pdf/2507.05294 (Tables 1-3)
