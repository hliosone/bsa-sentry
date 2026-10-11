//! Device state: the policy and credentials in NVM, the session and the in-flight payment
//! in RAM.
//!
//! All buffers are fixed-size zero-initialised statics: Ledger's link script requires an
//! empty `.data` section, so no `Vec` and no non-zero static initialiser.
//!
//! NVM (`AtomicStorage`) survives an app restart and is wiped when the app is reinstalled,
//! which is exactly why the Key Ring backup and RESTORE exist.
use bsa_sentry_core::chunk::Reassembler;
use bsa_sentry_core::wire::{decode_policy, encode_policy, MAX_LABEL_BYTES};
use bsa_sentry_core::{Counters, PayFlow, Policy, Session};
use ledger_device_sdk::nvm::*;
use ledger_device_sdk::NVMData;

/// Largest encoded policy: 57 header + 8 payees x (20 + 1 + 16).
const POLICY_MAX: usize = 353;
/// Largest credentials bundle, from packages/types/fixtures/wire.json.
const CREDENTIALS_MAX: usize = 512;

/// Policy, counters and the last payment, as `len(2) | bytes`.
#[link_section = ".nvm_data"]
static mut POLICY_NVM: NVMData<AtomicStorage<[u8; POLICY_MAX + 2]>> =
    NVMData::new(AtomicStorage::new(&[0u8; POLICY_MAX + 2]));

/// The spend counters and the last payment, separate from the policy so a payment writes
/// as few bytes as possible.
#[link_section = ".nvm_data"]
static mut COUNTERS_NVM: NVMData<AtomicStorage<[u8; 2 + 8 + 2 + 8 + 1 + MAX_LABEL_BYTES]>> =
    NVMData::new(AtomicStorage::new(&[0u8; 2 + 8 + 2 + 8 + 1 + MAX_LABEL_BYTES]));

/// The 18+ credential bundle, stored verbatim after it was validated.
#[link_section = ".nvm_data"]
static mut CREDENTIALS_NVM: NVMData<AtomicStorage<[u8; CREDENTIALS_MAX + 2]>> =
    NVMData::new(AtomicStorage::new(&[0u8; CREDENTIALS_MAX + 2]));

/// Reassembly buffer for the chunked commands. One at a time, by design.
static mut REASSEMBLER: Reassembler = Reassembler::new();

/// Everything that lives only in RAM. The session in particular: a reboot disarms the agent.
pub struct Runtime {
    pub session: Session,
    pub flow: PayFlow,
}

impl Runtime {
    pub const fn new() -> Self {
        Runtime { session: Session { armed: false }, flow: PayFlow::new() }
    }
}

pub fn reassembler() -> &'static mut Reassembler {
    unsafe { &mut *(&raw mut REASSEMBLER) }
}

// ----------------------------------------------------------------------- policy

fn nvm_read(raw: &[u8], max: usize) -> &[u8] {
    let len = (u16::from_be_bytes([raw[0], raw[1]]) as usize).min(max);
    &raw[2..2 + len]
}

/// The stored policy, or an inactive empty one on a fresh or wiped device.
pub fn policy() -> Policy {
    let cell = &raw const POLICY_NVM;
    let raw = unsafe { (*cell).get_ref() }.get_ref();
    let bytes = nvm_read(raw, POLICY_MAX);
    // A blob we cannot decode is treated as "no policy": refusing every payment is the safe
    // direction, and the user can re-set or restore the rules.
    decode_policy(bytes).unwrap_or_else(|_| Policy::empty())
}

pub fn save_policy(p: &Policy) -> Result<(), ()> {
    let mut value = [0u8; POLICY_MAX + 2];
    let n = encode_policy(p, &mut value[2..]).map_err(|_| ())?;
    value[..2].copy_from_slice(&(n as u16).to_be_bytes());
    let cell = &raw mut POLICY_NVM;
    unsafe { (*cell).get_mut() }.update(&value);
    Ok(())
}

/// Clears the policy and the counters. The kill switch, and what SET_POLICY starts from.
pub fn clear_policy() {
    let _ = save_policy(&Policy::empty());
    save_counters(&Counters::default(), 0, &[]);
}

// ----------------------------------------------------------------------- counters

/// `spent(8) | count(2) | last_value(8) | last_label_len(1) | last_label(16)`
pub fn counters() -> (Counters, u64, ([u8; MAX_LABEL_BYTES], usize)) {
    let cell = &raw const COUNTERS_NVM;
    let raw = unsafe { (*cell).get_ref() }.get_ref();
    let bytes = nvm_read(raw, raw.len() - 2);
    if bytes.len() < 19 {
        return (Counters::default(), 0, ([0u8; MAX_LABEL_BYTES], 0));
    }
    let mut w8 = [0u8; 8];
    w8.copy_from_slice(&bytes[0..8]);
    let spent = u64::from_be_bytes(w8);
    let count = u16::from_be_bytes([bytes[8], bytes[9]]);
    w8.copy_from_slice(&bytes[10..18]);
    let last_value = u64::from_be_bytes(w8);
    let label_len = (bytes[18] as usize).min(MAX_LABEL_BYTES).min(bytes.len() - 19);
    let mut label = [0u8; MAX_LABEL_BYTES];
    label[..label_len].copy_from_slice(&bytes[19..19 + label_len]);
    (Counters { spent, count }, last_value, (label, label_len))
}

pub fn save_counters(c: &Counters, last_value: u64, last_label: &[u8]) {
    let len = last_label.len().min(MAX_LABEL_BYTES);
    let mut body = [0u8; 8 + 2 + 8 + 1 + MAX_LABEL_BYTES];
    body[0..8].copy_from_slice(&c.spent.to_be_bytes());
    body[8..10].copy_from_slice(&c.count.to_be_bytes());
    body[10..18].copy_from_slice(&last_value.to_be_bytes());
    body[18] = len as u8;
    body[19..19 + len].copy_from_slice(&last_label[..len]);

    let mut value = [0u8; 2 + 8 + 2 + 8 + 1 + MAX_LABEL_BYTES];
    value[..2].copy_from_slice(&(body.len() as u16).to_be_bytes());
    value[2..].copy_from_slice(&body);
    let cell = &raw mut COUNTERS_NVM;
    unsafe { (*cell).get_mut() }.update(&value);
}

// ----------------------------------------------------------------------- credentials

pub fn credentials() -> &'static [u8] {
    let cell = &raw const CREDENTIALS_NVM;
    let raw = unsafe { (*cell).get_ref() }.get_ref();
    nvm_read(raw, CREDENTIALS_MAX)
}

pub fn save_credentials(blob: &[u8]) -> Result<(), ()> {
    if blob.len() > CREDENTIALS_MAX {
        return Err(());
    }
    let mut value = [0u8; CREDENTIALS_MAX + 2];
    value[..2].copy_from_slice(&(blob.len() as u16).to_be_bytes());
    value[2..2 + blob.len()].copy_from_slice(blob);
    let cell = &raw mut CREDENTIALS_NVM;
    unsafe { (*cell).get_mut() }.update(&value);
    Ok(())
}

pub fn has_credentials() -> bool {
    !credentials().is_empty()
}
