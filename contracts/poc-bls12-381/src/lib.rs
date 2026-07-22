#![no_std]

use soroban_sdk::{
    contracterror, contracttype,
    crypto::bls12_381::{Bls12381G1Affine, Bls12381G2Affine, Fr},
    Bytes, BytesN, Env, IntoVal, TryFromVal, Val, Vec, U256,
};

pub const BLS12_381_FR_MODULUS: [u8; 32] = [
    0x73, 0xed, 0xa7, 0x53, 0x29, 0x9d, 0x7d, 0x48, 0x33, 0x39, 0xd8, 0x08, 0x09, 0xa1, 0xd8, 0x05,
    0x53, 0xbd, 0xa4, 0x02, 0xff, 0xfe, 0x5b, 0xfe, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01,
];

#[contracterror]
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum Groth16Error {
    IcLengthMismatch = 30,
    SignalNotInField = 31,
    InvalidNullifier = 32,
}

#[contracttype]
#[derive(Clone)]
pub struct VerificationKey {
    pub alpha: BytesN<96>,
    pub beta: BytesN<192>,
    pub gamma: BytesN<192>,
    pub delta: BytesN<192>,
    pub ic: Vec<BytesN<96>>,
}

#[contracttype]
#[derive(Clone)]
pub struct Proof {
    pub a: BytesN<96>,
    pub b: BytesN<192>,
    pub c: BytesN<96>,
}

pub trait Groth16Curve {
    type G1: IntoVal<Env, Val> + TryFromVal<Env, Val> + Clone;
    type G2: IntoVal<Env, Val> + TryFromVal<Env, Val> + Clone;
    type Fr: IntoVal<Env, Val> + TryFromVal<Env, Val> + Clone;

    fn scalar_field_modulus() -> [u8; 32];
    fn g1_serialized_size() -> usize;
    fn g2_serialized_size() -> usize;
    fn g1_from_bytes(bytes: &BytesN<96>) -> Self::G1;
    fn g2_from_bytes(bytes: &BytesN<192>) -> Self::G2;
    fn fr_from_u256(value: &U256) -> Self::Fr;
    fn g1_add(env: &Env, a: &Self::G1, b: &Self::G1) -> Self::G1;
    fn g1_mul(env: &Env, point: &Self::G1, scalar: &Self::Fr) -> Self::G1;
    fn g1_neg(point: &Self::G1) -> Self::G1;
    fn pairing_check(env: &Env, g1: Vec<Self::G1>, g2: Vec<Self::G2>) -> bool;
}

pub struct Bls12381Curve;

impl Groth16Curve for Bls12381Curve {
    type G1 = Bls12381G1Affine;
    type G2 = Bls12381G2Affine;
    type Fr = Fr;

    fn scalar_field_modulus() -> [u8; 32] { BLS12_381_FR_MODULUS }
    fn g1_serialized_size() -> usize { 96 }
    fn g2_serialized_size() -> usize { 192 }

    fn g1_from_bytes(bytes: &BytesN<96>) -> Self::G1 {
        Bls12381G1Affine::from_bytes(bytes.clone())
    }
    fn g2_from_bytes(bytes: &BytesN<192>) -> Self::G2 {
        Bls12381G2Affine::from_bytes(bytes.clone())
    }
    fn fr_from_u256(value: &U256) -> Self::Fr { Fr::from(value.clone()) }
    fn g1_add(env: &Env, a: &Self::G1, b: &Self::G1) -> Self::G1 {
        env.crypto().bls12_381().g1_add(a, b)
    }
    fn g1_mul(env: &Env, point: &Self::G1, scalar: &Self::Fr) -> Self::G1 {
        env.crypto().bls12_381().g1_mul(point, scalar)
    }
    fn g1_neg(point: &Self::G1) -> Self::G1 {
        -point.clone()
    }
    fn pairing_check(env: &Env, g1: Vec<Self::G1>, g2: Vec<Self::G2>) -> bool {
        env.crypto().bls12_381().pairing_check(g1, g2)
    }
}

pub fn assert_in_field<C: Groth16Curve>(env: &Env, value: &U256) -> Result<(), Groth16Error> {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &C::scalar_field_modulus()));
    if value >= &modulus {
        return Err(Groth16Error::SignalNotInField);
    }
    Ok(())
}

pub fn verify_groth16<C: Groth16Curve>(
    env: &Env,
    vk: &VerificationKey,
    proof: &Proof,
    pub_signals: &Vec<U256>,
) -> bool {
    if pub_signals.len() + 1 != vk.ic.len() {
        return false;
    }

    let vk_x = compute_vk_x::<C>(env, vk, pub_signals);

    let a_point = C::g1_from_bytes(&proof.a);
    let neg_a = C::g1_neg(&a_point);

    let mut g1_vec: Vec<C::G1> = Vec::new(env);
    g1_vec.push_back(neg_a);
    g1_vec.push_back(C::g1_from_bytes(&vk.alpha));
    g1_vec.push_back(vk_x);
    g1_vec.push_back(C::g1_from_bytes(&proof.c));

    let mut g2_vec: Vec<C::G2> = Vec::new(env);
    g2_vec.push_back(C::g2_from_bytes(&proof.b));
    g2_vec.push_back(C::g2_from_bytes(&vk.beta));
    g2_vec.push_back(C::g2_from_bytes(&vk.gamma));
    g2_vec.push_back(C::g2_from_bytes(&vk.delta));

    C::pairing_check(env, g1_vec, g2_vec)
}

