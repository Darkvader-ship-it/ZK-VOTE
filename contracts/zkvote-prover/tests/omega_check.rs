use zkvote_prover::fft::roots;
use zkvote_prover::field::{fr_to_bigint, Fr};
use ark_ff::Field;

#[test]
fn omega_props() {
    let (omega, inc) = roots(16384);
    let om_pow = <Fr as Field>::pow(&omega, &[16384u64]);
    let om_pow2 = <Fr as Field>::pow(&omega, &[8192u64]);
    println!("omega        = {}", fr_to_bigint(&omega).to_str_radix(10));
    println!("omega^16384  = {}", fr_to_bigint(&om_pow).to_str_radix(10));
    println!("omega^8192   = {}", fr_to_bigint(&om_pow2).to_str_radix(10));
    println!("inc          = {}", fr_to_bigint(&inc).to_str_radix(10));
    println!("snarkjs_w14  = 11180509844185199060961252138099753092805977971516267686274789520586703248420");
    println!("snarkjs_w15  = 6122777754476919152733333388743975044597465264009190878264670965754962606069");
    assert!(false, "print only");
}
