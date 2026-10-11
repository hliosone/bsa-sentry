//! Security invariant 4: the counters are persisted to NVM **before** the signature leaves
//! the device. `PayFlow` is the state machine the APDU handler must drive, so that a host
//! which cuts power between signing and persisting cannot get a free payment.
use bsa_sentry_core::decide::{FlowError, PayFlow};
use bsa_sentry_core::{Counters, RefusalReason};

fn c(spent: u64, count: u16) -> Counters {
    Counters { spent, count }
}

#[test]
fn a_fresh_flow_is_idle_and_may_not_sign() {
    let f = PayFlow::new();
    assert!(f.is_idle());
    assert!(!f.may_sign());
    assert_eq!(f.pending_counters(), None);
}

#[test]
fn the_happy_path_is_approve_persist_sign() {
    let mut f = PayFlow::new();
    let next = f.approve(c(3_000_000, 1), 4_500_000).unwrap();
    assert_eq!(next, c(7_500_000, 2));
    assert_eq!(f.pending_counters(), Some(c(7_500_000, 2)));

    assert!(!f.may_sign(), "signing before persisting must be impossible");
    f.mark_persisted().unwrap();
    assert!(f.may_sign());
    f.mark_signed().unwrap();
    assert!(!f.may_sign(), "the permit is single use");
}

#[test]
fn signing_without_persisting_is_rejected() {
    let mut f = PayFlow::new();
    f.approve(c(0, 0), 1_000_000).unwrap();
    assert_eq!(f.mark_signed(), Err(FlowError::OutOfOrder));
    assert!(!f.may_sign());
}

#[test]
fn signing_without_approving_is_rejected() {
    let mut f = PayFlow::new();
    assert_eq!(f.mark_signed(), Err(FlowError::OutOfOrder));
    assert_eq!(f.mark_persisted(), Err(FlowError::OutOfOrder));
}

#[test]
fn persisting_twice_is_rejected() {
    let mut f = PayFlow::new();
    f.approve(c(0, 0), 1).unwrap();
    f.mark_persisted().unwrap();
    assert_eq!(f.mark_persisted(), Err(FlowError::OutOfOrder));
}

#[test]
fn signing_twice_is_rejected_so_one_approval_buys_one_signature() {
    let mut f = PayFlow::new();
    f.approve(c(0, 0), 1).unwrap();
    f.mark_persisted().unwrap();
    f.mark_signed().unwrap();
    assert_eq!(f.mark_signed(), Err(FlowError::OutOfOrder));
}

#[test]
fn a_second_approval_without_finishing_the_first_is_rejected() {
    let mut f = PayFlow::new();
    f.approve(c(0, 0), 1_000_000).unwrap();
    assert!(f.approve(c(0, 0), 2_000_000).is_err(), "two payments must not be in flight at once");
    // The first payment's counters are untouched by the rejected second approval.
    assert_eq!(f.pending_counters(), Some(c(1_000_000, 1)));
}

#[test]
fn abort_returns_to_idle_and_forgets_the_counters() {
    let mut f = PayFlow::new();
    f.approve(c(5, 1), 7).unwrap();
    f.abort();
    assert!(f.is_idle());
    assert!(!f.may_sign());
    assert_eq!(f.pending_counters(), None);
    // And a fresh payment can start.
    assert_eq!(f.approve(c(5, 1), 7).unwrap(), c(12, 2));
}

#[test]
fn aborting_after_persisting_still_returns_to_idle() {
    // Refusal or an error after the write: the counters stay spent on the device, which is
    // the safe direction (the user is never charged twice, and the agent never gets a
    // free payment out of a half-finished flow).
    let mut f = PayFlow::new();
    f.approve(c(0, 0), 1).unwrap();
    f.mark_persisted().unwrap();
    f.abort();
    assert!(f.is_idle());
    assert!(!f.may_sign());
}

#[test]
fn an_overflowing_approval_is_refused_and_leaves_the_flow_idle() {
    let mut f = PayFlow::new();
    assert_eq!(f.approve(c(u64::MAX, 0), 1), Err(RefusalReason::InvalidAmount));
    assert!(f.is_idle(), "a refused approval must not leave the flow half-open");
    assert_eq!(f.approve(c(0, 0), 1).unwrap(), c(1, 1));
}

#[test]
fn an_overflowing_count_is_refused() {
    let mut f = PayFlow::new();
    assert_eq!(f.approve(c(0, u16::MAX), 1), Err(RefusalReason::InvalidAmount));
    assert!(f.is_idle());
}
