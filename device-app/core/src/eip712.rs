//! EIP-712 digests, computed on the device from raw fields.
//!
//! Security invariant 2: there is no "sign this hash" command. Everything the device signs
//! is hashed here, from the fields the host sent, with the type strings compiled in below.
//! The golden vectors in `packages/types/fixtures/eip712.json` are checked by both this
//! crate's host tests and the TypeScript suite, and the payment domain separator was
//! verified against the live on-chain USDC contract.
use crate::Keccak;

const DOMAIN_TYPE_WITH_CONTRACT: &[u8] =
    b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const DOMAIN_TYPE_NO_CONTRACT: &[u8] = b"EIP712Domain(string name,string version,uint256 chainId)";

const USDC_NAME: &[u8] = b"USDC";
const USDC_VERSION: &[u8] = b"2";
const SENTRY_NAME: &[u8] = b"BSA Sentry";
const VERIFIER_NAME: &[u8] = b"BSA Verifier";
const BSA_VERSION: &[u8] = b"1";

const TRANSFER_TYPE: &[u8] = b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
const LOGIN_TYPE: &[u8] = b"Login(string origin,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)";
const BIND_TYPE: &[u8] = b"Bind(string verifier,bytes32 session,uint64 expiresAt)";
const DELEGATION_TYPE: &[u8] = b"AgentDelegation(address agent,string agentName,bytes32 attestation,string[] claims,uint64 expiresAt,bytes32 nonce)";
const AGE_ATTESTATION_TYPE: &[u8] = b"AgeAttestation(address subject,string claim,uint64 issuedAt,uint64 expiresAt,bytes32 evidence)";

/// Left-pads bytes into a 32-byte ABI word.
fn word(bytes: &[u8]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[32 - bytes.len()..].copy_from_slice(bytes);
    w
}

fn u64_word(v: u64) -> [u8; 32] {
    word(&v.to_be_bytes())
}

/// EIP-712 encoding of `string[]`: keccak of the concatenated element hashes.
///
/// Bounded by [`crate::wire::MAX_CLAIMS`] because the device has no allocator; that is also
/// the only place this is used.
pub fn string_array_hash<K: Keccak>(items: &[&[u8]]) -> [u8; 32] {
    let mut hashes = [[0u8; 32]; crate::wire::MAX_CLAIMS];
    let n = if items.len() > crate::wire::MAX_CLAIMS { crate::wire::MAX_CLAIMS } else { items.len() };
    for i in 0..n {
        hashes[i] = K::hash(&[items[i]]);
    }
    // Build the slice-of-slices without allocating.
    let refs: [&[u8]; crate::wire::MAX_CLAIMS] =
        [&hashes[0][..], &hashes[1][..], &hashes[2][..], &hashes[3][..]];
    K::hash(&refs[..n])
}

fn digest<K: Keccak>(domain_separator: &[u8; 32], struct_hash: &[u8; 32]) -> [u8; 32] {
    K::hash(&[&[0x19, 0x01], domain_separator, struct_hash])
}

// ------------------------------------------------------------------ domain separators

pub fn usdc_domain_separator<K: Keccak>(chain_id: u64, verifying_contract: &[u8; 20]) -> [u8; 32] {
    K::hash(&[
        &K::hash(&[DOMAIN_TYPE_WITH_CONTRACT]),
        &K::hash(&[USDC_NAME]),
        &K::hash(&[USDC_VERSION]),
        &u64_word(chain_id),
        &word(verifying_contract),
    ])
}

pub fn sentry_domain_separator<K: Keccak>(chain_id: u64) -> [u8; 32] {
    K::hash(&[
        &K::hash(&[DOMAIN_TYPE_NO_CONTRACT]),
        &K::hash(&[SENTRY_NAME]),
        &K::hash(&[BSA_VERSION]),
        &u64_word(chain_id),
    ])
}

pub fn verifier_domain_separator<K: Keccak>(chain_id: u64) -> [u8; 32] {
    K::hash(&[
        &K::hash(&[DOMAIN_TYPE_NO_CONTRACT]),
        &K::hash(&[VERIFIER_NAME]),
        &K::hash(&[BSA_VERSION]),
        &u64_word(chain_id),
    ])
}

// ------------------------------------------------------------------ digests

/// USDC `TransferWithAuthorization`. `from` is always this device's own 0xAGENT, derived by
/// the caller — never taken from the host.
#[allow(clippy::too_many_arguments)]
pub fn payment_digest<K: Keccak>(
    chain_id: u64,
    token: &[u8; 20],
    from: &[u8; 20],
    to: &[u8; 20],
    value: &[u8; 32],
    valid_after: &[u8; 32],
    valid_before: &[u8; 32],
    nonce: &[u8; 32],
) -> [u8; 32] {
    let struct_hash = K::hash(&[
        &K::hash(&[TRANSFER_TYPE]),
        &word(from),
        &word(to),
        value,
        valid_after,
        valid_before,
        nonce,
    ]);
    digest::<K>(&usdc_domain_separator::<K>(chain_id, token), &struct_hash)
}

pub fn login_digest<K: Keccak>(
    chain_id: u64,
    origin: &[u8],
    nonce: &[u8; 32],
    issued_at: u64,
    expires_at: u64,
) -> [u8; 32] {
    let struct_hash = K::hash(&[
        &K::hash(&[LOGIN_TYPE]),
        &K::hash(&[origin]),
        nonce,
        &u64_word(issued_at),
        &u64_word(expires_at),
    ]);
    digest::<K>(&sentry_domain_separator::<K>(chain_id), &struct_hash)
}

pub fn bind_digest<K: Keccak>(
    chain_id: u64,
    verifier: &[u8],
    session: &[u8; 32],
    expires_at: u64,
) -> [u8; 32] {
    let struct_hash = K::hash(&[
        &K::hash(&[BIND_TYPE]),
        &K::hash(&[verifier]),
        session,
        &u64_word(expires_at),
    ]);
    digest::<K>(&sentry_domain_separator::<K>(chain_id), &struct_hash)
}

pub fn delegation_digest<K: Keccak>(
    chain_id: u64,
    agent: &[u8; 20],
    agent_name: &[u8],
    attestation: &[u8; 32],
    claims: &[&[u8]],
    expires_at: u64,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let struct_hash = K::hash(&[
        &K::hash(&[DELEGATION_TYPE]),
        &word(agent),
        &K::hash(&[agent_name]),
        attestation,
        &string_array_hash::<K>(claims),
        &u64_word(expires_at),
        nonce,
    ]);
    digest::<K>(&sentry_domain_separator::<K>(chain_id), &struct_hash)
}

pub fn age_attestation_digest<K: Keccak>(
    chain_id: u64,
    subject: &[u8; 20],
    claim: &[u8],
    issued_at: u64,
    expires_at: u64,
    evidence: &[u8; 32],
) -> [u8; 32] {
    let struct_hash = K::hash(&[
        &K::hash(&[AGE_ATTESTATION_TYPE]),
        &word(subject),
        &K::hash(&[claim]),
        &u64_word(issued_at),
        &u64_word(expires_at),
        evidence,
    ]);
    digest::<K>(&verifier_domain_separator::<K>(chain_id), &struct_hash)
}
