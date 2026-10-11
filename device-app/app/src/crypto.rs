//! Key derivation and signing. The only two paths this app will ever derive.
use crate::AppSW;
use bsa_sentry_core::Keccak;
use crate::keccak::DeviceKeccak;
use ledger_device_sdk::ecc::{Secp256k1, SeedDerive};

/// `m/44'/60'/0'/0/0` — the user's identity. Signs only Login, Bind and AgentDelegation,
/// always with a tap. Never a transfer (security invariant 5).
pub const PATH_MAIN: [u32; 5] = [0x8000_002C, 0x8000_003C, 0x8000_0000, 0, 0];
/// `m/44'/60'/1'/0/0` — the agent. Signs EIP-3009 payments under the policy.
pub const PATH_AGENT: [u32; 5] = [0x8000_002C, 0x8000_003C, 0x8000_0001, 0, 0];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Account {
    Main,
    Agent,
}

impl Account {
    pub fn path(self) -> &'static [u32; 5] {
        match self {
            Account::Main => &PATH_MAIN,
            Account::Agent => &PATH_AGENT,
        }
    }
}

/// The 20-byte EVM address of an account: last 20 bytes of keccak(uncompressed pubkey[1..]).
pub fn address(account: Account) -> Result<[u8; 20], AppSW> {
    let (k, _) = Secp256k1::derive_from(account.path());
    let pk = k.public_key().map_err(|_| AppSW::KeyDeriveFail)?;
    let hash = DeviceKeccak::hash(&[&pk.pubkey[1..]]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..]);
    Ok(addr)
}

/// Signs a 32-byte digest, returning `v | r | s` in Ethereum form.
///
/// The digest is always one this app computed itself from raw fields; there is no command
/// that signs a host-supplied hash (security invariant 2).
pub fn sign_digest(account: Account, digest: &[u8; 32]) -> Result<[u8; 65], AppSW> {
    let (sig, siglen, parity) = Secp256k1::derive_from(account.path())
        .0
        .deterministic_sign(digest)
        .map_err(|_| AppSW::TxSignFail)?;
    let (r, s) = der_to_rs(&sig[..siglen as usize])?;
    let mut out = [0u8; 65];
    out[0] = 27 + parity as u8;
    out[1..33].copy_from_slice(&r);
    out[33..].copy_from_slice(&s);
    Ok(out)
}

/// Extracts (r, s) as 32-byte big-endian words from a DER ECDSA signature.
fn der_to_rs(der: &[u8]) -> Result<([u8; 32], [u8; 32]), AppSW> {
    fn int_at(der: &[u8], i: usize) -> Result<(&[u8], usize), AppSW> {
        if der.get(i) != Some(&0x02) {
            return Err(AppSW::TxSignFail);
        }
        let len = *der.get(i + 1).ok_or(AppSW::TxSignFail)? as usize;
        let v = der.get(i + 2..i + 2 + len).ok_or(AppSW::TxSignFail)?;
        Ok((v, i + 2 + len))
    }
    fn to_word(v: &[u8]) -> Result<[u8; 32], AppSW> {
        // DER integers are signed, so a leading zero byte may pad a high bit.
        let start = v.iter().position(|&b| b != 0).unwrap_or(v.len());
        let v = &v[start..];
        if v.len() > 32 {
            return Err(AppSW::TxSignFail);
        }
        let mut w = [0u8; 32];
        w[32 - v.len()..].copy_from_slice(v);
        Ok(w)
    }
    if der.first() != Some(&0x30) {
        return Err(AppSW::TxSignFail);
    }
    let (r, next) = int_at(der, 2)?;
    let (s, _) = int_at(der, next)?;
    Ok((to_word(r)?, to_word(s)?))
}
