//! Test 5: a review screen with three choices and an automatic 60 s rejection.
//!
//! The SDK's blocking NBGL wrappers only offer two choices and no timeout, so this builds the
//! screen with the NBGL layout C API and runs its own event loop. The device has no clock: time is
//! measured by counting the SDK's raw ticker events (one every 100 ms) in our own event loop.
use crate::handlers::sign_tx::TxContext;
use crate::AppSW;
use ledger_device_sdk::io::{Command, CommandResponse, DecodedEventType};
use ledger_device_sdk::sys::*;

pub const CHOICE_REFUSER: u8 = 0;
pub const CHOICE_UNE_FOIS: u8 = 1;
pub const CHOICE_FAIRE_CONFIANCE: u8 = 2;

const TOKEN_CHOICE: u8 = 1;
const TOKEN_REFUSER: u8 = 2;
/// SEPROXYHAL ticker events arrive every 100 ms (measured: 600 events in 60 s), so 600 = 60 s.
const TIMEOUT_TICKS: u32 = 600;

static mut ENDED: bool = false;
static mut CHOICE: u8 = CHOICE_REFUSER;
static mut TIMED_OUT: bool = false;
static mut SECONDS: u32 = 0;

unsafe extern "C" fn on_action(token: core::ffi::c_int, index: u8) {
    CHOICE = match (token as u8, index) {
        (TOKEN_CHOICE, 0) => CHOICE_FAIRE_CONFIANCE,
        (TOKEN_CHOICE, 1) => CHOICE_UNE_FOIS,
        _ => CHOICE_REFUSER,
    };
    ENDED = true;
}

/// Called by NBGL every `tickerIntervale` ms while the layout is shown. Diagnostic only: this
/// ticker pauses while the screen is touched, so the timeout uses raw ticker events instead.
unsafe extern "C" fn on_second() {
    SECONDS += 1;
}

/// REVIEW_3: shows the 3-choice screen. Reply: choice(1) | timed_out(1) | seconds(4) | raw_ticks(4).
/// choice: 0 = Refuser (also on timeout), 1 = Une fois, 2 = Faire confiance.
pub fn handler_review3<'a>(
    command: Command<'a>,
    ctx: &mut TxContext,
) -> Result<CommandResponse<'a>, AppSW> {
    unsafe {
        ENDED = false;
        CHOICE = CHOICE_REFUSER;
        TIMED_OUT = false;
        SECONDS = 0;
    }
    let comm = command.into_comm();
    let mut raw_ticks: u32 = 0;
    unsafe {
        let desc = nbgl_layoutDescription_t {
            modal: false,
            withLeftBorder: false,
            tapActionText: core::ptr::null(),
            tapActionToken: 0,
            tapTuneId: NB_TUNES,
            onActionCallback: Some(on_action),
            ticker: nbgl_screenTickerConfiguration_t {
                tickerCallback: Some(on_second),
                tickerValue: 1000,
                tickerIntervale: 1000,
            },
        };
        let layout = nbgl_layoutGet(&desc);
        // Header: "Refuser" as a touchable text. HEADER_RIGHT_TEXT makes the whole header bar the touch
        // target (HEADER_BACK_AND_TEXT only makes its arrow touchable, and drew no arrow here).
        let header = nbgl_layoutHeader_t {
            type_: HEADER_RIGHT_TEXT,
            separationLine: true,
            __bindgen_anon_1: nbgl_layoutHeader_t__bindgen_ty_1 {
                rightText: nbgl_layoutHeader_t__bindgen_ty_1__bindgen_ty_6 {
                    text: c"Refuser".as_ptr(),
                    token: TOKEN_REFUSER,
                    tuneId: TUNE_TAP_CASUAL,
                },
            },
        };
        nbgl_layoutAddHeader(layout, &header);
        let center = nbgl_contentCenter_t {
            illustrType: ICON_ILLUSTRATION,
            icon: core::ptr::null(),
            animation: core::ptr::null(),
            animOffsetX: 0,
            animOffsetY: 0,
            title: c"Paiement x402".as_ptr(),
            smallTitle: core::ptr::null(),
            description: c"1 USDC a 0xca43...b62c".as_ptr(),
            subText: c"Rejet automatique dans 60 s".as_ptr(),
            iconHug: 0,
            padding: false,
        };
        nbgl_layoutAddContentCenter(layout, &center);
        // Footer: two stacked rounded buttons sharing one token; NBGL passes index 0 (top) or 1 (bottom).
        let choices = nbgl_layoutChoiceButtons_t {
            topText: c"Faire confiance".as_ptr(),
            bottomText: c"Une fois".as_ptr(),
            topIcon: core::ptr::null(),
            token: TOKEN_CHOICE,
            style: BOTH_ROUNDED_STYLE,
            tuneId: TUNE_TAP_CASUAL,
        };
        nbgl_layoutAddChoiceButtons(layout, &choices);
        nbgl_layoutDraw(layout);
        nbgl_refresh();

        // Pump events ourselves: touch events reach on_action, ticker events reach on_second.
        while !ENDED {
            if let DecodedEventType::Ticker = comm.next_event().into_type() {
                raw_ticks += 1;
                if raw_ticks >= TIMEOUT_TICKS && !ENDED {
                    CHOICE = CHOICE_REFUSER;
                    TIMED_OUT = true;
                    ENDED = true;
                }
            }
        }
        nbgl_layoutRelease(layout);
    }
    ctx.home.show_and_return();

    let mut response = comm.begin_response();
    unsafe {
        response.append(&[CHOICE, TIMED_OUT as u8])?;
        response.append(&SECONDS.to_be_bytes())?;
    }
    response.append(&raw_ticks.to_be_bytes())?;
    Ok(response)
}
