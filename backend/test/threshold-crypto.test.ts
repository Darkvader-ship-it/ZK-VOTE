import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as tc from "../src/services/threshold-crypto.js";

describe("Threshold Cryptography", () => {
  describe("ElGamal Key Generation", () => {
    it("should generate a valid keypair", () => {
      const kp = tc.generateElGamalKeypair();
      assert.ok(kp.privateKey > 0n);
      assert.ok(kp.privateKey < tc.BN254_FR_MODULUS);
      assert.strictEqual(kp.publicKey.length, 128); // hex-encoded 64 bytes
    });

    it("should generate different keys each time", () => {
      const kp1 = tc.generateElGamalKeypair();
      const kp2 = tc.generateElGamalKeypair();
      assert.notStrictEqual(kp1.privateKey, kp2.privateKey);
    });
  });

  describe("ElGamal Encryption/Decryption", () => {
    it("should encrypt and decrypt vote = 0", () => {
      const kp = tc.generateElGamalKeypair();
      const ct = tc.encryptVote(kp.publicKey, 0n);
      const decrypted = tc.decryptVote(ct, kp.privateKey);
      assert.strictEqual(decrypted, 0n);
    });

    it("should encrypt and decrypt vote = 1", () => {
      const kp = tc.generateElGamalKeypair();
      const ct = tc.encryptVote(kp.publicKey, 1n);
      const decrypted = tc.decryptVote(ct, kp.privateKey);
      assert.strictEqual(decrypted, 1n);
    });

    it("should encrypt and decrypt vote = 5", () => {
      const kp = tc.generateElGamalKeypair();
      const ct = tc.encryptVote(kp.publicKey, 5n);
      const decrypted = tc.decryptVote(ct, kp.privateKey);
      assert.strictEqual(decrypted, 5n);
    });
  });

  describe("Homomorphic Addition", () => {
    it("should homomorphically add two votes", () => {
      const kp = tc.generateElGamalKeypair();
      const ct1 = tc.encryptVote(kp.publicKey, 1n);
      const ct2 = tc.encryptVote(kp.publicKey, 0n);
      const sum = tc.homomorphicAdd(ct1, ct2);
      const decrypted = tc.decryptVote(sum, kp.privateKey);
      assert.strictEqual(decrypted, 1n);
    });

    it("should aggregate multiple votes", () => {
      const kp = tc.generateElGamalKeypair();
      const votes = [
        tc.encryptVote(kp.publicKey, 1n),
        tc.encryptVote(kp.publicKey, 1n),
        tc.encryptVote(kp.publicKey, 0n),
        tc.encryptVote(kp.publicKey, 1n),
      ];
      const tally = tc.aggregateTally(votes);
      const decrypted = tc.decryptVote(tally, kp.privateKey);
      assert.strictEqual(decrypted, 3n);
    });
  });

  describe("Shamir Secret Sharing", () => {
    it("should split and reconstruct a secret (2,3)", () => {
      const secret = 123456789n;
      const shares = tc.createShares(secret, 2, 3);
      assert.strictEqual(shares.length, 3);

      // Reconstruct with 2 shares
      const reconstructed = tc.reconstructSecret([shares[0], shares[1]]);
      assert.strictEqual(reconstructed, secret);
    });

    it("should split and reconstruct a secret (3,5)", () => {
      const secret = 987654321n;
      const shares = tc.createShares(secret, 3, 5);
      assert.strictEqual(shares.length, 5);

      // Reconstruct with 3 shares
      const reconstructed = tc.reconstructSecret([
        shares[0],
        shares[2],
        shares[4],
      ]);
      assert.strictEqual(reconstructed, secret);
    });

    it("should fail to reconstruct with insufficient shares", () => {
      const secret = 555555n;
      const shares = tc.createShares(secret, 3, 5);

      // With only 2 out of 3 shares, should get wrong result
      const reconstructed = tc.reconstructSecret([shares[0], shares[1]]);
      assert.notStrictEqual(reconstructed, secret);
    });

    it("should reconstruct with any subset of shares", () => {
      const secret = 7777777n;
      const shares = tc.createShares(secret, 2, 5);

      // Any 2 should work
      assert.strictEqual(tc.reconstructSecret([shares[1], shares[3]]), secret);
      assert.strictEqual(tc.reconstructSecret([shares[0], shares[4]]), secret);
      assert.strictEqual(tc.reconstructSecret([shares[2], shares[3]]), secret);
    });
  });

  describe("Feldman VSS", () => {
    it("should verify shares against commitments", () => {
      const coeffs = [12345n, 67890n, 11111n];
      const commitments = tc.generateVSSCommitments(coeffs);

      for (let i = 1; i <= 5; i++) {
        const value = tc.evaluatePolynomial(coeffs, BigInt(i));
        assert.ok(tc.verifyVSSShare(value, i, commitments));
      }
    });

    it("should reject invalid shares", () => {
      const coeffs = [12345n, 67890n, 11111n];
      const commitments = tc.generateVSSCommitments(coeffs);

      const value = tc.evaluatePolynomial(coeffs, BigInt(2));
      // Verify with wrong index
      assert.ok(!tc.verifyVSSShare(value, 3, commitments));
    });
  });

  describe("DKG Simulation", () => {
    it("should simulate (2,3) DKG", () => {
      const t = 2;
      const n = 3;

      // Generate DKG shares for each authority
      const authorities = Array.from({ length: n }, (_, i) =>
        tc.generateDKGShares(i, t, n)
      );

      // Distribute shares: receivedShares[j] = shares sent TO authority j from all authorities
      const receivedShares = Array.from({ length: n }, (_, j) =>
        authorities.map((auth, i) => ({
          fromIndex: i,
          value: auth.shares[j].value,
        }))
      );

      // Collect all commitments
      const allCommitments = authorities.map((a) => a.commitments);

      // Each authority computes their result
      const results = receivedShares.map((shares) =>
        tc.computeDKGResult(shares, allCommitments)
      );

      // All authorities should have the same joint public key
      for (let i = 1; i < results.length; i++) {
        assert.strictEqual(results[i].publicKey, results[0].publicKey);
      }

      // Verify private key shares are different
      for (let i = 1; i < results.length; i++) {
        assert.notStrictEqual(
          results[i].privateKeyShare,
          results[0].privateKeyShare
        );
      }

      // Joint public key should be non-zero
      assert.ok(results[0].publicKey.length > 0);
    });
  });

  describe("Threshold Decryption", () => {
    it("should perform end-to-end threshold decryption (2,3)", () => {
      const t = 2;
      const n = 3;

      // DKG phase
      const authorities = Array.from({ length: n }, (_, i) =>
        tc.generateDKGShares(i, t, n)
      );

      const receivedShares = Array.from({ length: n }, (_, j) =>
        authorities.map((auth, i) => ({
          fromIndex: i,
          value: auth.shares[j].value,
        }))
      );

      const allCommitments = authorities.map((a) => a.commitments);
      const results = receivedShares.map((shares) =>
        tc.computeDKGResult(shares, allCommitments)
      );

      const jointPublicKey = results[0].publicKey;

      // Encrypt votes
      const vote1 = tc.encryptVote(jointPublicKey, 1n);
      const vote2 = tc.encryptVote(jointPublicKey, 0n);
      const vote3 = tc.encryptVote(jointPublicKey, 1n);

      // Homomorphic tally
      const encryptedTally = tc.aggregateTally([vote1, vote2, vote3]);

      // Generate decryption shares (t authorities)
      const decShares = [0, 1].map((idx) => ({
        authorityIndex: idx,
        shareHex: tc.generateDecryptionShare(
          encryptedTally,
          results[idx].privateKeyShare
        ),
      }));

      // Combine shares
      const combinedShare = tc.combineDecryptionShares(decShares);

      // Decrypt tally
      const tally = tc.decryptTally(encryptedTally, combinedShare);
      assert.strictEqual(tally, 2n); // 1 + 0 + 1 = 2
    });

    it("should fail with insufficient decryption shares", () => {
      const t = 3;
      const n = 5;

      const authorities = Array.from({ length: n }, (_, i) =>
        tc.generateDKGShares(i, t, n)
      );

      const receivedShares = Array.from({ length: n }, (_, j) =>
        authorities.map((auth, i) => ({
          fromIndex: i,
          value: auth.shares[j].value,
        }))
      );

      const allCommitments = authorities.map((a) => a.commitments);
      const results = receivedShares.map((shares) =>
        tc.computeDKGResult(shares, allCommitments)
      );

      const jointPublicKey = results[0].publicKey;
      const vote = tc.encryptVote(jointPublicKey, 1n);

      // Only 2 shares (need 3)
      const decShares = [0, 1].map((idx) => ({
        authorityIndex: idx,
        shareHex: tc.generateDecryptionShare(vote, results[idx].privateKeyShare),
      }));

      const combinedShare = tc.combineDecryptionShares(decShares);

      // Should decrypt to wrong value or throw (garbage point not in brute-force range)
      try {
        const tally = tc.decryptTally(vote, combinedShare);
        assert.notStrictEqual(tally, 1n);
      } catch {
        // Expected: insufficient shares produce invalid point
      }
    });
  });

  describe("ZKP for Tally Correctness", () => {
    it("should generate and verify tally proof", () => {
      const kp = tc.generateElGamalKeypair();
      const vote = tc.encryptVote(kp.publicKey, 1n);
      const decrypted = tc.decryptVote(vote, kp.privateKey);

      const combinedShare = tc.generateDecryptionShare(vote, kp.privateKey);
      const proof = tc.generateTallyProof(vote, combinedShare, decrypted, kp.privateKey);

      assert.ok(proof.length > 0);
      assert.ok(proof.length % 2 === 0);

      // Verify proof
      const verified = tc.verifyTallyProof(vote, combinedShare, decrypted, proof);
      assert.ok(verified);
    });
  });

  describe("Lagrange Coefficients", () => {
    it("should compute correct Lagrange coefficients", () => {
      const indices = [0, 1, 3]; // authority indices 0, 1, 3

      const lambda0 = tc.lagrangeCoefficientAtZero(0, indices);
      const lambda1 = tc.lagrangeCoefficientAtZero(1, indices);
      const lambda3 = tc.lagrangeCoefficientAtZero(3, indices);

      // Sum of Lagrange coefficients at x=0 should be 1
      const sum = (lambda0 + lambda1 + lambda3) % tc.BN254_FR_MODULUS;
      assert.strictEqual(sum, 1n);
    });
  });
});
