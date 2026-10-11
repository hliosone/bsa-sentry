//! The device must compute every digest itself, from raw fields (security invariant 2).
//! These tests prove the no_std Rust implementation reproduces, byte for byte, the same
//! digests that viem produces — the golden file is shared with TypeScript, and its payment
//! vector was checked against the live on-chain USDC DOMAIN_SEPARATOR.
use bsa_sentry_core::eip712;
use bsa_sentry_core::Keccak;
use serde_json::Value;
use tiny_keccak::{Hasher, Keccak as TinyKeccak};

/// Host implementation of the trait the device fills with the SDK's Keccak256.
struct HostKeccak;

impl Keccak for HostKeccak {
    fn hash(parts: &[&[u8]]) -> [u8; 32] {
        let mut h = TinyKeccak::v256();
        for p in parts {
            h.update(p);
        }
        let mut out = [0u8; 32];
        h.finalize(&mut out);
        out
    }
}

fn fixtures() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/types/fixtures/eip712.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("run `pnpm --filter @bsa-sentry/types fixtures`")).unwrap()
}

fn bytes(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap()
}

fn arr20(s: &str) -> [u8; 20] {
    bytes(s).try_into().unwrap()
}

fn arr32(s: &str) -> [u8; 32] {
    bytes(s).try_into().unwrap()
}

fn u64_of(v: &Value) -> u64 {
    v.as_str().unwrap().parse().unwrap()
}

/// A u256 field recorded as a decimal string, as a big-endian 32-byte word.
fn word_of(v: &Value) -> [u8; 32] {
    let n: u128 = v.as_str().unwrap().parse().unwrap();
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&n.to_be_bytes());
    out
}

#[test]
fn the_payment_digest_matches_the_golden_vector() {
    let f = fixtures();
    let c = &f["payment"];
    let m = &c["message"];
    let got = eip712::payment_digest::<HostKeccak>(
        u64_of(&f["_chainId"].as_u64().map(|n| Value::String(n.to_string())).unwrap()),
        &arr20(c["domain"]["verifyingContract"].as_str().unwrap()),
        &arr20(m["from"].as_str().unwrap()),
        &arr20(m["to"].as_str().unwrap()),
        &word_of(&m["value"]),
        &word_of(&m["validAfter"]),
        &word_of(&m["validBefore"]),
        &arr32(m["nonce"].as_str().unwrap()),
    );
    assert_eq!(hex::encode(got), c["digest"].as_str().unwrap().trim_start_matches("0x"));
}

#[test]
fn the_payment_domain_separator_matches_the_on_chain_one() {
    // c["domainSeparator"] was verified equal to Arc USDC's DOMAIN_SEPARATOR() by
    // scripts/check-domain.ts, so this ties the device's own keccak to the real contract.
    let f = fixtures();
    let c = &f["payment"];
    let got = eip712::usdc_domain_separator::<HostKeccak>(
        f["_chainId"].as_u64().unwrap(),
        &arr20(c["domain"]["verifyingContract"].as_str().unwrap()),
    );
    assert_eq!(hex::encode(got), c["domainSeparator"].as_str().unwrap().trim_start_matches("0x"));
}

#[test]
fn the_login_digest_matches_the_golden_vector() {
    let f = fixtures();
    let c = &f["login"];
    let m = &c["message"];
    let got = eip712::login_digest::<HostKeccak>(
        f["_chainId"].as_u64().unwrap(),
        m["origin"].as_str().unwrap().as_bytes(),
        &arr32(m["nonce"].as_str().unwrap()),
        u64_of(&m["issuedAt"]),
        u64_of(&m["expiresAt"]),
    );
    assert_eq!(hex::encode(got), c["digest"].as_str().unwrap().trim_start_matches("0x"));
}

#[test]
fn the_bind_digest_matches_the_golden_vector() {
    let f = fixtures();
    let c = &f["bind"];
    let m = &c["message"];
    let got = eip712::bind_digest::<HostKeccak>(
        f["_chainId"].as_u64().unwrap(),
        m["verifier"].as_str().unwrap().as_bytes(),
        &arr32(m["session"].as_str().unwrap()),
        u64_of(&m["expiresAt"]),
    );
    assert_eq!(hex::encode(got), c["digest"].as_str().unwrap().trim_start_matches("0x"));
}

