//! The three things 0xMAIN signs: Login, Bind and AgentDelegation.
//!
//! Security invariant 5: 0xMAIN signs **only** these three, and **always** after a tap.
//! There is no path here that signs a transfer, and no path that signs a host-supplied
//! hash — every digest below is rebuilt from the raw fields the host sent (invariant 2).
use crate::crypto::{self, Account};
use crate::keccak::DeviceKeccak;
use crate::store;
use crate::{fmt, show_home, AppError, AppSW};
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use bsa_sentry_core::wire::{MAX_AGENT_NAME_BYTES, MAX_CLAIMS, MAX_CLAIM_BYTES};
use bsa_sentry_core::{eip712, RefusalReason};
use ledger_device_sdk::io::{Command, CommandResponse};
use ledger_device_sdk::nbgl::{Field, NbglReview, TransactionType};

/// A cursor over a host-supplied payload that can never read past the end.
struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8]) -> Self {
        Reader { b, at: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], AppError> {
        let end = self.at.checked_add(n).ok_or(AppError::Sw(AppSW::WrongApduLength))?;
        if end > self.b.len() {
            return Err(AppError::Sw(AppSW::WrongApduLength));
        }
        let out = &self.b[self.at..end];
        self.at = end;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, AppError> {
        Ok(self.take(1)?[0])
    }
    fn u64(&mut self) -> Result<u64, AppError> {
        let mut w = [0u8; 8];
        w.copy_from_slice(self.take(8)?);
        Ok(u64::from_be_bytes(w))
    }
    fn arr20(&mut self) -> Result<[u8; 20], AppError> {
        let mut o = [0u8; 20];
        o.copy_from_slice(self.take(20)?);
        Ok(o)
    }
    fn arr32(&mut self) -> Result<[u8; 32], AppError> {
        let mut o = [0u8; 32];
        o.copy_from_slice(self.take(32)?);
        Ok(o)
    }
    /// Length-prefixed UTF-8, validated: it goes straight onto a screen.
    fn text(&mut self, max: usize) -> Result<&'a str, AppError> {
        let len = self.u8()? as usize;
        if len > max {
            return Err(AppError::Sw(AppSW::WrongApduLength));
        }
        let raw = self.take(len)?;
        core::str::from_utf8(raw).map_err(|_| AppError::Sw(AppSW::TxParsingFail))
    }
    fn finish(self) -> Result<(), AppError> {
        if self.at == self.b.len() {
            Ok(())
        } else {
            Err(AppError::Sw(AppSW::WrongApduLength))
        }
    }
}

/// SIGN_LOGIN: proves control of 0xMAIN to our server.
/// Payload: chainId(8) | originLen(1) | origin | nonce(32) | issuedAt(8) | expiresAt(8)
pub fn handler_sign_login<'a, const N: usize>(
    command: Command<'a, N>,
) -> Result<CommandResponse<'a, N>, AppError> {
    let data = command.get_data();
    let mut r = Reader::new(data);
    let chain_id = r.u64()?;
    let origin = r.text(64)?;
    let nonce = r.arr32()?;
    let issued_at = r.u64()?;
    let expires_at = r.u64()?;
    r.finish()?;

    let digest = eip712::login_digest::<DeviceKeccak>(chain_id, origin.as_bytes(), &nonce, issued_at, expires_at);
    // Copy out of the command buffer before it is turned back into a Comm.
    let origin_shown = fmt::untrusted_text(origin.as_bytes());
    let expiry = fmt::date_utc(expires_at);

    let comm = command.into_comm();
    let approved = NbglReview::new()
        .tx_type(TransactionType::Message)
        .titles("Se connecter", "Connexion a un site web", "Se connecter")
        .show(
            comm,
            &[
                Field { name: "Site", value: &origin_shown },
                Field { name: "Compte", value: "Votre compte principal" },
                Field { name: "Valable jusqu'au", value: &expiry },
            ],
        );
    show_home();
    if !approved {
        return Err(AppError::Refused(RefusalReason::UserRejected));
    }

    let sig = crypto::sign_digest(Account::Main, &digest)?;
    let mut response = comm.begin_response();
    response.append(&sig)?;
    Ok(response)
}

