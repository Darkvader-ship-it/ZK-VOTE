//! ZKVote Rust BN254 Groth16 prover + circomlib-compatible Poseidon.
//!
//! This crate provides a pure-Rust, WASM-buildable implementation of the
//! cryptographic primitives the ZKVote frontend needs to generate Groth16
//! proofs client-side, replacing the `snarkjs` default path while keeping
//! byte-for-byte parity with the on-chain verifier (which uses the same BN254
//! host functions / verification key).

pub mod field;
pub mod poseidon;
pub mod binfile;
pub mod zkey;
pub mod wtns;
pub mod fft;
pub mod groth16;
pub mod r1cs;

#[cfg(feature = "wasm")]
pub mod wasm;
