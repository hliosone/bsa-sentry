//! BSA Sentry — the spending rules for an AI agent, enforced inside the secure element.
//!
//! Descends from Ledger's `app-boilerplate-rust` (upstream `0f857a7`); see
//! `docs/PREEXISTING.md`. All of the boilerplate's own signing commands and every test
//! command from our feasibility work have been removed. In particular there is **no**
//! "sign this hash" command and no silent-signing command: the only path to a payment
//! signature is PAY, gated by `bsa_sentry_core::decide`.
#![no_std]
#![no_main]

mod handlers {
    pub mod credentials;
    pub mod get_version;
    pub mod pay;
    pub mod policy;
    pub mod sign_main;
}
mod fmt;
mod orange;
mod crypto;
mod home;
mod keccak;
mod store;

use bsa_sentry_core::wire::{encode_state, DeviceState};
use bsa_sentry_core::RefusalReason;
use crypto::Account;
use handlers::get_version::handler_get_version;
use handlers::pay::handler_pay;
use handlers::policy::{handler_clear_policy, handler_set_policy};
use handlers::credentials::{handler_get_credentials, handler_restore, handler_store_credentials};
use handlers::sign_main::{handler_sign_bind, handler_sign_delegation, handler_sign_login, handler_top_up};
use ledger_device_sdk::io::{self, init_comm, ApduHeader, Command, Reply};
use ledger_device_sdk::nbgl::{NbglAddressReview, NbglGlyph};

ledger_device_sdk::set_panic!(ledger_device_sdk::exiting_panic);

// Required for String / Vec / format! in the UI code.
extern crate alloc;

ledger_device_sdk::define_comm!(COMM);

/// Application status words.
#[repr(u16)]
#[derive(Clone, Copy, PartialEq)]
pub enum AppSW {
    Deny = 0x6985,
    WrongP1P2 = 0x6A86,
    InsNotSupported = 0x6D00,
    ClaNotSupported = 0x6E00,
    CommError = 0x6F00,
    /// A chunked payload exceeded the reassembly buffer.
    PayloadTooLarge = 0xB004,
    TxParsingFail = 0xB005,
    TxHashFail = 0xB006,
    TxSignFail = 0xB008,
    KeyDeriveFail = 0xB009,
    VersionParsingFail = 0xB00A,
    /// A "next" chunk arrived without a "first", or a command came out of order.
    BadState = 0xB00B,
    /// Writing to NVM failed, or the value was too large for its slot.
    StorageFail = 0xB00C,
    /// ISO 7816 "wrong length". Pinned explicitly rather than reusing the SDK's
    /// `StatusWords::BadLen` (0x6E03), so the device matches `SW.WRONG_LENGTH` in
    /// packages/types and the host has one value to map.
    WrongApduLength = 0x6700,
    Ok = 0x9000,
}

impl From<AppSW> for Reply {
    fn from(sw: AppSW) -> Reply {
        Reply(sw as u16)
    }
}

impl From<io::CommError> for AppSW {
    fn from(_e: io::CommError) -> Self {
        AppSW::CommError
    }
}

/// How a handler can fail.
///
/// `Refused` is separate because a refusal must carry its reason byte back to the host:
/// the bridge turns it into "refused by your Flex: OVER_HARD_MAX" for the agent.
pub enum AppError {
    Sw(AppSW),
    Refused(RefusalReason),
}

impl From<AppSW> for AppError {
    fn from(sw: AppSW) -> Self {
        AppError::Sw(sw)
    }
}

impl From<io::CommError> for AppError {
    fn from(_e: io::CommError) -> Self {
        AppError::Sw(AppSW::CommError)
    }
}

/// The BSA Sentry instruction set (CLA 0xE0), frozen in `packages/types/src/apdu.ts`.
#[derive(Debug)]
pub enum Instruction {
    GetVersion,
    GetAppName,
    GetAddress { account_agent: bool, display: bool },
    SetPolicy { first: bool, last: bool },
    Pay,
    GetState,
    ClearPolicy,
    SignBind,
    SignLogin,
    SignDelegation { first: bool, last: bool },
    StoreCredentials { first: bool, last: bool },
    GetCredentials { chunk: u8 },
    Restore { first: bool, last: bool },
    TopUp,
    #[cfg(feature = "diag")]
    Diag { p1: u8, p2: u8 },
}

