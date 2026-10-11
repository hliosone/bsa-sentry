use crate::handlers::sign_tx::TxContext;
use crate::utils::get_address_hash_from_pubkey;
use crate::AppSW;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use ledger_device_sdk::ecc::{Secp256k1, SeedDerive};
use ledger_device_sdk::hash::{sha3::Keccak256, HashInit};
use ledger_device_sdk::io::{Command, CommandResponse};
use ledger_device_sdk::nbgl::NbglChoice;

/// m/44'/60'/1'/0/0
const PATH: [u32; 5] = [0x8000_002C, 0x8000_003C, 0x8000_0001, 0, 0];

// EIP-712 domain of USDC on Base Sepolia (name() / version() read on-chain).
const DOMAIN_NAME: &[u8] = b"USDC";
const DOMAIN_VERSION: &[u8] = b"2";
const DOMAIN_TYPE: &[u8] =
    b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const TRANSFER_TYPE: &[u8] = b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

// chainId(8) | verifyingContract(20) | to(20) | value(32) | validAfter(32) | validBefore(32) | nonce(32)
const SIGN_3009_LEN: usize = 8 + 20 + 20 + 32 * 4;
const USDC_DECIMALS: usize = 6;

fn keccak(parts: &[&[u8]]) -> Result<[u8; 32], AppSW> {
    let mut h = Keccak256::new();
    for p in parts {
        h.update(p).map_err(|_| AppSW::TxHashFail)?;
    }
    let mut out = [0u8; 32];
    h.finalize(&mut out).map_err(|_| AppSW::TxHashFail)?;
    Ok(out)
}

/// Left-pads a value to a 32-byte ABI word.
fn word(bytes: &[u8]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[32 - bytes.len()..].copy_from_slice(bytes);
    w
}

fn own_address() -> Result<[u8; 20], AppSW> {
    let (k, _) = Secp256k1::derive_from(&PATH);
    let pk = k.public_key().map_err(|_| AppSW::KeyDeriveFail)?;
    let hash = get_address_hash_from_pubkey(&pk.pubkey);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..]);
    Ok(addr)
}

/// Formats a big-endian u256 token amount with `USDC_DECIMALS` decimals.
fn format_amount(be: &[u8; 32]) -> String {
    let mut n = *be;
    let mut digits: Vec<u8> = Vec::new();
    while n.iter().any(|&b| b != 0) {
        let mut rem: u16 = 0;
        for b in n.iter_mut() {
            let cur = (rem << 8) | *b as u16;
            *b = (cur / 10) as u8;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
    }
    while digits.len() <= USDC_DECIMALS {
        digits.push(b'0');
    }
    digits.reverse();
    let (int, frac) = digits.split_at(digits.len() - USDC_DECIMALS);
    let frac = core::str::from_utf8(frac).unwrap().trim_end_matches('0');
    let int = core::str::from_utf8(int).unwrap();
    if frac.is_empty() {
        String::from(int)
    } else {
        format!("{}.{}", int, frac)
    }
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
        let start = v.iter().position(|&b| b != 0).unwrap_or(v.len());
        let v = &v[start..];
        if v.len() > 32 {
            return Err(AppSW::TxSignFail);
        }
        Ok(word(v))
    }
    if der.first() != Some(&0x30) {
        return Err(AppSW::TxSignFail);
    }
    let (r, next) = int_at(der, 2)?;
    let (s, _) = int_at(der, next)?;
    Ok((to_word(r)?, to_word(s)?))
}

/// GET_ADDRESS: returns the 20-byte EVM address at m/44'/60'/1'/0/0.
pub fn handler_get_address(command: Command<'_>) -> Result<CommandResponse<'_>, AppSW> {
    let addr = own_address()?;
    let mut response = command.into_response();
    response.append(&addr)?;
    Ok(response)
}

struct Authorization {
    to: [u8; 20],
    value: [u8; 32],
    digest: [u8; 32],
}

/// Parses a SIGN_3009 payload and builds its EIP-712 digest (from = own address).
fn parse_and_digest(data: &[u8]) -> Result<Authorization, AppSW> {
    if data.len() != SIGN_3009_LEN {
        return Err(AppSW::WrongApduLength);
    }
    let (chain_id, rest) = data.split_at(8);
    let (verifying_contract, rest) = rest.split_at(20);
    let (to, rest) = rest.split_at(20);
    let (value, rest) = rest.split_at(32);
    let (valid_after, rest) = rest.split_at(32);
    let (valid_before, nonce) = rest.split_at(32);
    let to: [u8; 20] = to.try_into().unwrap();
    let value: [u8; 32] = value.try_into().unwrap();
    let from = own_address()?;

    let domain_separator = keccak(&[
        &keccak(&[DOMAIN_TYPE])?,
        &keccak(&[DOMAIN_NAME])?,
        &keccak(&[DOMAIN_VERSION])?,
        &word(chain_id),
        &word(verifying_contract),
    ])?;
    let struct_hash = keccak(&[
        &keccak(&[TRANSFER_TYPE])?,
        &word(&from),
        &word(&to),
        &value,
        valid_after,
        valid_before,
        nonce,
    ])?;
    let digest = keccak(&[&[0x19, 0x01], &domain_separator, &struct_hash])?;
    Ok(Authorization { to, value, digest })
}

/// Signs the digest and appends v(1) | r(32) | s(32) | digest(32).
fn sign_and_reply<'a>(
    mut response: CommandResponse<'a>,
    digest: &[u8; 32],
) -> Result<CommandResponse<'a>, AppSW> {
    let (sig, siglen, parity) = Secp256k1::derive_from(&PATH)
        .0
        .deterministic_sign(digest)
        .map_err(|_| AppSW::TxSignFail)?;
    let (r, s) = der_to_rs(&sig[..siglen as usize])?;
    response.append(&[27 + parity as u8])?;
    response.append(&r)?;
    response.append(&s)?;
    response.append(digest)?;
    Ok(response)
}

/// SIGN_3009: asks the user to confirm the transfer, then signs.
pub fn handler_sign_3009<'a>(
    command: Command<'a>,
    ctx: &mut TxContext,
) -> Result<CommandResponse<'a>, AppSW> {
    let auth = parse_and_digest(command.get_data())?;

    let comm = command.into_comm();
    let approved = NbglChoice::new().show(
        comm,
        &format!("Sign payment: {} USDC", format_amount(&auth.value)),
        &format!("to 0x{}?", hex::encode(auth.to)),
        "Approve",
        "Reject",
    );
    ctx.home.show_and_return();
    if !approved {
        return Err(AppSW::Deny);
    }
    sign_and_reply(comm.begin_response(), &auth.digest)
}

/// DEBUG ONLY: Base Sepolia chain id, the only chain SIGN_3009_SILENT will sign for.
const SILENT_CHAIN_ID: u64 = 84532;

/// SIGN_3009_SILENT (debug): same as SIGN_3009 but signs WITHOUT user confirmation.
/// Locked to Base Sepolia so this blind-signing path cannot authorize mainnet transfers.
/// The "Signed silently" status is shown by main.rs after the reply is sent.
pub fn handler_sign_3009_silent(command: Command<'_>) -> Result<CommandResponse<'_>, AppSW> {
    let data = command.get_data();
    if data.len() >= 8 && u64::from_be_bytes(data[..8].try_into().unwrap()) != SILENT_CHAIN_ID {
        return Err(AppSW::Deny);
    }
    let auth = parse_and_digest(data)?;
    sign_and_reply(command.into_response(), &auth.digest)
}