/// SIGN_BIND: ties an EUDIW presentation session to 0xMAIN.
/// Payload: chainId(8) | verifierLen(1) | verifier | session(32) | expiresAt(8)
pub fn handler_sign_bind<'a, const N: usize>(
    command: Command<'a, N>,
) -> Result<CommandResponse<'a, N>, AppError> {
    let data = command.get_data();
    let mut r = Reader::new(data);
    let chain_id = r.u64()?;
    let verifier = r.text(64)?;
    let session = r.arr32()?;
    let expires_at = r.u64()?;
    r.finish()?;

    let digest = eip712::bind_digest::<DeviceKeccak>(chain_id, verifier.as_bytes(), &session, expires_at);
    let verifier_shown = fmt::untrusted_text(verifier.as_bytes());
    let session_shown = format!("0x{}", hex_of(&session[..8]));
    let expiry = fmt::date_utc(expires_at);

    let comm = command.into_comm();
    let approved = NbglReview::new()
        .tx_type(TransactionType::Message)
        .titles("Lier votre identite", "Preuve 18+ depuis votre portefeuille", "Lier")
        .show(
            comm,
            &[
                Field { name: "Verificateur", value: &verifier_shown },
                Field { name: "Session", value: &session_shown },
                Field { name: "Valable jusqu'au", value: &expiry },
                Field { name: "Donnees partagees", value: "Aucune donnee personnelle" },
            ],
        );
    show_home();
    if !approved {
        return Err(AppError::Refused(RefusalReason::UserRejected));
    }

    let sig = crypto::sign_digest(Account::Main, &digest)?;
    let mut response = comm.begin_response();
    response.append(&sig)?;
    Ok(response)
}

/// SIGN_DELEGATION: authorises the agent to present the 18+ attestation. Chunked.
/// Payload: chainId(8) | agent(20) | nameLen(1) | name | attestation(32)
///        | claimCount(1) | (len|claim)* | expiresAt(8) | nonce(32)
pub fn handler_sign_delegation<'a, const N: usize>(
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

    let mut r = Reader::new(payload);
    let chain_id = r.u64()?;
    let agent = r.arr20()?;
    let name = r.text(MAX_AGENT_NAME_BYTES)?;
    let attestation = r.arr32()?;
    let claim_count = r.u8()? as usize;
    if claim_count > MAX_CLAIMS {
        return Err(AppError::Sw(AppSW::TxParsingFail));
    }
    let mut claims: Vec<&str> = Vec::with_capacity(claim_count);
    for _ in 0..claim_count {
        claims.push(r.text(MAX_CLAIM_BYTES)?);
    }
    let expires_at = r.u64()?;
    let nonce = r.arr32()?;
    r.finish()?;

    // The delegation must target THIS device's agent. Delegating to someone else's address
    // would hand the attestation to a key we do not control, and nothing legitimate needs it.
    let own_agent = crypto::address(Account::Agent)?;
    if agent != own_agent {
        return Err(AppError::Sw(AppSW::TxParsingFail));
    }

    let claim_bytes: Vec<&[u8]> = claims.iter().map(|c| c.as_bytes()).collect();
    let digest = eip712::delegation_digest::<DeviceKeccak>(
        chain_id,
        &agent,
        name.as_bytes(),
        &attestation,
        &claim_bytes,
        expires_at,
        &nonce,
    );

    let name_shown = fmt::untrusted_text(name.as_bytes());
    let agent_shown = fmt::address(&agent);
    let claims_shown: String = if claims.is_empty() {
        String::from("aucune")
    } else {
        let mut acc = String::new();
        for (i, c) in claims.iter().enumerate() {
            if i > 0 {
                acc.push_str(", ");
            }
            acc.push_str(&fmt::untrusted_text(c.as_bytes()));
        }
        acc
    };
    let expiry = fmt::date_utc(expires_at);

    let comm = command.into_comm();
    let approved = NbglReview::new()
        .tx_type(TransactionType::Message)
        .titles("Autoriser votre agent", "Verifiez l'adresse en entier", "Autoriser l'agent")
        .show(
            comm,
            &[
                Field { name: "Agent", value: &name_shown },
                Field { name: "Adresse de l'agent", value: &agent_shown },
                Field { name: "Peut prouver", value: &claims_shown },
                Field { name: "Jusqu'au", value: &expiry },
            ],
        );
    show_home();
    if !approved {
        return Err(AppError::Refused(RefusalReason::UserRejected));
    }

    let sig = crypto::sign_digest(Account::Main, &digest)?;
    let mut response = comm.begin_response();
    response.append(&sig)?;
    Ok(response)
}

pub fn chunk_sw(e: bsa_sentry_core::chunk::ChunkError) -> AppSW {
    match e.status_word() {
        0xb004 => AppSW::PayloadTooLarge,
        0xb00b => AppSW::BadState,
        _ => AppSW::WrongApduLength,
    }
}

fn hex_of(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}
