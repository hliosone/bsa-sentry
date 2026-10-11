//! Pure logic for the BSA Sentry Ledger app.
//!
//! Everything here is `no_std` on the device and plain `cargo test` on the host, so the
//! spending decision, the wire codecs and the EIP-712 digests are all testable without
//! hardware. The crate has no dependencies and forbids `unsafe`: the device app owns all
//! the UI, NVM and SDK calls, and this crate owns the rules.
#![cfg_attr(not(test), no_std)]

pub mod chunk;
pub mod codes;
pub mod decide;
pub mod eip712;
pub mod wire;

pub use codes::{OrangeReason, RefusalReason};
pub use decide::{decide, Counters, Decision, OrangeInfo, PayFlow, Payment, Session};
pub use wire::{Payee, Policy};

/// Keccak-256, supplied by the caller.
///
/// The device implements this over `ledger_device_sdk::hash::sha3::Keccak256`; the host tests
/// implement it over `tiny-keccak`. Keeping it a trait is what lets the EIP-712 digests be
/// checked against the golden fixtures on the host.
pub trait Keccak {
    /// Hash of the concatenation of `parts`, without allocating.
    fn hash(parts: &[&[u8]]) -> [u8; 32];
}