impl TryFrom<ApduHeader> for Instruction {
    type Error = AppSW;

    fn try_from(value: ApduHeader) -> Result<Self, Self::Error> {
        // Chunked commands: P1 0x00 first / 0x01 next, P2 0x80 more / 0x00 last.
        let chunked = |p1: u8, p2: u8| (p1 == 0x00, p2 == 0x00);
        match (value.ins, value.p1, value.p2) {
            (0x03, 0, 0) => Ok(Instruction::GetVersion),
            (0x04, 0, 0) => Ok(Instruction::GetAppName),
            (0x08, 0 | 1, 0 | 1) => Ok(Instruction::GetAddress {
                account_agent: value.p1 == 1,
                display: value.p2 == 1,
            }),
            (0x0a, 0 | 1, 0 | 0x80) => {
                let (first, last) = chunked(value.p1, value.p2);
                Ok(Instruction::SetPolicy { first, last })
            }
            (0x0b, 0, 0) => Ok(Instruction::Pay),
            (0x0c, 0, 0) => Ok(Instruction::GetState),
            (0x0d, 0, 0) => Ok(Instruction::ClearPolicy),
            (0x0e, 0, 0) => Ok(Instruction::SignBind),
            (0x0f, 0, 0) => Ok(Instruction::SignLogin),
            (0x10, 0 | 1, 0 | 0x80) => {
                let (first, last) = chunked(value.p1, value.p2);
                Ok(Instruction::SignDelegation { first, last })
            }
            (0x11, 0 | 1, 0 | 0x80) => {
                let (first, last) = chunked(value.p1, value.p2);
                Ok(Instruction::StoreCredentials { first, last })
            }
            (0x12, chunk, 0) => Ok(Instruction::GetCredentials { chunk }),
            (0x13, 0 | 1, 0 | 0x80) => {
                let (first, last) = chunked(value.p1, value.p2);
                Ok(Instruction::Restore { first, last })
            }
            (0x14, 0, 0) => Ok(Instruction::TopUp),
            #[cfg(feature = "diag")]
            (0x7e, p1, p2) => Ok(Instruction::Diag { p1, p2 }),
            (0x03 | 0x04 | 0x08 | 0x0a..=0x14, _, _) => Err(AppSW::WrongP1P2),
            (_, _, _) => Err(AppSW::InsNotSupported),
        }
    }
}

/// Redraws the home from the current state, so the budget on screen is never stale.
pub fn show_home() {
    home::show(home::HOME);
}

#[no_mangle]
extern "C" fn sample_main(_arg0: u32) {
    // BSA Sentry is not a swap-capable app: it signs payment authorizations under its own
    // policy, never a transaction handed to it by Exchange.
    let comm = init_comm(&COMM);
    comm.set_expected_cla(0xe0);

    show_home();

    let runtime = unsafe { &mut *(&raw mut RUNTIME) };

    loop {
        let command = comm.next_command();
        let decoded = command.decode::<Instruction>();
        let Ok(ins) = decoded else {
            let _ = comm.send(&[], decoded.unwrap_err());
            continue;
        };

        let result = handle_apdu(command, &ins, runtime);
        // Commands that change what the home shows redraw it once their write is done (a review
        // returns to the home before the write, and a silent AUTO payment draws nothing).
        // Read-only commands do not, so the website polling GET_STATE never kicks the user out
        // of the menu.
        if matches!(
            ins,
            Instruction::SetPolicy { .. }
                | Instruction::ClearPolicy
                | Instruction::Pay
                | Instruction::StoreCredentials { .. }
                | Instruction::Restore { .. }
        ) {
            show_home();
        }
        match result {
            Ok(reply) => {
                let _ = reply.send(AppSW::Ok);
            }
            Err(AppError::Sw(sw)) => {
                let _ = comm.send(&[], sw);
            }
            Err(AppError::Refused(reason)) => {
                // 0x6985 plus one reason byte, so the host can tell the user *why*.
                let _ = comm.send(&[reason.byte()], AppSW::Deny);
            }
        }
    }
}

static mut RUNTIME: store::Runtime = store::Runtime::new();

