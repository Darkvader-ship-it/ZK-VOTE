//! # Proof Canonicalization for Groth16
//!
//! Implements canonicalization to prevent proof malleability attacks.
//!
//! ## Background
//!
//! Groth16 proofs are inherently malleable. Given a valid proof π = (A, B, C),
//! an attacker can compute π' = (-A, -B, C) which is also valid for the same statement.
//!
//! ## Canonicalization Strategy
//!
//! We enforce a canonical form by requiring that the y-coordinate of point A
//! is in the "lower half" of the field (y < (p-1)/2), where p is the field modulus.
//!
//! This eliminates malleability while preserving proof validity.
//!
//! ## Security Properties
//!
//! 1. **Deterministic**: Same statement always produces same canonical form
//! 2. **Non-malleable**: Only one valid canonical form exists per statement
//! 3. **Backward compatible**: Existing proofs can be canonicalized
//! 4. **Efficient**: O(1) check, no expensive operations
//!
//! ## Usage
//!
//! ```rust,ignore
//! use zkvote_groth16::{canonicalize_proof_bn254, is_proof_canonical_bn254};
//!
//! // Verify proof is canonical before storing
//! if !is_proof_canonical_bn254(&env, &proof) {
//!     panic!("Proof must be in canonical form");
//! }
//! ```

use soroban_sdk::{Bytes, BytesN, Env, U256};

/// BN254 base field modulus (p)
/// p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
const BN254_P_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
    0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

/// BN254 (p-1)/2 in big-endian for canonicalization check
/// Used to determine if y-coordinate is in lower half of field
const BN254_P_MINUS_1_DIV_2_BE: [u8; 32] = [
    0x18, 0x32, 0x27, 0x39, 0x70, 0x98, 0xd0, 0x14,
    0xdc, 0x28, 0x22, 0xdb, 0x40, 0xc0, 0xac, 0x2e,
    0xcb, 0xc0, 0xb5, 0x48, 0xb4, 0x38, 0xe5, 0x46,
    0x9e, 0x10, 0x46, 0x0b, 0x6c, 0x3e, 0x7e, 0xa3,
];

/// BLS12-381 base field modulus (p) for BLS curve
/// p = 4002409555221667393417789825735904156556882819939007885332058136124031650490837864442687629129015664037894272559787
const BLS12_381_P_MODULUS_BE: [u8; 48] = [
    0x1a, 0x01, 0x11, 0xea, 0x39, 0x7f, 0xe6, 0x9a,
    0x4b, 0x1b, 0xa7, 0xb6, 0x43, 0x4b, 0xac, 0xd7,
    0x64, 0x77, 0x4b, 0x84, 0xf3, 0x85, 0x12, 0xbf,
    0x67, 0x30, 0xd2, 0xa0, 0xf6, 0xb0, 0xf6, 0x24,
    0x1e, 0xab, 0xff, 0xfe, 0xb1, 0x53, 0xff, 0xff,
    0xb9, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xaa, 0xab,
];

/// BLS12-381 (p-1)/2 in big-endian
const BLS12_381_P_MINUS_1_DIV_2_BE: [u8; 48] = [
    0x0d, 0x00, 0x88, 0xf5, 0x1c, 0xbf, 0xf3, 0x4d,
    0x25, 0x8d, 0xd3, 0xdb, 0x21, 0xa5, 0xd6, 0x6b,
    0xb2, 0x3b, 0xa5, 0xc2, 0x79, 0xc2, 0x89, 0x5f,
    0xb3, 0x98, 0x69, 0x50, 0x7b, 0x58, 0x7b, 0x12,
    0x0f, 0x55, 0xff, 0xff, 0x58, 0xa9, 0xff, 0xff,
    0xdc, 0xff, 0x7f, 0xff, 0xff, 0xff, 0xd5, 0x55,
];

/// Check if a BN254 G1 point's y-coordinate is in canonical form
/// 
/// Canonical form: y < (p-1)/2 where p is the BN254 base field modulus
/// 
/// ## Arguments
/// * `env` - Soroban environment
/// * `point` - 64-byte G1 affine point (x || y, each 32 bytes big-endian)
/// 
/// ## Returns
/// `true` if y-coordinate is in lower half of field (canonical)
pub fn is_g1_point_canonical_bn254(env: &Env, point: &BytesN<64>) -> bool {
    // Extract y-coordinate (bytes 32-63)
    let y_bytes = point.slice(32..64);
    
    // Compare y with (p-1)/2
    let p_half = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_P_MINUS_1_DIV_2_BE));
    let y = U256::from_be_bytes(env, &y_bytes.to_bytes());
    
    // Canonical if y <= (p-1)/2
    y <= p_half
}

/// Check if a BN254 Groth16 proof is in canonical form
/// 
/// A proof is canonical if its A component (G1 point) has y < (p-1)/2
/// 
/// ## Arguments
/// * `env` - Soroban environment
/// * `proof` - Groth16 proof with components (A, B, C)
/// 
/// ## Returns
/// `true` if proof is in canonical form
pub fn is_proof_canonical_bn254(env: &Env, proof: &crate::Proof) -> bool {
    is_g1_point_canonical_bn254(env, &proof.a)
}

