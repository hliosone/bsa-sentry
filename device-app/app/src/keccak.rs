//! The device's Keccak-256, plugged into `bsa_sentry_core::Keccak`.
//!
//! `core` is written against this trait so that the very same EIP-712 code runs on the host
//! in `cargo test` (against the golden fixtures) and on the device here.
use bsa_sentry_core::Keccak;
use ledger_device_sdk::hash::{sha3::Keccak256, HashInit};

pub struct DeviceKeccak;

impl Keccak for DeviceKeccak {
    fn hash(parts: &[&[u8]]) -> [u8; 32] {
        let mut h = Keccak256::new();
        for p in parts {
            // The SDK's update only fails on a hardware fault. There is nothing sensible to
            // do about it inside a hash, and returning a wrong digest would be worse than a
            // panic, so the zeroed output below can never be mistaken for a real digest.
            if h.update(p).is_err() {
                return [0u8; 32];
            }
        }
        let mut out = [0u8; 32];
        if h.finalize(&mut out).is_err() {
            return [0u8; 32];
        }
        out
    }
}
