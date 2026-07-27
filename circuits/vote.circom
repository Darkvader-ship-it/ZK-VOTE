pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "merkle_tree.circom";

// DaoVote Anonymous Vote Circuit
//
// Proves:
// 1. Voter knows secret & salt that hash to a commitment (leaf) in the Merkle tree
// 2. Nullifier is correctly derived from secret, daoId, and proposalId (domain-separated)
// 3. Vote choice (candidate index) is within [0, numCandidates)
//
// Public signals: [root, nullifier, daoId, proposalId, voteChoice, numCandidates]
// Private signals: secret, salt, pathElements, pathIndices
//
// PRIVACY: Commitment is NOT exposed publicly. Votes are fully unlinkable across proposals.
// Revocation is enforced via Merkle tree updates (zeroing leaves) rather than on-chain checks.
//
// SECURITY: numCandidates is a public input so the contract can verify the circuit enforced
// the same candidate bound that the election was configured with. Without this binding,
// a prover could supply a proof valid under one numCandidates value while the contract
// tallies using a different (potentially larger) count.
template Vote(levels) {
    // Public inputs
    signal input root;              // Merkle tree root (verified on-chain)
    signal input nullifier;         // Prevents double voting (domain-separated)
    signal input daoId;             // DAO identifier (for domain separation)
    signal input proposalId;        // Which proposal this vote is for
    signal input voteChoice;        // Candidate index the voter selected
    signal input numCandidates;     // Total number of candidates (set by election config)

    // Private inputs
    signal input secret;            // Voter's secret (like password)
    signal input salt;              // Random salt for commitment
    signal input pathElements[levels];  // Merkle proof siblings
    signal input pathIndices[levels];   // Merkle proof path (0=left, 1=right)

    // 1. Compute identity commitment: Poseidon(secret, salt)
    // This is used as the leaf in the Merkle tree
    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== secret;
    commitmentHasher.inputs[1] <== salt;

    // Commitment is computed internally (private) - not exposed as public signal
    signal commitment;
    commitment <== commitmentHasher.out;

    // 2. Verify Merkle tree inclusion
    component merkleProof = MerkleTreeInclusionProof(levels);
    merkleProof.leaf <== commitment;
    for (var i = 0; i < levels; i++) {
        merkleProof.pathElements[i] <== pathElements[i];
        merkleProof.pathIndices[i] <== pathIndices[i];
    }

    // Constrain computed root to match public root
    root === merkleProof.root;

    // 3. Compute nullifier: Poseidon(secret, daoId, proposalId)
    // Domain separation: includes daoId to prevent cross-DAO nullifier linkability
    // This ensures a voter can't be linked across DAOs even if reusing the same secret
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== secret;
    nullifierHasher.inputs[1] <== daoId;
    nullifierHasher.inputs[2] <== proposalId;

    // Constrain computed nullifier to match public nullifier
    nullifier === nullifierHasher.out;

    // 4. Verify candidate index is within bounds: voteChoice < numCandidates
    // Uses 32-bit LessThan comparator from circomlib.
    // This prevents a voter from proving a vote for a non-existent candidate.
    component validChoice = LessThan(32);
    validChoice.in[0] <== voteChoice;
    validChoice.in[1] <== numCandidates;
    validChoice.out === 1;
}

// Default tree depth of 18 (supports ~262K members)
// Public signals: [root, nullifier, daoId, proposalId, voteChoice, numCandidates] - 6 signals
// Commitment is computed internally from secret+salt (private)
component main {public [root, nullifier, daoId, proposalId, voteChoice, numCandidates]} = Vote(18);
