#![cfg_attr(feature = "testutils", allow(dead_code, unused_imports))]

use ark_bn254::{Fq, Fq2, Fr, G2Affine as ArkG2Affine};
use ark_ec::{AffineRepr, CurveGroup};
use ark_ff::{BigInteger, PrimeField};
use soroban_sdk::{Bytes, BytesN, Env, Vec, U256};
use zkvote_groth16::{verify_groth16, Proof, VerificationKey, BN254_FR_MODULUS};

const BN254_FP_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Outcome {
    Accepted,
    Rejected,
    Panicked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Expectation {
    Accept,
    Reject,
    Observe,
}

struct EdgeCase {
    name: &'static str,
    expectation: Expectation,
    proof: Proof,
    vk: VerificationKey,
    public_signals: Vec<U256>,
}

fn hex_to_bytes<const N: usize>(env: &Env, hex: &str) -> BytesN<N> {
    let bytes = hex::decode(hex).expect("invalid hex");
    assert_eq!(bytes.len(), N, "hex string wrong length");
    BytesN::from_array(env, &bytes.try_into().unwrap())
}

fn hex_str_to_u256(env: &Env, hex: &str) -> U256 {
    let bytes = hex::decode(hex).expect("invalid hex");
    let mut padded = [0u8; 32];
    let start = 32 - bytes.len();
    padded[start..].copy_from_slice(&bytes);
    U256::from_be_bytes(env, &Bytes::from_array(env, &padded))
}

fn u256_from_be(env: &Env, bytes: [u8; 32]) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, &bytes))
}

fn add_u32(env: &Env, value: &U256, delta: u32) -> U256 {
    value.add(&U256::from_u32(env, delta))
}

fn proof_from_arrays(env: &Env, a: [u8; 64], b: [u8; 128], c: [u8; 64]) -> Proof {
    Proof {
        a: BytesN::from_array(env, &a),
        b: BytesN::from_array(env, &b),
        c: BytesN::from_array(env, &c),
    }
}

fn proof_with_a(env: &Env, proof: &Proof, a: [u8; 64]) -> Proof {
    proof_from_arrays(env, a, proof.b.to_array(), proof.c.to_array())
}

fn proof_with_b(env: &Env, proof: &Proof, b: [u8; 128]) -> Proof {
    proof_from_arrays(env, proof.a.to_array(), b, proof.c.to_array())
}

fn proof_with_c(env: &Env, proof: &Proof, c: [u8; 64]) -> Proof {
    proof_from_arrays(env, proof.a.to_array(), proof.b.to_array(), c)
}

fn flip<const N: usize>(mut bytes: [u8; N], offset: usize, mask: u8) -> [u8; N] {
    bytes[offset] ^= mask;
    bytes
}

fn fill<const N: usize>(value: u8) -> [u8; N] {
    [value; N]
}

fn repeated_coordinate<const N: usize>(coord: [u8; 32]) -> [u8; N] {
    let mut out = [0u8; N];
    for chunk in out.chunks_exact_mut(32) {
        chunk.copy_from_slice(&coord);
    }
    out
}

fn g1_point(x: [u8; 32], y: [u8; 32]) -> [u8; 64] {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&x);
    out[32..].copy_from_slice(&y);
    out
}

fn g1_negate_y(mut point: [u8; 64]) -> [u8; 64] {
    let y = &point[32..64];
    if y.iter().all(|b| *b == 0) {
        return point;
    }
    if y == BN254_FP_MODULUS.as_slice() {
        point[32..64].fill(0);
        return point;
    }

    let mut neg_y = [0u8; 32];
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let lhs = BN254_FP_MODULUS[i] as u16;
        let rhs = y[i] as u16 + borrow;
        if lhs >= rhs {
            neg_y[i] = (lhs - rhs) as u8;
            borrow = 0;
        } else {
            neg_y[i] = (lhs + 256 - rhs) as u8;
            borrow = 1;
        }
    }
    point[32..64].copy_from_slice(&neg_y);
    point
}

