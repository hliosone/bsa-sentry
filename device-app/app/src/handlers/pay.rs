//! PAY — the one path to a payment signature.
//!
//! The whole product is in here:
//!   inside the rules  -> sign with no button press
//!   outside the rules -> the orange screen, 3 choices, 60 s then refuse
//!   dangerous         -> refused, and a tap cannot override it
//!
//! Security invariants enforced here:
//!   2. the digest is built from the raw fields below; nothing signs a host-supplied hash
//!   3. the payee is matched on its address; the hint is display-only; "Une fois" never
//!      adds a payee
//!   4. the counters are written to NVM *before* the signature is returned
use crate::crypto::{self, Account};
use crate::keccak::DeviceKeccak;
use crate::orange::{self, Choice, OrangeScreen};
use crate::store;
use crate::{fmt, show_home, AppError, AppSW};
use bsa_sentry_core::wire::Payee;
use bsa_sentry_core::{decide, eip712, Decision, Payment, RefusalReason};
use ledger_device_sdk::io::{Command, CommandResponse};

/// chainId(8) | token(20) | to(20) | value(32) | validAfter(32) | validBefore(32) | nonce(32)
const FIELDS_LEN: usize = 8 + 20 + 20 + 32 * 3 + 32;
/// The agent's claim about the payee. Display only, and bounded so it cannot flood the screen.
const MAX_HINT: usize = 24;

struct Request {
    payment: Payment,
    valid_after: [u8; 32],
    valid_before: [u8; 32],
    nonce: [u8; 32],
    hint_len: usize,
    hint: [u8; MAX_HINT],
}

fn parse(data: &[u8]) -> Result<Request, AppError> {
    if data.len() < FIELDS_LEN || data.len() > FIELDS_LEN + MAX_HINT {
        return Err(AppError::Sw(AppSW::WrongApduLength));
    }
    let mut at = 0;
    let mut take = |n: usize| {
        let out = &data[at..at + n];
        at += n;
        out
    };
    let mut w8 = [0u8; 8];
    w8.copy_from_slice(take(8));
    let chain_id = u64::from_be_bytes(w8);
    let mut token = [0u8; 20];
    token.copy_from_slice(take(20));
    let mut to = [0u8; 20];
    to.copy_from_slice(take(20));
    let mut value = [0u8; 32];
    value.copy_from_slice(take(32));
    let mut valid_after = [0u8; 32];
    valid_after.copy_from_slice(take(32));
    let mut valid_before = [0u8; 32];
    valid_before.copy_from_slice(take(32));
    let mut nonce = [0u8; 32];
    nonce.copy_from_slice(take(32));

    let hint_raw = &data[FIELDS_LEN..];
    let mut hint = [0u8; MAX_HINT];
    hint[..hint_raw.len()].copy_from_slice(hint_raw);

    Ok(Request {
        payment: Payment { chain_id, token, to, value },
        valid_after,
        valid_before,
        nonce,
        hint_len: hint_raw.len(),
        hint,
    })
}

pub fn handler_pay<'a, const N: usize>(
    command: Command<'a, N>,
    runtime: &mut store::Runtime,
) -> Result<CommandResponse<'a, N>, AppError> {
    // Parse before `into_comm`: the request borrows the command's buffer, so everything
    // we need is copied into `Request` first.
    let req = parse(command.get_data())?;
    let comm = command.into_comm();
    let mut policy = store::policy();
    let (counters, _, _) = store::counters();
    let session = store::session();

    // A stale flow from an aborted payment must never carry over into this one.
    runtime.flow.abort();

    let decision = decide(&policy, &counters, &session, &req.payment);

    // The amount is only safe to read as a u64 once decide() has accepted it; above
    // u64::MAX it is already refused as OVER_HARD_MAX.
    let mut trust_payee = false;
    match decision {
        Decision::Refuse(reason) => return Err(AppError::Refused(reason)),
        Decision::Auto => {}
        Decision::Orange(info) => {
            let label = policy.find_payee(&req.payment.to).map(|p| fmt::untrusted_text(p.label()));
            let hint = if req.hint_len > 0 {
                Some(fmt::untrusted_text(&req.hint[..req.hint_len]))
            } else {
                None
            };
            let screen = OrangeScreen {
                amount: &fmt::amount_u256(&req.payment.value),
                payee_label: label.as_deref(),
                full_address: &fmt::address(&req.payment.to),
                hint: hint.as_deref(),
                reason: info.reason,
                trust_allowed: info.trust_allowed,
            };
            let choice = orange::ask(comm, &screen);
            show_home();
            match choice {
                // Refuse, and the 60 s timeout, are the same answer to the host.
                Choice::Refuse => return Err(AppError::Refused(RefusalReason::UserRejected)),
                // "Une fois" signs this payment and nothing more: no payee is added.
                Choice::Once => {}
                Choice::Trust => {
                    if !info.trust_allowed {
                        // Defence in depth: the screen does not offer it, and we refuse it here too.
                        return Err(AppError::Refused(RefusalReason::UserRejected));
                    }
                    trust_payee = true;
                }
            }
        }
    }

    let value = req
        .payment
        .value_as_u64()
        .ok_or(AppError::Refused(RefusalReason::OverHardMax))?;

    // The user chose to trust this merchant, after seeing its full address on screen.
    // The label is the agent's hint, which is why it was shown as unverified first.
    if trust_payee {
        let label = &req.hint[..req.hint_len];
        if policy.push_payee(Payee::new(req.payment.to, label)).is_ok() {
            store::save_policy(&policy).map_err(|_| AppError::Sw(AppSW::StorageFail))?;
        }
    }

    // Invariant 4: approve -> persist -> only then sign.
    let next = runtime
        .flow
        .approve(counters, value)
        .map_err(AppError::Refused)?;
    let label_for_home = store_label(&policy, &req);
    store::save_counters(&next, value, &label_for_home);
    runtime
        .flow
        .mark_persisted()
        .map_err(|_| AppError::Sw(AppSW::BadState))?;

    if !runtime.flow.may_sign() {
        return Err(AppError::Sw(AppSW::BadState));
    }

    let from = crypto::address(Account::Agent)?;
    let digest = eip712::payment_digest::<DeviceKeccak>(
        req.payment.chain_id,
        &req.payment.token,
        &from,
        &req.payment.to,
        &req.payment.value,
        &req.valid_after,
        &req.valid_before,
        &req.nonce,
    );
    let sig = crypto::sign_digest(Account::Agent, &digest)?;
    runtime
        .flow
        .mark_signed()
        .map_err(|_| AppError::Sw(AppSW::BadState))?;

    let mut response = comm.begin_response();
    response.append(&sig)?;
    Ok(response)
}

/// The label the home screen shows for the last payment: the trusted name if we have one,
/// otherwise the agent's hint, otherwise nothing.
fn store_label(policy: &bsa_sentry_core::Policy, req: &Request) -> alloc::vec::Vec<u8> {
    if let Some(p) = policy.find_payee(&req.payment.to) {
        return p.label().to_vec();
    }
    req.hint[..req.hint_len].to_vec()
}
