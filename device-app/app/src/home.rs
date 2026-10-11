//! The Flex's own home screen and menu.
//!
//! Everything here works with no website and no server: the user can see the budget, arm or
//! stop the agent, read the rules, remove a trusted merchant, refill the budget, and block the
//! agent. The kill switch lives here on purpose: it is for the moment the website or the server
//! can no longer be trusted.
//!
//! Built on the NBGL C API (`nbgl_useCaseHomeAndSettings`) because the SDK's safe wrapper only
//! supports a settings page of switches. Menu actions use NBGL's native asynchronous style: a
//! tap draws a non-blocking confirmation, whose callback updates NVM and redraws the home. No
//! blocking screen is ever opened from inside a callback.
use crate::fmt;
use crate::store;
use alloc::ffi::CString;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use bsa_sentry_core::wire::decode_credentials;
use bsa_sentry_core::Counters;
use core::ffi::{c_char, c_int};
use core::mem::MaybeUninit;
use ledger_device_sdk::include_gif;
use ledger_device_sdk::nbgl::NbglGlyph;
use ledger_device_sdk::sys::*;

#[cfg(any(target_os = "stax", target_os = "flex"))]
const ICON: NbglGlyph = NbglGlyph::from_include(include_gif!("glyphs/crab_64x64.gif", NBGL));
#[cfg(target_os = "apex_p")]
const ICON: NbglGlyph = NbglGlyph::from_include(include_gif!("glyphs/crab_48x48.png", NBGL));
#[cfg(any(target_os = "nanosplus", target_os = "nanox"))]
const ICON: NbglGlyph = NbglGlyph::from_include(include_gif!("glyphs/home_nano_nbgl.png", NBGL));

// Settings pages, in order: 0 session switch (where users look first), 1 rules,
// 2 trusted merchants, 3 actions.
const TOKEN_SESSION: u8 = FIRST_USER_TOKEN as u8;
const TOKEN_MERCHANT: u8 = FIRST_USER_TOKEN as u8 + 10; // + index, up to 8 merchants
const TOKEN_RESET: u8 = FIRST_USER_TOKEN as u8 + 30;
const TOKEN_BLOCK: u8 = FIRST_USER_TOKEN as u8 + 31;
/// Draw the home page itself rather than a settings page.
pub const HOME: u8 = INIT_HOME_PAGE as u8;

/// Everything NBGL points at while the home or the menu is displayed. Rebuilt on every draw;
/// the C strings are owned here so their buffers outlive the screen.
struct Ui {
    #[allow(dead_code)] // never read: owned so the pointers NBGL holds stay valid
    strings: Vec<CString>,
    switches: [nbgl_contentSwitch_t; 1],
    pairs: Vec<nbgl_contentTagValue_t>,
    merchant_ptrs: Vec<*const c_char>,
    merchant_tokens: Vec<u8>,
    action_ptrs: [*const c_char; 2],
    action_tokens: [u8; 2],
    contents: [nbgl_content_t; 4],
    generic: nbgl_genericContents_t,
    info_types: [*const c_char; 2],
    info_contents: [*const c_char; 2],
    infos: nbgl_contentInfoList_t,
    icon: nbgl_icon_details_t,
}

// Uninit statics live in .bss: Ledger's link script rejects a non-empty .data section.
static mut UI: MaybeUninit<Ui> = MaybeUninit::uninit();
static mut UI_LIVE: bool = false;

/// The strings of the confirmation currently on screen.
static mut CONFIRM: MaybeUninit<[CString; 4]> = MaybeUninit::uninit();
static mut CONFIRM_LIVE: bool = false;
static mut PENDING: Pending = Pending::None;

#[derive(Clone, Copy)]
enum Pending {
    None,
    /// By address, the one the confirmation shows: never by position in the list.
    RemoveMerchant([u8; 20]),
    ResetBudget,
    Block,
}

/// Interns a string for the lifetime of the current screen and returns its C pointer.
fn s(strings: &mut Vec<CString>, text: &str) -> *const c_char {
    strings.push(fmt::cstr(text));
    strings.last().unwrap().as_ptr()
}

/// "17.00": the home screen shows the budget with cents, like a bank balance.
fn usdc2(units: u64) -> String {
    format!("{}.{:02}", units / 1_000_000, (units % 1_000_000) / 10_000)
}