fn compute_vk_x<C: Groth16Curve>(
    env: &Env,
    vk: &VerificationKey,
    pub_signals: &Vec<U256>,
) -> C::G1 {
    let ic0 = vk.ic.get(0).expect("IC[0] missing");
    let mut vk_x = C::g1_from_bytes(&ic0);

    for i in 0..pub_signals.len() {
        let signal = pub_signals.get(i).expect("signal missing");
        let ic_point_bytes = vk.ic.get(i + 1).expect("IC point missing");
        let ic_point = C::g1_from_bytes(&ic_point_bytes);
        let scalar = C::fr_from_u256(&signal);
        let scaled_point = C::g1_mul(env, &ic_point, &scalar);
        vk_x = C::g1_add(env, &vk_x, &scaled_point);
    }

    vk_x
}

pub fn verify_groth16_bls12_381(
    env: &Env,
    vk: &VerificationKey,
    proof: &Proof,
    pub_signals: &Vec<U256>,
) -> bool {
    verify_groth16::<Bls12381Curve>(env, vk, proof, pub_signals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scalar_field_modulus_matches_sdk() {
        let env = Env::default();
        let r = U256::from_be_bytes(&env, &Bytes::from_array(&env, &BLS12_381_FR_MODULUS));
        let r_minus_1 = r.sub(&U256::from_u32(&env, 1));

        let fr = Fr::from(r_minus_1.clone());
        assert_eq!(fr.to_u256(), r_minus_1);

        let fr_at_r = Fr::from(r);
        assert_eq!(fr_at_r, Fr::from(U256::from_u32(&env, 0)));
    }

    #[test]
    fn test_assert_in_field_valid() {
        let env = Env::default();
        let val = U256::from_u32(&env, 42);
        assert!(assert_in_field::<Bls12381Curve>(&env, &val).is_ok());
    }

    #[test]
    fn test_assert_in_field_at_modulus_rejected() {
        let env = Env::default();
        let r = U256::from_be_bytes(&env, &Bytes::from_array(&env, &BLS12_381_FR_MODULUS));
        assert_eq!(
            assert_in_field::<Bls12381Curve>(&env, &r),
            Err(Groth16Error::SignalNotInField)
        );
    }

    #[test]
    fn test_g1_curve_ops_roundtrip() {
        let env = Env::default();
        let bls = env.crypto().bls12_381();

        let mut inf_bytes = [0u8; 96];
        inf_bytes[0] = 0x40;
        let g1_inf = Bls12381G1Affine::from_bytes(BytesN::from_array(&env, &inf_bytes));
        let neg_inf = -g1_inf.clone();
        let sum = bls.g1_add(&g1_inf, &neg_inf);
        assert_eq!(sum, g1_inf);
    }

    #[test]
    fn test_fr_ops() {
        let env = Env::default();
        let bls = env.crypto().bls12_381();

        let a = Fr::from(U256::from_u32(&env, 5));
        let b = Fr::from(U256::from_u32(&env, 3));
        let sum = bls.fr_add(&a, &b);
        assert_eq!(sum.to_u256(), U256::from_u32(&env, 8));

        let diff = bls.fr_sub(&a, &b);
        assert_eq!(diff.to_u256(), U256::from_u32(&env, 2));

        let prod = bls.fr_mul(&a, &b);
        assert_eq!(prod.to_u256(), U256::from_u32(&env, 15));
    }

    #[test]
    fn test_verify_groth16_ic_mismatch() {
        let env = Env::default();
        let vk = VerificationKey {
            alpha: BytesN::from_array(&env, &[0u8; 96]),
            beta: BytesN::from_array(&env, &[0u8; 192]),
            gamma: BytesN::from_array(&env, &[0u8; 192]),
            delta: BytesN::from_array(&env, &[0u8; 192]),
            ic: soroban_sdk::vec![&env, BytesN::from_array(&env, &[0u8; 96])],
        };
        let proof = Proof {
            a: BytesN::from_array(&env, &[0u8; 96]),
            b: BytesN::from_array(&env, &[0u8; 192]),
            c: BytesN::from_array(&env, &[0u8; 96]),
        };
        let signals = soroban_sdk::vec![&env, U256::from_u32(&env, 1), U256::from_u32(&env, 2)];
        assert!(!verify_groth16_bls12_381(&env, &vk, &proof, &signals));
    }
}