#[test]
fn the_delegation_digest_matches_the_golden_vector() {
    let f = fixtures();
    let c = &f["delegation"];
    let m = &c["message"];
    let claims: Vec<&[u8]> = m["claims"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().as_bytes()).collect();
    let got = eip712::delegation_digest::<HostKeccak>(
        f["_chainId"].as_u64().unwrap(),
        &arr20(m["agent"].as_str().unwrap()),
        m["agentName"].as_str().unwrap().as_bytes(),
        &arr32(m["attestation"].as_str().unwrap()),
        &claims,
        u64_of(&m["expiresAt"]),
        &arr32(m["nonce"].as_str().unwrap()),
    );
    assert_eq!(hex::encode(got), c["digest"].as_str().unwrap().trim_start_matches("0x"));
}

#[test]
fn the_age_attestation_digest_matches_the_golden_vector() {
    let f = fixtures();
    let c = &f["ageAttestation"];
    let m = &c["message"];
    let got = eip712::age_attestation_digest::<HostKeccak>(
        f["_chainId"].as_u64().unwrap(),
        &arr20(m["subject"].as_str().unwrap()),
        m["claim"].as_str().unwrap().as_bytes(),
        u64_of(&m["issuedAt"]),
        u64_of(&m["expiresAt"]),
        &arr32(m["evidence"].as_str().unwrap()),
    );
    assert_eq!(hex::encode(got), c["digest"].as_str().unwrap().trim_start_matches("0x"));
}

#[test]
fn a_different_chain_gives_a_different_payment_digest() {
    let f = fixtures();
    let c = &f["payment"];
    let m = &c["message"];
    let args = |chain: u64| {
        eip712::payment_digest::<HostKeccak>(
            chain,
            &arr20(c["domain"]["verifyingContract"].as_str().unwrap()),
            &arr20(m["from"].as_str().unwrap()),
            &arr20(m["to"].as_str().unwrap()),
            &word_of(&m["value"]),
            &word_of(&m["validAfter"]),
            &word_of(&m["validBefore"]),
            &arr32(m["nonce"].as_str().unwrap()),
        )
    };
    assert_ne!(args(5042002), args(84532), "a signature must not be replayable on another chain");
}

#[test]
fn one_different_byte_in_the_recipient_changes_the_digest() {
    let f = fixtures();
    let c = &f["payment"];
    let m = &c["message"];
    let mut to = arr20(m["to"].as_str().unwrap());
    let digest = |to: &[u8; 20]| {
        eip712::payment_digest::<HostKeccak>(
            5042002,
            &arr20(c["domain"]["verifyingContract"].as_str().unwrap()),
            &arr20(m["from"].as_str().unwrap()),
            to,
            &word_of(&m["value"]),
            &word_of(&m["validAfter"]),
            &word_of(&m["validBefore"]),
            &arr32(m["nonce"].as_str().unwrap()),
        )
    };
    let before = digest(&to);
    to[19] ^= 0x01;
    assert_ne!(before, digest(&to));
}

#[test]
fn the_sentry_and_verifier_domains_are_separated() {
    // A Login and an AgeAttestation on the same chain must not share a domain separator,
    // or a signature for one could be presented as the other.
    let login = eip712::sentry_domain_separator::<HostKeccak>(5042002);
    let verifier = eip712::verifier_domain_separator::<HostKeccak>(5042002);
    let usdc = eip712::usdc_domain_separator::<HostKeccak>(5042002, &[0x36; 20]);
    assert_ne!(login, verifier);
    assert_ne!(login, usdc);
    assert_ne!(verifier, usdc);
}

#[test]
fn an_empty_claims_array_hashes_to_the_keccak_of_nothing() {
    // EIP-712 encodes string[] as keccak(concat(keccak(each))). With no elements that is
    // keccak(""), which is the well-known 0xc5d2...a470. Pinning it catches an
    // accidental "hash the length too" change.
    let got = eip712::string_array_hash::<HostKeccak>(&[]);
    assert_eq!(hex::encode(got), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
}
