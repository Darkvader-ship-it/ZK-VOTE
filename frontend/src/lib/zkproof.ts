// ZK Proof generation utilities.
//
// By default proofs are generated with the Rust -> WASM BN254 Groth16 prover
// (this crate), which is byte-for-byte compatible with snarkjs' output and the
// on-chain verifier. snarkjs remains as a transparent fallback if the Rust
// module fails to load or errors.
//
// The witness is still computed by the circom WASM (via `circom_runtime`, the
// same engine snarkjs uses) and fed to the Rust prover as the raw binary
// `.wtns` buffer (see `prove_wtns`); the Rust prover then performs the FFT +
// MSM that dominates proof time.

import { groth16 } from "snarkjs";
import type { Groth16Proof } from "snarkjs";

// Flip to false to force the legacy snarkjs prover.
const USE_RUST_PROVER = true;

type RustProver = {
  prove_wtns: (
    zkey: Uint8Array,
    wtns: Uint8Array,
  ) => Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
};

let rustProverPromise: Promise<RustProver> | null = null;

function loadRustProver(): Promise<RustProver> {
  if (!rustProverPromise) {
    rustProverPromise = (async () => {
      const mod = await import("./zkvote_prover.js");
      await (mod as unknown as { default: () => Promise<void> }).default();
      return mod as unknown as RustProver;
    })().catch((e) => {
      console.warn("Rust prover failed to load; falling back to snarkjs.", e);
      rustProverPromise = null;
      throw e;
    });
  }
  return rustProverPromise;
}

async function proveWithRust(
  input: Record<string, unknown>,
  wasmPath: string,
  zkeyPath: string,
): Promise<GeneratedProof> {
  // Compute the witness with the circom WASM (snarkjs' engine).
  const { WitnessCalculatorBuilder } = await import("circom_runtime");
  const wasmBytes = new Uint8Array(
    await (await fetch(wasmPath)).arrayBuffer(),
  );
  const wc = await WitnessCalculatorBuilder(wasmBytes, {});

  // circom_runtime expects field elements as BigInt (snarkjs does the same
  // via unstringifyBigInts before calling the witness calculator).
  const toBig = (v: unknown): unknown => {
    if (typeof v === "string") return BigInt(v);
    if (typeof v === "number") return BigInt(v);
    if (Array.isArray(v)) return v.map(toBig);
    return v;
  };
  const bigInput: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) bigInput[k] = toBig(v);

  // Return the raw binary `.wtns` buffer (position-0 `1` signal included),
  // exactly what the Rust `prove_wtns` entry point expects.
  const witnessBytes = (await wc.calculateWitness(bigInput, true)) as Uint8Array;

  const zkeyBytes = new Uint8Array(
    await (await fetch(zkeyPath)).arrayBuffer(),
  );

  const prover = await loadRustProver();
  const res = await prover.prove_wtns(zkeyBytes, witnessBytes);
  return { proof: res.proof, publicSignals: res.publicSignals };
}

export interface VoteProofInput {
  secret: string;
  salt: string;
  root: string;
  nullifier: string;
  daoId: string;
  proposalId: string;
  voteChoice: string; // "0" for no, "1" for yes
  commitment: string; // Identity commitment - private input, computed internally in circuit
  pathElements: string[];
  pathIndices: number[];
}

export interface CommentProofInput {
  secret: string;
  salt: string;
  root: string;
  nullifier: string;
  daoId: string;
  proposalId: string;
  commentNonce: string; // Nonce for multiple comments (0, 1, 2, ...)
  commitment: string; // Identity commitment - used for proof generation (private circuit input)
  pathElements: string[];
  pathIndices: number[];
}

// Legacy alias for backwards compatibility
export type ProofInput = VoteProofInput;

export interface GeneratedProof {
  proof: Groth16Proof;
  publicSignals: string[];
}

/**
 * Generate a Groth16 proof for anonymous voting
 * @param input Proof input parameters
 * @param wasmPath Path to compiled circuit WASM
 * @param zkeyPath Path to proving key
 * @returns Generated proof and public signals
 */
