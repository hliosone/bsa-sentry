//! STORE_CREDENTIALS, GET_CREDENTIALS and RESTORE.
//!
//! The device will not hold a credential bundle it cannot tie to itself: before storing,
//! it checks that the delegation targets **its own** 0xAGENT and was signed by **its own**
//! 0xMAIN. That is the device half of security invariant 6 — the facilitator re-checks the
//! same links independently, so neither side has to trust the other.
use crate::crypto::{self, Account};
use crate::handlers::sign_main::chunk_sw;
use crate::keccak::DeviceKeccak;
use crate::store;
use crate::{fmt, show_home, AppError, AppSW};
use alloc::string::String;
use alloc::vec::Vec;
use bsa_sentry_core::wire::{decode_credentials, read_credentials, read_policy, Credentials};
use bsa_sentry_core::{eip712, Counters, RefusalReason};
use ledger_device_sdk::io::{Command, CommandResponse};
use ledger_device_sdk::nbgl::{Field, NbglReview, TransactionType};

/// 200 bytes per read, matching what the host expects from a chunked read.
const READ_CHUNK: usize = 200;

/// Recomputes the delegation digest and proves the signature is this device's own.
///
/// Rather than recovering a public key, we re-sign the digest with 0xMAIN and compare:
/// ECDSA here is deterministic (RFC 6979), so only our own 0xMAIN can produce these exact
/// 65 bytes. That is strictly stronger than a verify (it also rejects a re-randomised but
/// otherwise valid signature) and needs no DER round-trip on the device.
fn delegation_is_ours(c: &Credentials) -> Result<bool, AppError> {
    let own_agent = crypto::address(Account::Agent)?;
    if c.delegation.agent != own_agent {
        return Ok(false);
    }
    let claims: Vec<&[u8]> = (0..c.delegation.claim_count as usize)
        .map(|i| c.delegation.claim(i))
        .collect();
    let digest = eip712::delegation_digest::<DeviceKeccak>(
        c.chain_id,
        &c.delegation.agent,
        c.delegation.agent_name(),
        &c.delegation.attestation,
        &claims,
        c.delegation.expires_at,
        &c.delegation.nonce,
    );
    let ours = crypto::sign_digest(Account::Main, &digest)?;
    Ok(ours == c.delegation_sig)
}

/// STORE_CREDENTIALS: chunked, no tap. The user already tapped to create the delegation;
/// storing a bundle the device has just verified against its own keys adds nothing to confirm.
pub fn handler_store_credentials<'a, const N: usize>(
    command: Command<'a, N>,
    first: bool,
    last: bool,
) -> Result<CommandResponse<'a, N>, AppError> {
    let p1 = if first { 0x00 } else { 0x01 };
    let p2 = if last { 0x00 } else { 0x80 };
    let complete = store::reassembler()
        .push(p1, p2, command.get_data())
        .map_err(|e| AppError::Sw(chunk_sw(e)))?;
    let Some(payload) = complete else {
        return Ok(command.into_response());
    };

    let creds = decode_credentials(payload).map_err(|_| AppError::Sw(AppSW::TxParsingFail))?;
    if !delegation_is_ours(&creds)? {
        // Either it targets another agent, or it was not signed by this device's 0xMAIN.
        return Err(AppError::Refused(RefusalReason::UserRejected));
    }
    store::save_credentials(payload).map_err(|_| AppError::Sw(AppSW::StorageFail))?;
    Ok(command.into_response())
}

/// GET_CREDENTIALS: `len(2) | up to 200 bytes` from offset `200 * P1`.
/// A total length of 0 means "nothing stored", which is how the website knows to offer a restore.
pub fn handler_get_credentials<'a, const N: usize>(
    command: Command<'a, N>,
    chunk: u8,
) -> Result<CommandResponse<'a, N>, AppError> {
    let blob = store::credentials();
    let start = (chunk as usize * READ_CHUNK).min(blob.len());
    let end = (start + READ_CHUNK).min(blob.len());
    let mut response = command.into_response();
    response.append(&(blob.len() as u16).to_be_bytes())?;
    response.append(&blob[start..end])?;
    Ok(response)
}

