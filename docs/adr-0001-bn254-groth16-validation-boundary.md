# ADR 0001: BN254 Groth16 Validation Boundary

## Status

Accepted

## Context

ZKVote verifies Groth16 proofs over BN254 through Soroban Protocol 25 host functions. The verifier receives uncompressed G1/G2 encodings for proof elements and verification keys, plus five public signals:

1. Merkle root
2. Nullifier
3. DAO ID
4. Proposal ID
5. Vote choice

The critical boundary is split between contract-level checks and Soroban's hazmat BN254 implementation:

- ZKVote validates public signal field bounds before calling the Groth16 verifier.
- ZKVote enforces a fixed voting VK IC length of 6 for the current circuit.
- The shared Groth16 library checks IC length against public signal count.
- G1/G2 point deserialization and pairing validation are delegated to Soroban BN254 host functions.

## Decision

Keep Soroban's BN254 host functions as the pairing and point-decoding boundary, but keep caller-side field validation mandatory for every public signal before `verify_groth16`.

The project now includes `contracts/zkvote-groth16/tests/bn254_edge_case_corpus.rs`, a production-path corpus that exercises the shared verifier directly with 50+ malformed proofs, VKs, public signal mutations, infinity encodings, out-of-field coordinates, byte flips, G2 non-subgroup torsion fixtures, and IC-vector mutations.

The default integration test is gated with `not(feature = "testutils")` and includes a known-bad-proof sanity assertion so the corpus fails if it is accidentally routed through the stubbed verifier. A separate `testutils` test documents the intentionally stubbed path.

## Required Caller Checks

All callers of `zkvote_groth16::verify_groth16` must:

- Reject public signals greater than or equal to the BN254 scalar field modulus.
- Reject zero nullifiers where nullifiers are used for replay protection.
- Bind all domain-separation values into the public signal list in the same order as the circuit.
- Enforce the exact IC length expected by the deployed circuit, not only the broad DoS cap.
- Pin verification keys per proposal or per action so later VK changes cannot reinterpret old proofs.

## Recommended Hardening

- Add explicit G1 affine validation helpers if future Soroban host behavior changes or if proof/VK bytes are used before host deserialization.
- Add a dedicated G2 subgroup-validation route if Soroban exposes one separately from pairing.
- Keep the edge-case corpus in CI as a regression test for host-function behavior.
- Re-run the corpus whenever `soroban-sdk`, the Stellar protocol version, or circuit public-signal ordering changes.
- Treat accepted out-of-field signal aliases in the core verifier as caller-guarded behavior, not as proof validity.

## Torsion Fixture Note

BN254 G1 has cofactor 1, so there are no non-identity G1 torsion points outside the scalar-order subgroup. The corpus therefore focuses torsion coverage on G2, where it deterministically constructs a full-twist point and multiplies it by the BN254 scalar modulus to obtain a non-subgroup h-torsion fixture. Soroban is expected to reject that fixture during G2 deserialization or pairing setup.

The BN254 G2 cofactor is not divisible by 2, 3, 5, or 7, so the corpus does not claim small-order 2/3/5/7 fixtures for this curve. Those cases would be invalid test vectors rather than real BN254 subgroup-boundary coverage.

## Audit-Library Migration

Do not migrate away from Soroban host functions at this time. The host implementation is the only production-compatible route for on-chain BN254 pairing in this codebase. A formal external audit should focus on:

- Soroban host BN254 point parsing and subgroup checks.
- ZKVote's caller-side public signal validation.
- Circuit/VK/public-signal ordering consistency.
- VK version pinning and hash immutability.

## Consequences

This decision keeps verification efficient and compatible with Soroban while making the caller boundary explicit. The tradeoff is that the shared verifier remains low-level: it assumes public signals have already been validated by the caller.
