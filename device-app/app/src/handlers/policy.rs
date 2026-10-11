//! SET_POLICY and CLEAR_POLICY.
//!
//! Security invariant 1: the policy only ever changes after an on-device review and a tap.
//! The host can propose a policy; it cannot install one. The review shows every payee's
//! FULL address, because a shortened address is exactly what a lookalike payee relies on.
use crate::fmt;
use crate::store;
use crate::{show_home, AppError, AppSW};
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use bsa_sentry_core::wire::decode_policy;
use bsa_sentry_core::{Counters, Policy};
use ledger_device_sdk::io::{Command, CommandResponse, Comm};
use ledger_device_sdk::nbgl::{Field, NbglReview, TransactionType};

/// Reassembles the chunked policy; on the last chunk, reviews it and stores it.
pub fn handler_set_policy<'a, const N: usize>(
    command: Command<'a, N>,
    first: bool,
    last: bool,
) -> Result<CommandResponse<'a, N>, AppError> {
    let p1 = if first { 0x00 } else { 0x01 };
    let p2 = if last { 0x00 } else { 0x80 };
    let data = command.get_data();

    let complete = store::reassembler()
        .push(p1, p2, data)
        .map_err(|e| AppError::Sw(match e.status_word() {
            0xb004 => AppSW::PayloadTooLarge,
            0xb00b => AppSW::BadState,
            _ => AppSW::WrongApduLength,
        }))?;

    let Some(payload) = complete else {
        // More chunks expected; nothing is shown and nothing is stored yet.
        return Ok(command.into_response());
    };

    let policy = decode_policy(payload).map_err(|_| AppError::Sw(AppSW::TxParsingFail))?;

    let comm = command.into_comm();
    let approved = review_policy(comm, &policy, "Nouvelles regles");
    show_home();
    if !approved {
        return Err(AppError::Refused(bsa_sentry_core::RefusalReason::UserRejected));
    }

    store::save_policy(&policy).map_err(|_| AppError::Sw(AppSW::StorageFail))?;
    // SET_POLICY resets the counters: a new budget starts from zero, and the last payment
    // shown on the home screen belonged to the old rules.
    store::save_counters(&Counters::default(), 0, &[]);
    Ok(comm.begin_response())
}

/// The review screen for a policy. Shared by SET_POLICY and RESTORE.
pub fn review_policy<const N: usize>(comm: &mut Comm<N>, policy: &Policy, title: &str) -> bool {
    // Every string must outlive the `Field` slice that borrows it.
    let chain = format!("Arc testnet ({})", policy.chain_id);
    let token = fmt::address(&policy.token);
    let auto_max = fmt::amount_usdc(policy.auto_max);
    let hard_max = fmt::amount_usdc(policy.hard_max);
    let budget = fmt::amount_usdc(policy.budget);
    let max_count = format!("{}", policy.max_count);

    let payee_names: Vec<String> = (0..policy.payee_count)
        .map(|i| format!("Marchand {}", i + 1))
        .collect();
    let payee_values: Vec<String> = policy
        .payees()
        .iter()
        .map(|p| format!("{}\n{}", fmt::untrusted_text(p.label()), fmt::address(&p.addr)))
        .collect();

    let mut fields: Vec<Field> = Vec::with_capacity(6 + policy.payee_count);
    fields.push(Field { name: "Reseau", value: &chain });
    fields.push(Field { name: "Jeton", value: &token });
    fields.push(Field { name: "Sans confirmation jusqu'a", value: &auto_max });
    fields.push(Field { name: "Plafond absolu", value: &hard_max });
    fields.push(Field { name: "Budget total", value: &budget });
    fields.push(Field { name: "Paiements max", value: &max_count });
    for i in 0..policy.payee_count {
        fields.push(Field { name: &payee_names[i], value: &payee_values[i] });
    }

    NbglReview::new()
        .tx_type(TransactionType::Operation)
        .titles(title, "Verifiez chaque adresse en entier", "Approuver les regles")
        .show(comm, &fields)
}

/// CLEAR_POLICY: the kill switch. Wipes the rules and the counters after a tap.
pub fn handler_clear_policy<'a, const N: usize>(
    command: Command<'a, N>,
) -> Result<CommandResponse<'a, N>, AppError> {
    let comm = command.into_comm();
    let approved = NbglReview::new()
        .tx_type(TransactionType::Operation)
        .titles(
            "Bloquer l'agent ?",
            "Les regles et le budget seront effaces",
            "Bloquer l'agent",
        )
        .show(
            comm,
            &[
                Field { name: "Effet", value: "L'agent ne pourra plus payer" },
                Field { name: "Marchands de confiance", value: "Tous effaces" },
            ],
        );
    show_home();
    if !approved {
        return Err(AppError::Refused(bsa_sentry_core::RefusalReason::UserRejected));
    }
    store::clear_policy();
    Ok(comm.begin_response())
}