fn fq_to_be(fq: &Fq) -> [u8; 32] {
    let bytes = fq.into_bigint().to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

fn g2_to_soroban_bytes(point: &ArkG2Affine) -> [u8; 128] {
    let (x, y) = point.xy().expect("non-infinity G2 point");
    let mut out = [0u8; 128];

    // Soroban BN254 follows Ethereum Fp2 byte order: c1 || c0, big-endian.
    out[0..32].copy_from_slice(&fq_to_be(&x.c1));
    out[32..64].copy_from_slice(&fq_to_be(&x.c0));
    out[64..96].copy_from_slice(&fq_to_be(&y.c1));
    out[96..128].copy_from_slice(&fq_to_be(&y.c0));
    out
}

fn deterministic_g2_torsion_bytes() -> [u8; 128] {
    for seed in 1u64..1024 {
        let x = Fq2::new(Fq::from(seed), Fq::from(seed + 1));
        for greatest in [false, true] {
            let Some(full_curve_point) = ArkG2Affine::get_point_from_x_unchecked(x, greatest)
            else {
                continue;
            };
            if full_curve_point.is_in_correct_subgroup_assuming_on_curve() {
                continue;
            }

            let torsion = full_curve_point.mul_bigint(Fr::MODULUS).into_affine();
            if torsion.is_zero()
                || !torsion.is_on_curve()
                || torsion.is_in_correct_subgroup_assuming_on_curve()
            {
                continue;
            }

            let cofactor_cleared = torsion
                .mul_bigint(<ark_bn254::g2::Config as ark_ec::CurveConfig>::COFACTOR)
                .into_affine();
            assert!(cofactor_cleared.is_zero(), "fixture must be h-torsion");
            return g2_to_soroban_bytes(&torsion);
        }
    }

    panic!("failed to construct deterministic BN254 G2 torsion fixture");
}

fn real_proof(env: &Env) -> Proof {
    Proof {
        a: hex_to_bytes(
            env,
            "02de5951501fe4408ea8bf4960106738d190525a270fe0b035139aac2fa762302bbb2f3f1d001d99b919a34b93a9aed831e7bd1f960d5981ae328dfd1845b8a8",
        ),
        b: hex_to_bytes(
            env,
            "2a47ed5deedaad3fe569ea39131c2800f9eead79402a3fc02a6a03e8871d0ae5186d064bc81ecb41f386eb427b70f18fb42e088eb477042681fc926ce75dc4de1cb57584e640e98d0cc2a33cdfd2403bd97cd17b6018549a6c2fd34941b19f1219e3d80a0f9f99c5f74a36d2903ef10d3ba6bbb2f61e6be2072c606510f71e4d",
        ),
        c: hex_to_bytes(
            env,
            "04dac3300843dbeef12b08362d2a98110fa9080346cff63cc8698fb97d48adcb2faeacd5f1e4b5c37664f6fcb7c67ead0cd789e2db580867dcca345799517ca2",
        ),
    }
}

fn real_vk(env: &Env) -> VerificationKey {
    let mut ic = Vec::new(env);
    ic.push_back(hex_to_bytes(env, "0386c87c5f77037451fea91c60759229ca390a30e60d564e5ff0f0f95ffbd18207683040dab753f41635f947d3d13e057c73cb92a38d83400af26019ce24d54f"));
    ic.push_back(hex_to_bytes(env, "0b8de6c132c626e6aa4676f7ca94d9ebeb93375ea3584b6337f9f823ac4157dd0b3de52288f2f4473c0c5041cf9a754decd57e2c0f6b2979d3467a30570c01ea"));
    ic.push_back(hex_to_bytes(env, "139bde66aa5aa4311aca037419840a70fed606a0ed112e6686e1feb44183672d0e56114fa301c02ab1f0baac0973de2759bf26ccbbc594f8627054001f8ad27a"));
    ic.push_back(hex_to_bytes(env, "2a7f1a9e3de9411015b1c5652856bc7a467110344153252026c44ca55f5dca632f0db38e6d0268092cba5ea0b5db9610e45bd8b4aac852527aeb6323c8f09804"));
    ic.push_back(hex_to_bytes(env, "09c5b9b793a6f8098f0ac918aa0a19a75b74e7f1428f726194a48af37da8ac14122edc5b3704f106fa3c095ac74f524032e460179c3e8ecd562ef050c884336a"));
    ic.push_back(hex_to_bytes(env, "143c06565aad1cacd0ddbc0cfc6dd131c70392d29c16d8c80ed7f62ada52587b13e189e68fe2fe8806b272da3c5762a18b23680cdeda63faef014b7dd6806f21"));

    VerificationKey {
        alpha: hex_to_bytes(env, "2d4d9aa7e302d9df41749d5507949d05dbea33fbb16c643b22f599a2be6df2e214bedd503c37ceb061d8ec60209fe345ce89830a19230301f076caff004d1926"),
        beta: hex_to_bytes(env, "0967032fcbf776d1afc985f88877f182d38480a653f2decaa9794cbc3bf3060c0e187847ad4c798374d0d6732bf501847dd68bc0e071241e0213bc7fc13db7ab304cfbd1e08a704a99f5e847d93f8c3caafddec46b7a0d379da69a4d112346a71739c1b1a457a8c7313123d24d2f9192f896b7c63eea05a9d57f06547ad0cec8"),
        gamma: hex_to_bytes(env, "198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c21800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa"),
        delta: hex_to_bytes(env, "0d633d289456016e0c0e975e7da2d19153ca3b6a74dd83331df6407a68d9e9f81ff0cfb2f48375ed6c03370d8a55e25777a3fb3f6c748bb9e83116bf19ef6385062ce3e273c849fdc51bb2cf34308828862f248134512541fde080ed08d0eb4016cef3c53afe73c871cd493e46139da661ed0d2875fd63c8044c38a68b4caec5"),
        ic,
    }
}

fn real_public_signals(env: &Env) -> Vec<U256> {
    let mut signals = Vec::new(env);
    signals.push_back(hex_str_to_u256(
        env,
        "1351d0946e3542884587d25ba93bdc24ad5586b76440e1c0cd7b0a04ead3b0c5",
    ));
    signals.push_back(hex_str_to_u256(
        env,
        "13a7e6da6794bd6f61ffeba529ec3f1c97c52bf862c4c63bcda069f435be8267",
    ));
    signals.push_back(U256::from_u32(env, 1));
    signals.push_back(U256::from_u32(env, 1));
    signals.push_back(U256::from_u32(env, 1));
    signals
}

fn set_signal(mut signals: Vec<U256>, index: u32, value: U256) -> Vec<U256> {
    signals.set(index, value);
    signals
}

fn vk_with_alpha(env: &Env, vk: &VerificationKey, alpha: [u8; 64]) -> VerificationKey {
    let mut out = vk.clone();
    out.alpha = BytesN::from_array(env, &alpha);
    out
}

fn vk_with_g2(
    env: &Env,
    vk: &VerificationKey,
    field: &'static str,
    bytes: [u8; 128],
) -> VerificationKey {
    let mut out = vk.clone();
    let point = BytesN::from_array(env, &bytes);
    match field {
        "beta" => out.beta = point,
        "gamma" => out.gamma = point,
        "delta" => out.delta = point,
        _ => panic!("unknown g2 field"),
    }
    out
}

fn vk_with_ic(env: &Env, vk: &VerificationKey, index: u32, point: [u8; 64]) -> VerificationKey {
    let mut out = vk.clone();
    out.ic.set(index, BytesN::from_array(env, &point));
    out
}

fn run_case(env: &Env, case: &EdgeCase) -> Outcome {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        verify_groth16(env, &case.vk, &case.proof, &case.public_signals)
    }));
    match result {
        Ok(true) => Outcome::Accepted,
        Ok(false) => Outcome::Rejected,
        Err(_) => Outcome::Panicked,
    }
}

