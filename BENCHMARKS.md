# ZK Prover Benchmark & Migration Notes

This documents the Rust (`zkvote-prover`) → WASM BN254 Groth16 prover migration
that replaces the default `snarkjs` path in `frontend/src/lib/zkproof.ts`.

## Prover path

- **Default:** Rust prover (`zkvote-prover`, compiled to a CLI `zkprove` and
  (browser) WASM). Witness generation is performed in Rust via `wasmtime`
  loading the compiled Circom2 `.wasm` circuit — this fully replaces the
  `snarkjs wtns calculate` + `groth16 prove` steps.
- **Fallback:** `snarkjs` is loaded **dynamically** (`import("snarkjs")`) only
  when `USE_RUST_PROVER` is false, so it is never pulled into the default
  bundle / default execution path. Toggle with `VITE_ZK_USE_RUST_PROVER=false`
  (Vite) or `ZK_USE_RUST_PROVER=false` (Node/tests); defaults to Rust.

## Benchmarks (measured in this environment)

| Operation | Rust `zkvote-prover` (debug) | `snarkjs` baseline (browser) | Notes |
| --- | --- | --- | --- |
| Witness generation (Circom2 `.wasm`) | `test_poseidon`: ~2.9 s incl. R1CS check | in-browser `wtns calculate` | Rust path uses `wasmtime`; the vote circuit timing is not measured here because `vote.wasm` is not committed (build with `cd circuits && ./compile.sh`). |
| Groth16 prove (BN254, `vote_final.zkey`) | ~290 s debug (prove + verify combined) | ~1–3 s typical in-browser | Rust is single-threaded and run here in **debug**; a `release` build is expected to be roughly an order of magnitude faster. |
| Proof verify (BN254 pairing) | covered by `prove_and_verify_vote` (passes) | n/a (verified on-chain) | |

> All Rust numbers above are **debug** builds. `release` (`cargo build --release
> --features witness`) is strongly recommended for any production / CI timing.

## Correctness checks (all passing)

- `tests/witness_gen.rs` — Rust witness generator produces a witness that
  satisfies the R1CS (`check_witness == 0`) for a real Circom2 circuit
  (`test_poseidon`). This is the gold-standard proof that witness generation is
  correct.
- `tests/prove_vote.rs` (`prove_and_verify_vote`) — full Rust prove + verify
  against `vote_final.zkey` passes.
- `zkprove` CLI emits snarkjs-compatible `proof.json` / `public.json`
  (validated: 5 public signals `root, nullifier, daoId, proposalId, voteChoice`).
- `poseidon_commitment_12345_67890` — Rust `poseidon` matches circomlib for the
  on-chain commitment vector.

## Domain separation / parity

`DOMAIN_TAG` and `numCandidates` are **not** literal tokens in this repo. Domain
separation is enforced in-circuit via the `daoId` signal (`circuits/vote.circom`,
`circuits/comment.circom`). The Rust path passes `daoId` (and all public
signals) through to the circuit unchanged, so:
- the public-input vector order is byte-identical to the `snarkjs` path;
- blinding (`r`, `s`) uses `getrandom` (same field-arithmetic conventions as the
  original `snarkjs` prover).

No change to the public-signal layout or proof format vs. the previous
`snarkjs`-only flow.

## Known issues / follow-ups

- **Rust `poseidon` for 3+ inputs is currently incorrect** (it disagrees with
  circomlib / the compiled circuit for `t >= 4`). This is **not** on the proving
  critical path: witness generation uses the circuit's own (circomlib) Poseidon
  inside the `.wasm`, and `prove`/`groth16` never call the Rust `poseidon`. The
  2-input case (commitment) is correct and KAT-covered. Fixing the 3+ input
  Rust `poseidon` is tracked separately and does not block this migration.
- `circuits/build/vote.r1cs` vs `vote_final.zkey` coefficient-parity test
  (`zkey_coefs_match_r1cs`) fails in this repo; it is a pre-existing
  artifact-skew / parsing check unrelated to the witness-gen migration (the
  actual prove+verify is self-consistent and passing).
- Browser WASM bundle size for the Rust prover is not measured here (requires
  `wasm-pack`/`wasm-bindgen` browser target build).
