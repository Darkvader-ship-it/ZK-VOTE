# BN254 Groth16 Edge-Case Findings

## Scope

Issue: `ZK-VOTE/ZK-VOTE#42`

The proof-of-concept harness is `contracts/zkvote-groth16/tests/bn254_edge_case_corpus.rs`.

Run it with:

```bash
cargo test -p zkvote-groth16 --test bn254_edge_case_corpus -- --nocapture
```

Run the explicit testutils stub documentation path with:

```bash
cargo test -p zkvote-groth16 --features testutils --test bn254_edge_case_corpus testutils_feature_uses_stubbed_verifier -- --nocapture
```

## Corpus Coverage

The corpus includes one valid control plus more than 50 edge cases:

- Proof G1 infinity encodings for `a` and `c`
- Proof G2 infinity encoding for `b`
- Proof G2 non-subgroup h-torsion for `b`
- All-proof infinity
- Coordinates equal to the BN254 base-field modulus
- All-`0xff` point encodings
- Single-byte mutations across G1 and G2 coordinate boundaries
- Malleated `a` and `c` values using `y -> p - y`
- Swapped `a` and `c`
- Wrong root, nullifier, DAO ID, proposal ID, and vote choice
- Root/nullifier at scalar-field modulus as caller-guarded observations
- VK alpha/beta/gamma/delta infinity encodings
- VK beta/gamma/delta non-subgroup h-torsion encodings
- VK G1/G2 coordinate-boundary mutations
- Duplicate IC entries
- Short and long IC vectors

## Risk-Scored Findings

### High: Public signal field validation is caller-owned

The shared Groth16 verifier accepts `U256` public signals and converts them into BN254 scalars in the production path. Any caller that skips `assert_in_field` can risk modular aliasing, where an out-of-field value is interpreted as its reduced scalar during proof verification.

Reproduction:

1. Remove or bypass `Voting::assert_in_field` before `Voting::verify_groth16`.
2. Submit a public root or nullifier at or above the BN254 scalar field modulus.
3. Compare verifier behavior with the same value reduced into the scalar field.

Current mitigation:

- `Voting::vote` validates `root` and `nullifier` before proof verification.
- `Comments` paths should continue using the same caller-side field-bound discipline.

Recommended follow-up:

- Keep field validation at every verifier call site.
- Add a wrapper API that validates signals before calling the low-level verifier.

### Medium: G2 subgroup validation is delegated to Soroban host parsing

ZKVote does not implement explicit G2 subgroup checks. This is acceptable only while Soroban's BN254 host implementation rejects invalid G2 encodings during deserialization or pairing setup.

Reproduction:

1. Run the edge-case corpus.
2. Review `proof_b_*`, `vk_*_coordinates_at_fp_modulus`, and `*_non_subgroup_g2_torsion` outcomes.
3. Any `Accepted` outcome outside caller-guarded public-signal observations is a bypass.

Current mitigation:

- The pairing host function is the validation boundary.
- Soroban's host parser performs a G2 subgroup check before pairing.
- The corpus now provides deterministic h-torsion regression coverage for that boundary.

Recommended follow-up:

- Re-run after every Soroban SDK/protocol upgrade.
- Add explicit G2 subgroup checks if Soroban exposes a direct API.

### Low: VK IC cap is not a brute-force window for the current circuit

The broad cap is 21, but the voting contract enforces the exact current circuit IC length of 6. The shared verifier also rejects any mismatch between IC length and public signal count.

Reproduction:

1. Run the `vk_ic_too_short` and `vk_ic_too_long` corpus cases.
2. Attempt to set a voting VK with any IC length other than 6.

Current mitigation:

- `Voting::validate_vk` requires `VOTE_CIRCUIT_IC_LEN`.
- `zkvote_groth16::verify_groth16` requires `pub_signals.len() + 1 == vk.ic.len()`.

## Summary

No known proof or VK point mutation should be accepted by the production-path verifier. The main security boundary to preserve is caller-side public-signal validation before scalar conversion.
