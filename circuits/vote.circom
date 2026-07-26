pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";

// DaoVote Anonymous Vote Circuit
//
// Proves:
// 1. Voter knows secret & salt that hash to a commitment (leaf) in the Merkle tree
// 2. Nullifier is correctly derived from secret, daoId, and proposalId (domain-separated)
// 3. Vote choice is binary (0 or 1)
//
// Public signals: [root, nullifier, daoId, proposalId, voteChoice]
// Private signals: secret, salt, pathElements, pathIndices
//
// PRIVACY: Commitment is NOT exposed publicly. Votes are fully unlinkable across proposals.
// Revocation is enforced via Merkle tree updates (zeroing leaves) rather than on-chain checks.
template Vote(levels) {
    // Public inputs
    signal input root;              // Merkle tree root (verified on-chain)
    signal input nullifier;         // Prevents double voting (domain-separated)
    signal input daoId;             // DAO identifier (for domain separation)
    signal input proposalId;        // Which proposal this vote is for
    signal input voteChoice;        // 0 = against, 1 = for

    // Private inputs
    signal input secret;            // Voter's secret (like password)
    signal input salt;              // Random salt for commitment
    signal input pathElements[levels];  // Merkle proof siblings
    signal input pathIndices[levels];   // Merkle proof path (0=left, 1=right)

    // 1. Compute identity commitment: Poseidon(secret, salt)
    // This is used as the leaf in the Merkle tree
    // CONSTRAINT: Poseidon hash is deterministic and fully constrains the output
    // Using <== ensures this is a constrained assignment (not just <--)
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== secret;
    commitmentHasher.inputs[1] <== salt;

    // Commitment is computed internally (private) - not exposed as public signal
    // SECURITY: Keeping commitment private prevents linkability across proposals
    signal commitment;
    commitment <== commitmentHasher.out;

    // 2. Verify Merkle tree inclusion
    // CONSTRAINT: Proves commitment is a leaf in the Merkle tree with given root
    // The MerkleTreeInclusionProof template ensures:
    //   - pathIndices are binary (0 or 1) via explicit constraint
    //   - All path elements are properly hashed
    //   - Root computation is deterministic
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        // SECURITY: pathIndices are constrained to {0,1} in MerkleTreeInclusionProof
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    // Constrain computed root to match public root using strong equality (===)
    // CRITICAL: This ensures the voter is in the Merkle tree
    root === merkleProof.root;

    // 3. Compute nullifier: Poseidon(secret, daoId, proposalId)
    // Domain separation: includes daoId to prevent cross-DAO nullifier linkability
    // This ensures a voter can't be linked across DAOs even if reusing the same secret
    // CONSTRAINT: Poseidon hash fully constrains the output
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;

    // Constrain computed nullifier to match public nullifier using strong equality (===)
    // CRITICAL: This prevents double voting - same nullifier can't be used twice
    nullifier === nullifierHasher.out;

    // 4. Verify vote choice is binary (0 or 1)
    // CONSTRAINT: Algebraic constraint v(v-1)=0 only satisfied when v∈{0,1}
    // This prevents fractional or invalid votes
    // SECURITY: Without this constraint, prover could use any field element
    voteChoice * (voteChoice - 1) === 0;
}

// Default tree depth of 18 (supports ~262K members)
// Public signals: [root, nullifier, daoId, proposalId, voteChoice] - 5 signals
// Commitment is computed internally from secret+salt (private)
component main {public [root, nullifier, daoId, proposalId, voteChoice]} = Vote(18);