export async function generateVoteProof(
  input: VoteProofInput,
  wasmPath: string,
  zkeyPath: string,
): Promise<GeneratedProof> {
  try {
    // Format input for circuit - matches vote.circom signal names
    // Public signals: [root, nullifier, daoId, proposalId, voteChoice]
    // Note: commitment is COMPUTED INTERNALLY in the circuit from secret+salt
    // This provides improved vote unlinkability - commitment is never exposed
    const circuitInput = {
      // Public signals (verified on-chain)
      root: input.root,
      nullifier: input.nullifier,
      daoId: input.daoId,
      proposalId: input.proposalId,
      voteChoice: input.voteChoice,
      // Private signals (hidden in ZK proof)
      // commitment is computed internally: Poseidon(secret, salt)
      secret: input.secret,
      salt: input.salt,
      pathElements: input.pathElements,
      pathIndices: input.pathIndices,
    };

    // Generate proof with the Rust WASM prover (snarkjs fallback).
    if (USE_RUST_PROVER) {
      try {
        return await proveWithRust(circuitInput, wasmPath, zkeyPath);
      } catch (e) {
        console.warn(
          "Rust vote prover failed; falling back to snarkjs.",
          e,
        );
      }
    }

    const { proof, publicSignals } = await groth16.fullProve(
      circuitInput,
      wasmPath,
      zkeyPath,
    );

    return { proof, publicSignals };
  } catch (error) {
    console.error("Failed to generate vote proof:", error);
    throw new Error(
      `Vote proof generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Generate a Groth16 proof for anonymous commenting
 * @param input Proof input parameters (uses commentNonce instead of voteChoice)
 * @param wasmPath Path to compiled comment circuit WASM
 * @param zkeyPath Path to comment proving key
 * @returns Generated proof and public signals
 */
export async function generateCommentProof(
  input: CommentProofInput,
  wasmPath: string = "/circuits/comment/comment.wasm",
  zkeyPath: string = "/circuits/comment/comment_final.zkey",
): Promise<GeneratedProof> {
  try {
    // Format input for circuit - matches comment.circom signal names
    const circuitInput = {
      // Public signals (verified on-chain)
      root: input.root,
      nullifier: input.nullifier,
      daoId: input.daoId,
      proposalId: input.proposalId,
      commentNonce: input.commentNonce,
      commitment: input.commitment,
      // Private signals (hidden in ZK proof)
      secret: input.secret,
      salt: input.salt,
      pathElements: input.pathElements,
      pathIndices: input.pathIndices,
    };

    // Generate proof with the Rust WASM prover (snarkjs fallback).
    if (USE_RUST_PROVER) {
      try {
        return await proveWithRust(circuitInput, wasmPath, zkeyPath);
      } catch (e) {
        console.warn(
          "Rust comment prover failed; falling back to snarkjs.",
          e,
        );
      }
    }

    const { proof, publicSignals } = await groth16.fullProve(
      circuitInput,
      wasmPath,
      zkeyPath,
    );

    return { proof, publicSignals };
  } catch (error) {
    console.error("Failed to generate comment proof:", error);
    throw new Error(
      `Comment proof generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Convert snarkjs proof format to Soroban-compatible hex strings
 *
 * After PR #1614, Soroban BN254 host functions use BIG-ENDIAN encoding
 * matching CAP-74 and EVM precompile specifications (EIP-196, EIP-197).
 * snarkjs already outputs big-endian field elements, so NO byte reversal is needed.
 *
 * G2 Fp2 format: Ethereum expects [c1, c0] (imaginary first), while snarkjs
 * outputs [c0, c1] (real first), so we swap each coordinate pair.
 */
export function formatProofForSoroban(proof: Groth16Proof): {
  proof_a: string;
  proof_b: string;
  proof_c: string;
} {
  // Convert field element to BIG-ENDIAN hex (no reversal needed)
  const toHexBE = (value: string): string => {
    const bigInt = BigInt(value);
    return bigInt.toString(16).padStart(64, "0");
  };

  // Format pi_a (G1 point): be_bytes(X) || be_bytes(Y)
  const proof_a = toHexBE(proof.pi_a[0]) + toHexBE(proof.pi_a[1]);

  // Format pi_b (G2 point): [[x.c0, x.c1], [y.c0, y.c1]]
  // Ethereum/Soroban format: be_bytes(X_c1) || be_bytes(X_c0) || be_bytes(Y_c1) || be_bytes(Y_c0)
  // snarkjs outputs: [[c0, c1], [c0, c1]] where c0=real, c1=imaginary
  // We swap within each coordinate pair: [c1, c0, c1, c0]
  const proof_b =
    toHexBE(proof.pi_b[0][1]) + // X.c1 (imaginary)
    toHexBE(proof.pi_b[0][0]) + // X.c0 (real)
    toHexBE(proof.pi_b[1][1]) + // Y.c1 (imaginary)
    toHexBE(proof.pi_b[1][0]); // Y.c0 (real)

  // Format pi_c (G1 point): be_bytes(X) || be_bytes(Y)
  const proof_c = toHexBE(proof.pi_c[0]) + toHexBE(proof.pi_c[1]);

  return { proof_a, proof_b, proof_c };
}

/**
 * Generate a random secret for commitment
 */
export function generateSecret(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  let result = BigInt(0);
  for (let i = 0; i < array.length; i++) {
    result = (result << BigInt(8)) | BigInt(array[i]);
  }
  return result.toString();
}

/**
 * Calculate vote nullifier using Poseidon hash
 * nullifier = Poseidon(secret, daoId, proposalId)
 */
export async function calculateNullifier(
  secret: string,
  daoId: string,
  proposalId: string,
): Promise<string> {
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();

  const hash = poseidon.F.toString(
    poseidon([BigInt(secret), BigInt(daoId), BigInt(proposalId)]),
  );

  return hash;
}

/**
 * Calculate comment nullifier using Poseidon hash
 * nullifier = Poseidon(secret, daoId, proposalId, commentNonce)
 * The nonce allows multiple comments per proposal from the same user
 */
export async function calculateCommentNullifier(
  secret: string,
  daoId: string,
  proposalId: string,
  commentNonce: string,
): Promise<string> {
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();

  const hash = poseidon.F.toString(
    poseidon([
      BigInt(secret),
      BigInt(daoId),
      BigInt(proposalId),
      BigInt(commentNonce),
    ]),
  );

  return hash;
}

/**
 * Calculate commitment from secret and salt using Poseidon hash
 * commitment = Poseidon(secret, salt)
 */
export async function calculateCommitment(
  secret: string,
  salt: string,
): Promise<string> {
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();

  const hash = poseidon.F.toString(poseidon([BigInt(secret), BigInt(salt)]));

  return hash;
}

/**
 * Verify a proof locally before submitting
 * @param proof Generated proof
 * @param publicSignals Public signals
 * @param vkeyPath Path to verification key JSON
 */
export async function verifyProofLocally(
  proof: Groth16Proof,
  publicSignals: string[],
  vkeyPath: string,
): Promise<boolean> {
  try {
    const vkey = await fetch(vkeyPath).then((r) => r.json());
    const result = await groth16.verify(vkey, publicSignals, proof);
    return result;
  } catch (error) {
    console.error("Local verification failed:", error);
    return false;
  }
}