fn handle_apdu<'a, const N: usize>(
    command: Command<'a, N>,
    ins: &Instruction,
    runtime: &mut store::Runtime,
) -> Result<io::CommandResponse<'a, N>, AppError> {
    match ins {
        Instruction::GetAppName => {
            let mut response = command.into_response();
            response.append(b"BSA Sentry")?;
            Ok(response)
        }
        Instruction::GetVersion => handler_get_version(command).map_err(AppError::Sw),
        Instruction::GetAddress { account_agent, display } => {
            handler_get_address(command, *account_agent, *display)
        }
        Instruction::GetState => handler_get_state(command),
        Instruction::SetPolicy { first, last } => handler_set_policy(command, *first, *last),
        Instruction::ClearPolicy => handler_clear_policy(command),
        Instruction::Pay => handler_pay(command, runtime),
        Instruction::SignLogin => handler_sign_login(command),
        Instruction::SignBind => handler_sign_bind(command),
        Instruction::SignDelegation { first, last } => handler_sign_delegation(command, *first, *last),
        Instruction::StoreCredentials { first, last } => handler_store_credentials(command, *first, *last),
        Instruction::GetCredentials { chunk } => handler_get_credentials(command, *chunk),
        Instruction::Restore { first, last } => handler_restore(command, *first, *last),
        Instruction::TopUp => handler_top_up(command),
        #[cfg(feature = "diag")]
        Instruction::Diag { p1, p2 } => {
            let mut response = command.into_response();
            match p1 {
                1 => unsafe {
                    orange::diag::VARIANT = *p2;
                    orange::diag::LOG = [0; 17];
                },
                2 => store::set_session(*p2 == 1),
                _ => {}
            }
            response.append(unsafe { &*(&raw const orange::diag::LOG) })?;
            Ok(response)
        }
    }
}

#[cfg(any(target_os = "stax", target_os = "flex"))]
const ICON: NbglGlyph = NbglGlyph::from_include(ledger_device_sdk::include_gif!("glyphs/crab_64x64.gif", NBGL));
#[cfg(target_os = "apex_p")]
const ICON: NbglGlyph = NbglGlyph::from_include(ledger_device_sdk::include_gif!("glyphs/crab_48x48.png", NBGL));
#[cfg(any(target_os = "nanosplus", target_os = "nanox"))]
const ICON: NbglGlyph = NbglGlyph::from_include(ledger_device_sdk::include_gif!("glyphs/home_nano_nbgl.png", NBGL));

/// GET_ADDRESS: the 20-byte EVM address of 0xMAIN (P1 0) or 0xAGENT (P1 1).
/// With P2 1 the address is shown first, so the user can check the one the website displays
/// (to fund 0xMAIN, say) against the one their Flex holds.
fn handler_get_address<const N: usize>(
    command: Command<'_, N>,
    account_agent: bool,
    display: bool,
) -> Result<io::CommandResponse<'_, N>, AppError> {
    let account = if account_agent { Account::Agent } else { Account::Main };
    let addr = crypto::address(account)?;
    let comm = command.into_comm();
    if display {
        let title = if account_agent { "Agent address" } else { "Your main address" };
        let approved = NbglAddressReview::new().glyph(&ICON).review_title(title).show(comm, &fmt::address(&addr));
        show_home();
        if !approved {
            return Err(AppError::Refused(RefusalReason::UserRejected));
        }
    }
    let mut response = comm.begin_response();
    response.append(&addr)?;
    Ok(response)
}

/// GET_STATE: the policy, counters, session and last payment, in the format
/// `packages/types` decodes with `decodeState`. No tap: it reveals nothing secret.
fn handler_get_state<const N: usize>(command: Command<'_, N>) -> Result<io::CommandResponse<'_, N>, AppError> {
    let (counters, last_value, last_label) = store::counters();
    let state = DeviceState {
        session: store::session(),
        has_credentials: store::has_credentials(),
        counters,
        last_value,
        last_label,
        policy: store::policy(),
    };
    let mut buf = [0u8; 512];
    let n = encode_state(&state, &mut buf).map_err(|_| AppSW::StorageFail)?;
    let mut response = command.into_response();
    response.append(&buf[..n])?;
    Ok(response)
}
