//! Verify the zkey ccoefs are parsed into the same A/B linear maps as the
//! R1CS file, when applied to the witness. If A_zkey·w * B_zkey·w != C_r1cs·w
//! for some constraint, the ccoefs parsing (or buildABC1) is wrong.

use std::collections::HashMap;
use std::path::PathBuf;
use zkvote_prover::field::{decode_fr_canonical, fr_from_decimal, Fr};
use zkvote_prover::r1cs::{load_witness_decimal, parse_r1cs};
use zkvote_prover::zkey::parse_zkey;
use ark_ff::Zero;

fn repo_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p
}

fn dot(map: &HashMap<usize, Fr>, w: &[Fr]) -> Fr {
    let mut acc = Fr::zero();
    for (idx, coef) in map {
        acc += *coef * w[*idx];
    }
    acc
}

#[test]
fn zkey_coefs_match_r1cs() {
    let root = repo_root();
    let r1cs = parse_r1cs(&root.join("circuits/build/vote.r1cs"));
    let witness = load_witness_decimal(&root.join("circuits/test_witness_vote.json"));

    // R1CS A/B/C maps (canonical coefficients).
    let mut a_r1 = Vec::with_capacity(r1cs.n_constraints);
    let mut b_r1 = Vec::with_capacity(r1cs.n_constraints);
    let mut c_r1 = Vec::with_capacity(r1cs.n_constraints);
    for (ar, br, cr) in &r1cs.constraints {
        let mut am = HashMap::new();
        let mut bm = HashMap::new();
        let mut cm = HashMap::new();
        for (idx, v) in ar {
            am.insert(*idx, *v);
        }
        for (idx, v) in br {
            bm.insert(*idx, *v);
        }
        for (idx, v) in cr {
            cm.insert(*idx, *v);
        }
        a_r1.push(am);
        b_r1.push(bm);
        c_r1.push(cm);
    }

    // zkey ccoefs -> A/B maps.
    let zkey_bytes = std::fs::read(root.join("frontend/public/circuits/vote_final.zkey")).unwrap();
    let pk = parse_zkey(&zkey_bytes).expect("parse zkey");
    let max_c = pk
        .coefs
        .iter()
        .map(|c| c.constraint as usize)
        .max()
        .unwrap_or(0);
    eprintln!(
        "r1cs n_constraints={}, zkey max coef constraint={}",
        r1cs.n_constraints, max_c
    );
    let dim = max_c + 1;
    let mut a_zk = vec![HashMap::new(); dim];
    let mut b_zk = vec![HashMap::new(); dim];
    for coef in &pk.coefs {
        let c = coef.constraint as usize;
        let s = coef.signal as usize;
        match coef.matrix {
            0 => {
                a_zk[c].insert(s, coef.value);
            }
            1 => {
                b_zk[c].insert(s, coef.value);
            }
            _ => {}
        }
    }

    let mut mismatches = 0usize;
    for i in 0..r1cs.n_constraints {
        let ar = dot(&a_r1[i], &witness);
        let br = dot(&b_r1[i], &witness);
        let cr = dot(&c_r1[i], &witness);
        let az = if i <= max_c { dot(&a_zk[i], &witness) } else { ar };
        let bz = if i <= max_c { dot(&b_zk[i], &witness) } else { br };
        // R1CS constraint: ar*br == cr (should hold, verified elsewhere)
        if ar * br != cr {
            eprintln!("r1cs constraint {} violated (unexpected)", i);
        }
        // zkey ccoefs must give the same A·w and B·w as the R1CS.
        if az != ar || bz != br {
            mismatches += 1;
            if mismatches <= 10 {
                eprintln!(
                    "constraint {}: A_zkey·w={} A_r1cs·w={} | B_zkey·w={} B_r1cs·w={}",
                    i,
                    fr_to_dec(&az),
                    fr_to_dec(&ar),
                    fr_to_dec(&bz),
                    fr_to_dec(&br)
                );
            }
        }
    }
    eprintln!("zkey/R1CS A·w,B·w mismatches = {}", mismatches);
    assert_eq!(mismatches, 0, "zkey ccoefs do not match R1CS linear maps");
}

fn fr_to_dec(f: &Fr) -> String {
    use zkvote_prover::field::fr_to_bigint;
    use num_bigint::ToBigInt;
    fr_to_bigint(f).to_str_radix(10)
}
