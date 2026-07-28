// ZK Proof generation utilities using snarkjs

import { groth16 } from "snarkjs";
import type { CircuitSignals, Groth16Proof } from "snarkjs";

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
  circuitVersion?: string; // "v1" or "v2" (defaults to "v1")
  chainId?: string; // Required for v2 circuits
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
  circuitVersion?: string; // "v1" or "v2" (defaults to "v1")
  parentCommentId?: string; // Required for v2 circuits
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
 * @param wasmPath Path to compiled circuit WASM, or an already-downloaded buffer
 * @param zkeyPath Path to proving key, or an already-downloaded buffer
 * @returns Generated proof and public signals
 */
export async function generateVoteProof(
  input: VoteProofInput,
  wasmPath: string | Uint8Array,
  zkeyPath: string | Uint8Array,
): Promise<GeneratedProof> {
  try {
    const circuitVersion = input.circuitVersion || "v1";

    let circuitInput: CircuitSignals;

    if (circuitVersion === "v2") {
      // vote_v2.circom - adds chainId as 6th public signal
      circuitInput = {
        root: input.root,
        nullifier: input.nullifier,
        daoId: input.daoId,
        proposalId: input.proposalId,
        voteChoice: input.voteChoice,
        chainId: input.chainId || "0",
        secret: input.secret,
        salt: input.salt,
        pathElements: input.pathElements,
        pathIndices: input.pathIndices,
      };
    } else {
      // vote_v1.circom - original 5 public signals
      circuitInput = {
        root: input.root,
        nullifier: input.nullifier,
        daoId: input.daoId,
        proposalId: input.proposalId,
        voteChoice: input.voteChoice,
        secret: input.secret,
        salt: input.salt,
        pathElements: input.pathElements,
        pathIndices: input.pathIndices,
      };
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
 * Generate a Groth16 proof for v2 circuit (with chainId)
 * Convenience wrapper around generateVoteProof
 */
export async function generateVoteProofV2(
  input: VoteProofInput,
  wasmPath: string | Uint8Array = "/circuits/vote_v2/vote_v2.wasm",
  zkeyPath: string | Uint8Array = "/circuits/vote_v2/vote_v2_final.zkey",
): Promise<GeneratedProof> {
  return generateVoteProof(
    { ...input, circuitVersion: "v2" },
    wasmPath,
    zkeyPath,
  );
}

/**
 * Generate a Groth16 proof for anonymous commenting
 * @param input Proof input parameters (uses commentNonce instead of voteChoice)
 * @param wasmPath Path to compiled comment circuit WASM, or an already-downloaded buffer
 * @param zkeyPath Path to comment proving key, or an already-downloaded buffer
 * @returns Generated proof and public signals
 */
export async function generateCommentProof(
  input: CommentProofInput,
  wasmPath: string | Uint8Array = "/circuits/comment/comment.wasm",
  zkeyPath: string | Uint8Array = "/circuits/comment/comment_final.zkey",
): Promise<GeneratedProof> {
  try {
    const circuitVersion = input.circuitVersion || "v1";

    let circuitInput: CircuitSignals;

    if (circuitVersion === "v2") {
      // comment_v2.circom - adds parentCommentId as 7th public signal
      circuitInput = {
        root: input.root,
        nullifier: input.nullifier,
        daoId: input.daoId,
        proposalId: input.proposalId,
        commentNonce: input.commentNonce,
        commitment: input.commitment,
        parentCommentId: input.parentCommentId || "0",
        secret: input.secret,
        salt: input.salt,
        pathElements: input.pathElements,
        pathIndices: input.pathIndices,
      };
    } else {
      // comment_v1.circom - original 6 public signals
      circuitInput = {
        root: input.root,
        nullifier: input.nullifier,
        daoId: input.daoId,
        proposalId: input.proposalId,
        commentNonce: input.commentNonce,
        commitment: input.commitment,
        secret: input.secret,
        salt: input.salt,
        pathElements: input.pathElements,
        pathIndices: input.pathIndices,
      };
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
 * Generate a Groth16 proof for v2 comment circuit (with parentCommentId)
 */
export async function generateCommentProofV2(
  input: CommentProofInput,
  wasmPath: string | Uint8Array = "/circuits/comment_v2/comment_v2.wasm",
  zkeyPath: string | Uint8Array = "/circuits/comment_v2/comment_v2_final.zkey",
): Promise<GeneratedProof> {
  return generateCommentProof(
    { ...input, circuitVersion: "v2" },
    wasmPath,
    zkeyPath,
  );
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
 * For v2: nullifier = Poseidon(secret, daoId, proposalId, chainId)
 */
export async function calculateNullifier(
  secret: string,
  daoId: string,
  proposalId: string,
  circuitVersion: string = "v1",
  chainId?: string,
): Promise<string> {
  const { buildPoseidon } = await import("circomlibjs");
  const poseidon = await buildPoseidon();

  let hash;
  if (circuitVersion === "v2" && chainId !== undefined) {
    hash = poseidon.F.toString(
      poseidon([
        BigInt(secret),
        BigInt(daoId),
        BigInt(proposalId),
        BigInt(chainId),
      ]),
    );
  } else {
    hash = poseidon.F.toString(
      poseidon([BigInt(secret), BigInt(daoId), BigInt(proposalId)]),
    );
  }

  return hash;
}

/**
 * Calculate vote nullifier for v2 circuit (includes chainId)
 */
export async function calculateNullifierV2(
  secret: string,
  daoId: string,
  proposalId: string,
  chainId: string,
): Promise<string> {
  return calculateNullifier(secret, daoId, proposalId, "v2", chainId);
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