/// At most four short lines: NBGL wraps anything longer than ~28 characters, and a fifth line
/// pushes the text into the "Quit app" bar. The token is on the budget line, so the last line
/// only needs the network.
fn tagline(policy: &bsa_sentry_core::Policy, counters: &Counters, last: (u64, &[u8]), armed: bool, agent_name: Option<String>) -> String {
    let status = format!("{} . session {}", fmt::chain_name(policy.chain_id), if armed { "on" } else { "off" });
    if !policy.active {
        return format!("Aucune regle :\ndefinis-les sur le site\nsession {}", if armed { "on" } else { "off" });
    }
    let left = policy.budget.saturating_sub(counters.spent);
    let mut out = String::new();
    if let Some(name) = agent_name {
        out.push_str(&format!("Agent : {}\n", fmt::clip(&name, 18)));
    }
    out.push_str(&format!("Budget {} / {} USDC\n", usdc2(left), usdc2(policy.budget)));
    if last.0 > 0 {
        out.push_str(&format!("Dernier : {} {}\n", fmt::clip(&fmt::untrusted_text(last.1), 10), fmt::amount_usdc(last.0)));
    }
    out.push_str(&status);
    out
}

/// Draws the home (`HOME`) or a settings page (0..=3), from the current device state.
pub fn show(page: u8) {
    let policy = store::policy();
    let (counters, last_value, (last_label, last_len)) = store::counters();
    let armed = store::session().armed;
    // Only a bundle the device verified against its own keys is ever stored.
    let agent_name = decode_credentials(store::credentials()).ok().map(|c| fmt::untrusted_text(c.delegation.agent_name()));

    let mut strings: Vec<CString> = Vec::new();
    let tag = tagline(&policy, &counters, (last_value, &last_label[..last_len]), armed, agent_name);
    let app_name = s(&mut strings, "BSA Sentry");
    let tagline_ptr = s(&mut strings, &tag);

    // Page 1: the rules, read-only.
    let mut rows: Vec<(String, String)> = Vec::new();
    if policy.active {
        rows.push((String::from("Reseau"), fmt::chain_name(policy.chain_id)));
        rows.push((String::from("Sans confirmation jusqu'a"), fmt::amount_usdc(policy.auto_max)));
        rows.push((String::from("Plafond absolu"), fmt::amount_usdc(policy.hard_max)));
        rows.push((String::from("Budget"), format!("{} sur {}", fmt::amount_usdc(counters.spent), fmt::amount_usdc(policy.budget))));
        rows.push((String::from("Paiements"), format!("{} sur {}", counters.count, policy.max_count)));
    } else {
        rows.push((String::from("Regles"), String::from("Aucune")));
    }
    let mut pairs: Vec<nbgl_contentTagValue_t> = Vec::new();
    for (item, value) in &rows {
        let item = s(&mut strings, item);
        let value = s(&mut strings, value);
        pairs.push(nbgl_contentTagValue_t { item, value, ..Default::default() });
    }

    // Page 2: trusted merchants, tap one to remove it.
    let mut merchant_ptrs: Vec<*const c_char> = Vec::new();
    let mut merchant_tokens: Vec<u8> = Vec::new();
    for (i, p) in policy.payees().iter().enumerate() {
        merchant_ptrs.push(s(&mut strings, &format!("Retirer : {}", fmt::untrusted_text(p.label()))));
        merchant_tokens.push(TOKEN_MERCHANT + i as u8);
    }
    if merchant_ptrs.is_empty() {
        merchant_ptrs.push(s(&mut strings, "Aucun marchand de confiance"));
        merchant_tokens.push(0);
    }

    // Page 3: actions.
    let action_ptrs = [s(&mut strings, "+20 USDC (budget a zero)"), s(&mut strings, "Bloquer l'agent")];
    let session_text = s(&mut strings, "Agent session");
    let session_sub = s(&mut strings, "Autorise l'agent a demander des paiements. Un redemarrage l'arrete.");
    let info_types = [s(&mut strings, "Version"), s(&mut strings, "Developer")];
    let info_contents = [s(&mut strings, env!("CARGO_PKG_VERSION")), s(&mut strings, "BSA - EPFL Blockchain Student Association")];

    unsafe {
        let slot = &mut *(&raw mut UI);
        if UI_LIVE {
            slot.assume_init_drop();
        }
        slot.write(Ui {
            strings,
            switches: [nbgl_contentSwitch_t {
                text: session_text,
                subText: session_sub,
                initState: if armed { ON_STATE } else { OFF_STATE },
                token: TOKEN_SESSION,
                tuneId: TUNE_TAP_CASUAL,
            }],
            pairs,
            merchant_ptrs,
            merchant_tokens,
            action_ptrs,
            action_tokens: [TOKEN_RESET, TOKEN_BLOCK],
            contents: core::mem::zeroed(),
            generic: core::mem::zeroed(),
            info_types,
            info_contents,
            infos: core::mem::zeroed(),
            icon: (&ICON).into(),
        });
        UI_LIVE = true;
        // Pointers into the static are only taken once it sits at its final address.
        let ui = slot.assume_init_mut();
        ui.contents[0] = nbgl_content_t {
            type_: SWITCHES_LIST,
            content: nbgl_content_u { switchesList: nbgl_pageSwitchesList_s { switches: ui.switches.as_ptr(), nbSwitches: 1 } },
            contentActionCallback: Some(on_menu),
        };
        ui.contents[1] = nbgl_content_t {
            type_: TAG_VALUE_LIST,
            content: nbgl_content_u {
                tagValueList: nbgl_contentTagValueList_t { pairs: ui.pairs.as_ptr(), nbPairs: ui.pairs.len() as u8, ..Default::default() },
            },
            contentActionCallback: None,
        };
        ui.contents[2] = nbgl_content_t {
            type_: BARS_LIST,
            content: nbgl_content_u {
                barsList: nbgl_contentBarsList_t {
                    barTexts: ui.merchant_ptrs.as_ptr(),
                    tokens: ui.merchant_tokens.as_ptr(),
                    nbBars: ui.merchant_ptrs.len() as u8,
                    tuneId: TUNE_TAP_CASUAL,
                },
            },
            contentActionCallback: Some(on_menu),
        };
        ui.contents[3] = nbgl_content_t {
            type_: BARS_LIST,
            content: nbgl_content_u {
                barsList: nbgl_contentBarsList_t { barTexts: ui.action_ptrs.as_ptr(), tokens: ui.action_tokens.as_ptr(), nbBars: 2, tuneId: TUNE_TAP_CASUAL },
            },
            contentActionCallback: Some(on_menu),
        };
        ui.generic = nbgl_genericContents_t {
            callbackCallNeeded: false,
            __bindgen_anon_1: nbgl_genericContents_t__bindgen_ty_1 { contentsList: ui.contents.as_ptr() },
            nbContents: 4,
        };
        ui.infos = nbgl_contentInfoList_t {
            infoTypes: ui.info_types.as_ptr(),
            infoContents: ui.info_contents.as_ptr(),
            nbInfos: 2,
            infoExtensions: core::ptr::null(),
            token: 0,
            withExtensions: false,
        };
        nbgl_useCaseHomeAndSettings(app_name, &ui.icon, tagline_ptr, page, &ui.generic, &ui.infos, core::ptr::null(), Some(on_quit));
    }
}