#[cfg(not(feature = "testutils"))]
#[test]
fn bn254_edge_case_corpus_rejects_malformed_proofs_and_documents_boundary() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();

    let proof = real_proof(&env);
    let vk = real_vk(&env);
    let signals = real_public_signals(&env);
    let zero_g1 = [0u8; 64];
    let zero_g2 = [0u8; 128];
    let g2_torsion = deterministic_g2_torsion_bytes();
    let fp_coord = BN254_FP_MODULUS;
    let fr = u256_from_be(&env, BN254_FR_MODULUS);
    let root = signals.get(0).unwrap();
    let nullifier = signals.get(1).unwrap();

    let mut cases = std::vec![EdgeCase {
        name: "control_valid_real_proof",
        expectation: Expectation::Accept,
        proof: proof.clone(),
        vk: vk.clone(),
        public_signals: signals.clone(),
    }];

    cases.extend(
        [
            ("proof_a_infinity", proof_with_a(&env, &proof, zero_g1)),
            ("proof_c_infinity", proof_with_c(&env, &proof, zero_g1)),
            ("proof_b_infinity", proof_with_b(&env, &proof, zero_g2)),
            (
                "proof_b_non_subgroup_g2_torsion",
                proof_with_b(&env, &proof, g2_torsion),
            ),
            (
                "proof_all_points_infinity",
                proof_from_arrays(&env, zero_g1, zero_g2, zero_g1),
            ),
            (
                "proof_a_coordinate_at_fp_modulus",
                proof_with_a(&env, &proof, g1_point(fp_coord, [1u8; 32])),
            ),
            (
                "proof_c_coordinate_at_fp_modulus",
                proof_with_c(&env, &proof, g1_point([1u8; 32], fp_coord)),
            ),
            (
                "proof_b_coordinates_at_fp_modulus",
                proof_with_b(&env, &proof, repeated_coordinate(fp_coord)),
            ),
            ("proof_a_all_ff", proof_with_a(&env, &proof, fill(0xff))),
            ("proof_b_all_ff", proof_with_b(&env, &proof, fill(0xff))),
            ("proof_c_all_ff", proof_with_c(&env, &proof, fill(0xff))),
            (
                "proof_a_negated_y",
                proof_with_a(&env, &proof, g1_negate_y(proof.a.to_array())),
            ),
            (
                "proof_c_negated_y",
                proof_with_c(&env, &proof, g1_negate_y(proof.c.to_array())),
            ),
            (
                "proof_a_c_swapped_a",
                proof_from_arrays(
                    &env,
                    proof.c.to_array(),
                    proof.b.to_array(),
                    proof.a.to_array(),
                ),
            ),
        ]
        .into_iter()
        .map(|(name, proof)| EdgeCase {
            name,
            expectation: Expectation::Reject,
            proof,
            vk: vk.clone(),
            public_signals: signals.clone(),
        }),
    );

    for offset in [0usize, 1, 2, 15, 31, 32, 33, 48, 63] {
        cases.push(EdgeCase {
            name: "proof_a_single_byte_flip",
            expectation: Expectation::Reject,
            proof: proof_with_a(&env, &proof, flip(proof.a.to_array(), offset, 0x01)),
            vk: vk.clone(),
            public_signals: signals.clone(),
        });
    }

    for offset in [0usize, 1, 2, 31, 32, 33, 63, 64, 65, 95, 96, 97, 126, 127] {
        cases.push(EdgeCase {
            name: "proof_b_single_byte_flip",
            expectation: Expectation::Reject,
            proof: proof_with_b(&env, &proof, flip(proof.b.to_array(), offset, 0x01)),
            vk: vk.clone(),
            public_signals: signals.clone(),
        });
    }

    for offset in [0usize, 1, 2, 15, 31, 32, 33, 48, 63] {
        cases.push(EdgeCase {
            name: "proof_c_single_byte_flip",
            expectation: Expectation::Reject,
            proof: proof_with_c(&env, &proof, flip(proof.c.to_array(), offset, 0x01)),
            vk: vk.clone(),
            public_signals: signals.clone(),
        });
    }

    cases.extend([
        EdgeCase {
            name: "signal_root_plus_one",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk.clone(),
            public_signals: set_signal(signals.clone(), 0, add_u32(&env, &root, 1)),
        },
        EdgeCase {
            name: "signal_nullifier_plus_one",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk.clone(),
            public_signals: set_signal(signals.clone(), 1, add_u32(&env, &nullifier, 1)),
        },
        EdgeCase {
            name: "signal_wrong_dao_id",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk.clone(),
            public_signals: set_signal(signals.clone(), 2, U256::from_u32(&env, 2)),
        },
        EdgeCase {
            name: "signal_wrong_proposal_id",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk.clone(),
            public_signals: set_signal(signals.clone(), 3, U256::from_u32(&env, 2)),
        },
        EdgeCase {
            name: "signal_wrong_vote_choice",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk.clone(),
            public_signals: set_signal(signals.clone(), 4, U256::from_u32(&env, 0)),
        },
        EdgeCase {
            name: "signal_root_at_fr_modulus_observed_caller_guarded",
            expectation: Expectation::Observe,
            proof: proof.clone(),
            vk: vk.clone(),
            public_signals: set_signal(signals.clone(), 0, fr.clone()),
        },
        EdgeCase {
            name: "signal_nullifier_at_fr_modulus_observed_caller_guarded",
            expectation: Expectation::Observe,
            proof: proof.clone(),
            vk: vk.clone(),
            public_signals: set_signal(signals.clone(), 1, fr),
        },
    ]);

    cases.extend([
        EdgeCase {
            name: "vk_alpha_infinity",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_alpha(&env, &vk, zero_g1),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_beta_infinity",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_g2(&env, &vk, "beta", zero_g2),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_gamma_infinity",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_g2(&env, &vk, "gamma", zero_g2),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_delta_infinity",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_g2(&env, &vk, "delta", zero_g2),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_ic0_infinity",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_ic(&env, &vk, 0, zero_g1),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_ic_duplicate_entry",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_ic(&env, &vk, 5, vk.ic.get(1).unwrap().to_array()),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_beta_non_subgroup_g2_torsion",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_g2(&env, &vk, "beta", g2_torsion),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_gamma_non_subgroup_g2_torsion",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_g2(&env, &vk, "gamma", g2_torsion),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_delta_non_subgroup_g2_torsion",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_g2(&env, &vk, "delta", g2_torsion),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_alpha_coordinate_at_fp_modulus",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_alpha(&env, &vk, g1_point(fp_coord, [1u8; 32])),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_beta_coordinates_at_fp_modulus",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_g2(&env, &vk, "beta", repeated_coordinate(fp_coord)),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_gamma_coordinates_at_fp_modulus",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_g2(&env, &vk, "gamma", repeated_coordinate(fp_coord)),
            public_signals: signals.clone(),
        },
        EdgeCase {
            name: "vk_delta_coordinates_at_fp_modulus",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_g2(&env, &vk, "delta", repeated_coordinate(fp_coord)),
            public_signals: signals.clone(),
        },
    ]);

    for offset in [0usize, 31, 32, 63] {
        cases.push(EdgeCase {
            name: "vk_alpha_single_byte_flip",
            expectation: Expectation::Reject,
            proof: proof.clone(),
            vk: vk_with_alpha(&env, &vk, flip(vk.alpha.to_array(), offset, 0x01)),
            public_signals: signals.clone(),
        });
    }

    for (field, point) in [
        ("beta", vk.beta.to_array()),
        ("gamma", vk.gamma.to_array()),
        ("delta", vk.delta.to_array()),
    ] {
        for offset in [0usize, 31, 32, 63, 64, 95, 96, 127] {
            cases.push(EdgeCase {
                name: "vk_g2_single_byte_flip",
                expectation: Expectation::Reject,
                proof: proof.clone(),
                vk: vk_with_g2(&env, &vk, field, flip(point, offset, 0x01)),
                public_signals: signals.clone(),
            });
        }
    }

    let mut short_ic_vk = vk.clone();
    short_ic_vk.ic.pop_back();
    cases.push(EdgeCase {
        name: "vk_ic_too_short",
        expectation: Expectation::Reject,
        proof: proof.clone(),
        vk: short_ic_vk,
        public_signals: signals.clone(),
    });

    let mut long_ic_vk = vk.clone();
    long_ic_vk.ic.push_back(vk.ic.get(0).unwrap());
    cases.push(EdgeCase {
        name: "vk_ic_too_long",
        expectation: Expectation::Reject,
        proof,
        vk: long_ic_vk,
        public_signals: signals,
    });

    assert!(
        cases.len() >= 51,
        "corpus must include the control plus at least 50 edge cases"
    );

    let mut accepted_observed = std::vec![];
    for case in cases.iter() {
        let outcome = run_case(&env, case);
        println!("{}: {:?}", case.name, outcome);
        match case.expectation {
            Expectation::Accept => assert_eq!(outcome, Outcome::Accepted, "{}", case.name),
            Expectation::Reject => assert_ne!(outcome, Outcome::Accepted, "{}", case.name),
            Expectation::Observe => {
                if outcome == Outcome::Accepted {
                    accepted_observed.push(case.name);
                }
            }
        }
    }

    println!(
        "Observed caller-guarded accepted cases: {:?}",
        accepted_observed
    );
}

