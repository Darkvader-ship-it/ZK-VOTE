// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Mock Groth16 Verifier
 * @notice For testing purposes only. In production, use the snarkjs-generated
 *         Verifier.sol that implements real BN254 pairing checks.
 */
contract MockVerifier {
    bool public shouldVerify = true;

    function setShouldVerify(bool _shouldVerify) external {
        shouldVerify = _shouldVerify;
    }

    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata publicSignals
    ) external view returns (bool) {
        if (!shouldVerify) return false;

        // Mock verification: check that proof points are non-zero
        if (a[0] == 0 && a[1] == 0) return false;
        if (c[0] == 0 && c[1] == 0) return false;

        return true;
    }
}