/// RESTORE: a policy, optionally followed by a credentials bundle, from a Key Ring backup.
/// Chunked, and reviewed in full: this writes the rules, so invariant 1 applies exactly as
/// it does to SET_POLICY.
///
/// Both blobs are self-delimiting, and together they fit one 1024-byte transfer (353 + 483
/// at their maxima), which is why RESTORE is a single command rather than two.
pub fn handler_restore<'a, const N: usize>(
    command: Command<'a, N>,
    first: bool,
    last: bool,
) -> Result<CommandResponse<'a, N>, AppError> {
    let p1 = if first { 0x00 } else { 0x01 };
    let p2 = if last { 0x00 } else { 0x80 };
    let complete = store::reassembler()
        .push(p1, p2, command.get_data())
        .map_err(|e| AppError::Sw(chunk_sw(e)))?;
    let Some(payload) = complete else {
        return Ok(command.into_response());
    };

    let (policy, used) = read_policy(payload).map_err(|_| AppError::Sw(AppSW::TxParsingFail))?;
    let rest = &payload[used..];
    let creds = if rest.is_empty() {
        None
    } else {
        let (c, n) = read_credentials(rest).map_err(|_| AppError::Sw(AppSW::TxParsingFail))?;
        if n != rest.len() {
            return Err(AppError::Sw(AppSW::TxParsingFail));
        }
        // A restored bundle must still belong to this device, exactly as at STORE time.
        if !delegation_is_ours(&c)? {
            return Err(AppError::Sw(AppSW::TxParsingFail));
        }
        Some((c, rest))
    };

    let credentials_line: String = match &creds {
        None => String::from("aucune"),
        Some((c, _)) => {
            let mut acc = String::new();
            for i in 0..c.delegation.claim_count as usize {
                if i > 0 {
                    acc.push_str(", ");
                }
                acc.push_str(&fmt::untrusted_text(c.delegation.claim(i)));
            }
            if acc.is_empty() {
                String::from("delegation sans claim")
            } else {
                acc
            }
        }
    };

    // The same full review as SET_POLICY, plus what is being restored alongside it.
    let comm = command.into_comm();
    let approved = {
        let chain = alloc::format!("Arc testnet ({})", policy.chain_id);
        let token = fmt::address(&policy.token);
        let auto_max = fmt::amount_usdc(policy.auto_max);
        let hard_max = fmt::amount_usdc(policy.hard_max);
        let budget = fmt::amount_usdc(policy.budget);
        let payee_names: Vec<String> = (0..policy.payee_count)
            .map(|i| alloc::format!("Marchand {}", i + 1))
            .collect();
        let payee_values: Vec<String> = policy
            .payees()
            .iter()
            .map(|p| alloc::format!("{}\n{}", fmt::untrusted_text(p.label()), fmt::address(&p.addr)))
            .collect();
        let mut fields: Vec<Field> = Vec::with_capacity(6 + policy.payee_count);
        fields.push(Field { name: "Reseau", value: &chain });
        fields.push(Field { name: "Jeton", value: &token });
        fields.push(Field { name: "Sans confirmation jusqu'a", value: &auto_max });
        fields.push(Field { name: "Plafond absolu", value: &hard_max });
        fields.push(Field { name: "Budget total", value: &budget });
        fields.push(Field { name: "Identite restauree", value: &credentials_line });
        for i in 0..policy.payee_count {
            fields.push(Field { name: &payee_names[i], value: &payee_values[i] });
        }
        NbglReview::new()
            .tx_type(TransactionType::Operation)
            .titles("Restaurer vos regles", "Verifiez chaque adresse en entier", "Restaurer")
            .show(comm, &fields)
    };
    show_home();
    if !approved {
        return Err(AppError::Refused(RefusalReason::UserRejected));
    }

    store::save_policy(&policy).map_err(|_| AppError::Sw(AppSW::StorageFail))?;
    // A restore starts a fresh budget: the counters belonged to the wiped device.
    store::save_counters(&Counters::default(), 0, &[]);
    if let Some((_, raw)) = creds {
        store::save_credentials(raw).map_err(|_| AppError::Sw(AppSW::StorageFail))?;
    }
    Ok(comm.begin_response())
}