#[cfg(not(feature = "testutils"))]
#[test]
fn production_path_rejects_known_bad_proof() {
    let env = Env::default();
    env.cost_estimate().budget().reset_unlimited();

    let proof = real_proof(&env);
    let case = EdgeCase {
        name: "production_known_bad_proof_a_zero",
        expectation: Expectation::Reject,
        proof: proof_with_a(&env, &proof, [0u8; 64]),
        vk: real_vk(&env),
        public_signals: real_public_signals(&env),
    };

    assert_ne!(run_case(&env, &case), Outcome::Accepted);
}

#[test]
fn g1_negate_y_handles_zero_and_modulus_boundaries() {
    let zero_y = g1_point([1u8; 32], [0u8; 32]);
    assert_eq!(g1_negate_y(zero_y), zero_y);

    let modulus_y = g1_point([1u8; 32], BN254_FP_MODULUS);
    let negated = g1_negate_y(modulus_y);
    assert_eq!(&negated[32..64], &[0u8; 32]);
}

#[cfg(feature = "testutils")]
#[test]
fn testutils_feature_uses_stubbed_verifier() {
    let env = Env::default();
    let proof = real_proof(&env);
    let case = EdgeCase {
        name: "testutils_stub_accepts_bad_proof_with_valid_shape",
        expectation: Expectation::Accept,
        proof: proof_with_a(&env, &proof, [0u8; 64]),
        vk: real_vk(&env),
        public_signals: real_public_signals(&env),
    };

    assert_eq!(run_case(&env, &case), Outcome::Accepted);
}