unsafe extern "C" fn on_quit() {
    ledger_device_sdk::exit_app(0);
}

unsafe extern "C" fn on_menu(token: c_int, _index: u8, page: c_int) {
    let token = token as u8;
    if token == TOKEN_SESSION {
        store::set_session(!store::session().armed);
        show(page as u8);
    } else if (TOKEN_MERCHANT..TOKEN_MERCHANT + 8).contains(&token) {
        let i = token - TOKEN_MERCHANT;
        let policy = store::policy();
        if let Some(p) = policy.payees().get(i as usize) {
            confirm(
                Pending::RemoveMerchant(p.addr),
                &format!("Retirer {} ?", fmt::untrusted_text(p.label())),
                &fmt::address(&p.addr),
                "Oui, retirer",
            );
        }
    } else if token == TOKEN_RESET {
        let (c, _, _) = store::counters();
        confirm(Pending::ResetBudget, "Remettre le budget a zero ?", &format!("Depense : {} repart a 0", fmt::amount_usdc(c.spent)), "Oui, remettre a zero");
    } else if token == TOKEN_BLOCK {
        confirm(Pending::Block, "Bloquer l'agent ?", "Les regles et les marchands de confiance seront effaces.", "Oui, bloquer");
    }
}

fn confirm(action: Pending, message: &str, sub: &str, yes: &str) {
    unsafe {
        let slot = &mut *(&raw mut CONFIRM);
        if CONFIRM_LIVE {
            slot.assume_init_drop();
        }
        slot.write([fmt::cstr(message), fmt::cstr(sub), fmt::cstr(yes), fmt::cstr("Annuler")]);
        CONFIRM_LIVE = true;
        PENDING = action;
        let c = slot.assume_init_ref();
        nbgl_useCaseChoice(core::ptr::null(), c[0].as_ptr(), c[1].as_ptr(), c[2].as_ptr(), c[3].as_ptr(), Some(on_confirm));
    }
}

unsafe extern "C" fn on_confirm(yes: bool) {
    let action = PENDING;
    PENDING = Pending::None;
    if yes {
        match action {
            Pending::RemoveMerchant(addr) => {
                let mut policy = store::policy();
                if policy.remove_payee(&addr) {
                    let _ = store::save_policy(&policy);
                }
            }
            Pending::ResetBudget => {
                let (_, last_value, (label, len)) = store::counters();
                store::save_counters(&Counters { spent: 0, count: 0 }, last_value, &label[..len]);
            }
            Pending::Block => store::clear_policy(),
            Pending::None => {}
        }
    }
    show(HOME);
}
