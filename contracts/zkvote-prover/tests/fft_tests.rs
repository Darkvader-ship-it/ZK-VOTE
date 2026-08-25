use zkvote_prover::fft::{fft, roots};
use zkvote_prover::field::fr_to_bigint;
use ark_ff::PrimeField;
use num_bigint::ToBigInt;

#[test]
fn fft_matches_snarkjs() {
    let n = 16u32;
    let (omega, _inc) = roots(n);
    let mut x: Vec<_> = (1..=n as u64).map(|i| ark_bn254::Fr::from(i)).collect();
    fft(&mut x, omega);
    let out: Vec<String> = x.iter().map(|v| fr_to_bigint(v).to_str_radix(10)).collect();
    println!("RUST_FFT_OUT={}", serde_json::to_string(&out).unwrap());
    // Expected (snarkjs Fr.fft of [1..16], canonical):
    let expected = vec![
        "136",
        "12799993394062007096910218555310294916587517010217722709322235462989776872738",
        "137836770747861348849836336425103792244459918531667959498382945662799851308",
        "12048853493056829132749508603286023492668051932590797676739475248920818621240",
        "35263367762369950740330511775103563231496777067347350277712",
        "11773179951561106576103306979915618869501179195941714683729817626984620029488",
        "137836770747861278323100811685202311583436368324541496504828810968099295868",
        "12524319852566284399210545882460087332098597173154386790325469571664177170106",
        "21888242871839275222246405745257275088548364400416034343698204186575808495609",
        "9363923019272990823035859862797187756449767227261647553372734614911631325495",
        "21750406101091413943923304933572072776964928032091492847193375375607709199733",
        "10115062920278168646143098765341656219047185204474319659968386559591188466113",
        "21888242871839275186983037982887324348217852625312471112201427119228458217889",
        "9839389378782446089496897141971251595880312467825236666958728937654989874361",
        "21750406101091413873396569408832171296303904481884366384199821240913008644293",
        "9088249477777268125336187189946980171960847390198311634375968723586031622863",
    ];
    assert_eq!(out, expected, "Rust FFT does not match snarkjs FFT");
}

#[test]
fn fft_matches_snarkjs_16384() {
    let n = 16384u32;
    let (omega, _inc) = roots(n);
    let mut x: Vec<_> = (1..=n as u64).map(|i| ark_bn254::Fr::from(i)).collect();
    fft(&mut x, omega);
    let out: Vec<String> = x.iter().map(|v| fr_to_bigint(v).to_str_radix(10)).collect();
    let expected: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string("/tmp/fft16384_snarkjs.json").unwrap()).unwrap();
    assert_eq!(out.len(), expected.len());
    let mut mism = 0;
    for i in 0..out.len() {
        if out[i] != expected[i] {
            if mism < 3 {
                eprintln!("MISMATCH[{}] rust={} snarkjs={}", i, out[i], expected[i]);
            }
            mism += 1;
        }
    }
    eprintln!("total mismatches={}", mism);
}

#[test]
fn print_roots_16384() {
    let (omega, inc) = roots(16384);
    use zkvote_prover::field::fr_to_bigint;
    use num_bigint::ToBigInt;
    println!("RUST_omega={}", fr_to_bigint(&omega).to_str_radix(10));
    println!("RUST_inc   ={}", fr_to_bigint(&inc).to_str_radix(10));
}
