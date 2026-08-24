//! Diagnostic: validate the generated witness satisfies the compiled R1CS.

use std::path::PathBuf;
use zkvote_prover::r1cs::{check_witness, load_witness_decimal, parse_r1cs};

fn repo_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p
}

#[test]
fn witness_satisfies_r1cs() {
    let root = repo_root();
    let r1cs_path = root.join("circuits/build/vote.r1cs");
    let wit_path = root.join("circuits/test_witness_vote.json");
    assert!(
        r1cs_path.exists(),
        "vote.r1cs missing; run `circom circuits/vote.circom ...`"
    );
    assert!(
        wit_path.exists(),
        "test_witness_vote.json missing; run scripts/gen_witness.js"
    );

    let r1cs = parse_r1cs(&r1cs_path);
    eprintln!(
        "r1cs: n_vars={} n_public={} n_constraints={}",
        r1cs.n_vars, r1cs.n_public, r1cs.n_constraints
    );
    let witness = load_witness_decimal(&wit_path);
    eprintln!("witness len = {}", witness.len());

    let violations = check_witness(&r1cs, &witness);
    eprintln!("constraint violations = {}", violations);
    assert_eq!(violations, 0, "witness does not satisfy R1CS");
}