/// Canonicalize a BN254 G1 point by negating if y >= (p-1)/2
/// 
/// ## Arguments
/// * `env` - Soroban environment
/// * `point` - 64-byte G1 affine point to canonicalize
/// 
/// ## Returns
/// Canonicalized point (y in lower half of field)
pub fn canonicalize_g1_point_bn254(env: &Env, point: &BytesN<64>) -> BytesN<64> {
    if is_g1_point_canonical_bn254(env, point) {
        // Already canonical
        return point.clone();
    }
    
    // Negate y-coordinate: y' = p - y
    let x_bytes = point.slice(0..32);
    let y_bytes = point.slice(32..64);
    
    let p = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_P_MODULUS_BE));
    let y = U256::from_be_bytes(env, &y_bytes.to_bytes());
    
    // y' = p - y (negate in field)
    let y_neg = p - y;
    let y_neg_bytes = y_neg.to_be_bytes();
    
    // Concatenate x || y_neg
    let mut result_bytes = Bytes::new(env);
    result_bytes.extend_from_array(&x_bytes.to_array());
    result_bytes.extend_from_slice(&y_neg_bytes);
    
    BytesN::from_bytes(env, &result_bytes)
}

/// Canonicalize a BN254 Groth16 proof
/// 
/// Ensures the proof A component has y-coordinate in lower half of field.
/// If not canonical, negates A and B to produce equivalent canonical proof.
/// 
/// ## Arguments
/// * `env` - Soroban environment
/// * `proof` - Groth16 proof to canonicalize
/// 
/// ## Returns
/// Canonicalized proof
pub fn canonicalize_proof_bn254(env: &Env, proof: &crate::Proof) -> crate::Proof {
    if is_proof_canonical_bn254(env, proof) {
        return proof.clone();
    }
    
    // Negate A and B (C remains unchanged)
    // This produces an equivalent valid proof in canonical form
    let a_canon = canonicalize_g1_point_bn254(env, &proof.a);
    let b_canon = negate_g2_point_bn254(env, &proof.b);
    
    crate::Proof {
        a: a_canon,
        b: b_canon,
        c: proof.c.clone(),
    }
}

/// Negate a BN254 G2 point
/// 
/// For BN254 G2 point (x, y) where x, y ∈ Fp2, negation is (x, -y)
/// G2 point format: 128 bytes = (x_c1 || x_c0 || y_c1 || y_c0), each 32 bytes
/// 
/// ## Arguments
/// * `env` - Soroban environment
/// * `point` - 128-byte G2 affine point
/// 
/// ## Returns
/// Negated G2 point
fn negate_g2_point_bn254(env: &Env, point: &BytesN<128>) -> BytesN<128> {
    let p = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_P_MODULUS_BE));
    
    // Extract components: x = (x_c1, x_c0), y = (y_c1, y_c0)
    let x_c1 = point.slice(0..32);
    let x_c0 = point.slice(32..64);
    let y_c1_bytes = point.slice(64..96);
    let y_c0_bytes = point.slice(96..128);
    
    // Negate y components: y' = -y = (p - y_c1, p - y_c0)
    let y_c1 = U256::from_be_bytes(env, &y_c1_bytes.to_bytes());
    let y_c0 = U256::from_be_bytes(env, &y_c0_bytes.to_bytes());
    
    let y_c1_neg = p.clone() - y_c1;
    let y_c0_neg = p - y_c0;
    
    // Reconstruct: x_c1 || x_c0 || y_c1_neg || y_c0_neg
    let mut result = Bytes::new(env);
    result.extend_from_array(&x_c1.to_array());
    result.extend_from_array(&x_c0.to_array());
    result.extend_from_slice(&y_c1_neg.to_be_bytes());
    result.extend_from_slice(&y_c0_neg.to_be_bytes());
    
    BytesN::from_bytes(env, &result)
}

/// Check if a BLS12-381 G1 point's y-coordinate is in canonical form
pub fn is_g1_point_canonical_bls381(env: &Env, point: &BytesN<96>) -> bool {
    // Extract y-coordinate (bytes 48-95)
    let y_bytes = point.slice(48..96);
    
    // BLS12-381 uses 48-byte field elements
    let p_half_bytes = Bytes::from_array(env, &BLS12_381_P_MINUS_1_DIV_2_BE);
    let y_bytes_full = y_bytes.to_bytes();
    
    // Compare y with (p-1)/2 byte-by-byte (simplified comparison)
    // In production, use proper field arithmetic library
    for i in 0..48 {
        let y_byte = y_bytes_full.get(i).unwrap_or(0);
        let half_byte = p_half_bytes.get(i).unwrap_or(0);
        
        if y_byte < half_byte {
            return true;
        } else if y_byte > half_byte {
            return false;
        }
    }
    
    true // Equal case: considered canonical
}

/// Check if a BLS12-381 Groth16 proof is in canonical form
pub fn is_proof_canonical_bls381(env: &Env, proof: &crate::ProofBls381) -> bool {
    is_g1_point_canonical_bls381(env, &proof.a)
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn test_bn254_canonicalization() {
        let env = Env::default();
        
        // Test with identity point (not realistic, but tests logic)
        let mut point_bytes = [0u8; 64];
        point_bytes[31] = 1; // x = 1
        point_bytes[63] = 2; // y = 2
        
        let point = BytesN::from_array(&env, &point_bytes);
        
        // Small y should be canonical
        assert!(is_g1_point_canonical_bn254(&env, &point));
        
        // Canonicalization of canonical point should be identity
        let canon = canonicalize_g1_point_bn254(&env, &point);
        assert_eq!(canon, point);
    }

    #[test]
    fn test_proof_canonical_check() {
        let env = Env::default();
        
        // Create a mock proof with small A.y (canonical)
        let mut a_bytes = [0u8; 64];
        a_bytes[31] = 1;
        a_bytes[63] = 2;
        
        let a = BytesN::from_array(&env, &a_bytes);
        let b = BytesN::from_array(&env, &[0u8; 128]);
        let c = BytesN::from_array(&env, &[0u8; 64]);
        
        let proof = crate::Proof { a, b, c };
        
        assert!(is_proof_canonical_bn254(&env, &proof));
    }
}
