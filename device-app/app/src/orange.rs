//! The orange screen: three choices and a hard 60 s timeout.
//!
//! Built with the NBGL **C layout API** because the SDK's safe wrappers offer only two
//! choices and no timeout. Time is counted in **raw ticker events** (one per 100 ms): the
//! NBGL layout ticker pauses while the screen is being touched, and we measured 155 s of
//! wall clock for a "60 s" timeout that way. A screen whose job is to deny by default must
//! not be timed by a clock a finger can stop.
use crate::fmt;
use alloc::ffi::CString;
use bsa_sentry_core::OrangeReason;
use ledger_device_sdk::io::{Comm, DecodedEventType};
use ledger_device_sdk::sys::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Choice {
    Refuse,
    Once,
    Trust,
}

const TOKEN_CHOICE: u8 = 1;
const TOKEN_REFUSER: u8 = 2;
const TOKEN_ONCE_ONLY: u8 = 3;

/// 600 raw ticker events at 100 ms each = 60 s. Measured on hardware: 600 ticks, 63.8 s wall
/// clock, which is the right direction (never shorter than the promised 60 s).
const TIMEOUT_TICKS: u32 = 600;

static mut ENDED: bool = false;
static mut CHOICE: u8 = 0;
static mut TRUST_OFFERED: bool = false;

unsafe extern "C" fn on_action(token: core::ffi::c_int, index: u8) {
    CHOICE = match (token as u8, index) {
        // The two stacked buttons share one token; NBGL passes 0 for the top, 1 for the bottom.
        (TOKEN_CHOICE, 0) if TRUST_OFFERED => 2, // Faire confiance
        (TOKEN_CHOICE, 1) if TRUST_OFFERED => 1, // Une fois
        (TOKEN_ONCE_ONLY, _) => 1,               // the single "Une fois" button
        // Anything else, including the "Refuser" header, is a refusal.
        _ => 0,
    };
    ENDED = true;
}

pub struct OrangeScreen<'a> {
    pub amount: &'a str,
    /// The payee's label if it is already trusted, otherwise `None` -> "Marchand inconnu".
    pub payee_label: Option<&'a str>,
    pub full_address: &'a str,
    /// What the agent claims, shown as unverified. Never used for any decision.
    pub hint: Option<&'a str>,
    pub reason: OrangeReason,
    pub trust_allowed: bool,
}

fn reason_text(reason: OrangeReason) -> &'static str {
    match reason {
        OrangeReason::UnknownPayee => "Marchand pas dans vos regles",
        OrangeReason::OverAutoMax => "Montant au-dessus de la limite auto",
        OrangeReason::BudgetExceeded => "Budget depasse",
        OrangeReason::CountExceeded => "Nombre de paiements depasse",
    }
}

/// Shows the screen and blocks until the user chooses or 60 s elapse.
pub fn ask<const N: usize>(comm: &mut Comm<N>, screen: &OrangeScreen<'_>) -> Choice {
    // Keep every C string alive for as long as the layout is drawn.
    let title = fmt::cstr(&alloc::format!("Payer {} ?", screen.amount));
    let merchant = fmt::cstr(screen.payee_label.unwrap_or("Marchand inconnu"));
    let address = fmt::cstr(screen.full_address);
    let agent_says = screen
        .hint
        .map(|h| fmt::cstr(&alloc::format!("l'agent dit: {h}")));
    let unverified = fmt::cstr("(non verifie)");
    let reason = fmt::cstr(reason_text(screen.reason));
    let chain = fmt::cstr("USDC . Arc testnet . refus auto dans 60 s");
    let refuser = fmt::cstr("Refuser");
    let once = fmt::cstr("Une fois");
    let trust = fmt::cstr("Faire confiance");

    unsafe {
        ENDED = false;
        CHOICE = 0;
        TRUST_OFFERED = screen.trust_allowed;
    }

    let mut raw_ticks: u32 = 0;
    unsafe {
        let desc = nbgl_layoutDescription_t {
            modal: false,
            withLeftBorder: false,
            tapActionText: core::ptr::null(),
            tapActionToken: 0,
            tapTuneId: NB_TUNES,
            onActionCallback: Some(on_action),
            // No ticker callback: we count raw ticker events in the loop below instead.
            ticker: nbgl_screenTickerConfiguration_t {
                tickerCallback: None,
                tickerValue: 0,
                tickerIntervale: 0,
            },
        };
        let layout = nbgl_layoutGet(&desc);

        // "Refuser" in the header. HEADER_RIGHT_TEXT makes the whole header bar the touch
        // target; HEADER_BACK_AND_TEXT only makes its (undrawn) back arrow touchable.
        let header = nbgl_layoutHeader_t {
            type_: HEADER_RIGHT_TEXT,
            separationLine: true,
            __bindgen_anon_1: nbgl_layoutHeader_t__bindgen_ty_1 {
                rightText: nbgl_layoutHeader_t__bindgen_ty_1__bindgen_ty_6 {
                    text: refuser.as_ptr(),
                    token: TOKEN_REFUSER,
                    tuneId: TUNE_TAP_CASUAL,
                },
            },
        };
        nbgl_layoutAddHeader(layout, &header);

        // The payment, in the order that matters: how much, to whom, the full address,
        // what the agent claims (unverified), and why this screen is up at all.
        nbgl_layoutAddText(layout, title.as_ptr(), merchant.as_ptr());
        nbgl_layoutAddText(layout, address.as_ptr(), reason.as_ptr());
        match &agent_says {
            Some(s) => {
                nbgl_layoutAddText(layout, s.as_ptr(), unverified.as_ptr());
            }
            None => {
                nbgl_layoutAddText(layout, chain.as_ptr(), core::ptr::null());
            }
        }

        if screen.trust_allowed {
            let choices = nbgl_layoutChoiceButtons_t {
                topText: trust.as_ptr(),
                bottomText: once.as_ptr(),
                topIcon: core::ptr::null(),
                token: TOKEN_CHOICE,
                style: BOTH_ROUNDED_STYLE,
                tuneId: TUNE_TAP_CASUAL,
            };
            nbgl_layoutAddChoiceButtons(layout, &choices);
        } else {
            // Trusting the merchant would not change the outcome (the amount or the budget
            // is the problem, or the list is full), so the option is not offered at all.
            let button = nbgl_layoutButton_t {
                text: once.as_ptr(),
                icon: core::ptr::null(),
                token: TOKEN_ONCE_ONLY,
                style: BLACK_BACKGROUND,
                fittingContent: false,
                onBottom: true,
                tuneId: TUNE_TAP_CASUAL,
            };
            nbgl_layoutAddButton(layout, &button);
        }

        nbgl_layoutDraw(layout);
        nbgl_refresh();

        // Our own event loop: touch events reach on_action, and every raw ticker event is
        // 100 ms of the 60 s budget.
        while !ENDED {
            if let DecodedEventType::Ticker = comm.next_event().into_type() {
                raw_ticks += 1;
                if raw_ticks >= TIMEOUT_TICKS {
                    CHOICE = 0;
                    ENDED = true;
                }
            }
        }
        nbgl_layoutRelease(layout);
    }

    let choice = unsafe { CHOICE };
    match choice {
        2 => Choice::Trust,
        1 => Choice::Once,
        _ => Choice::Refuse,
    }
}

/// Unused import guard: `CString` is the type the locals above hold.
const _: Option<CString> = None;
