//! Payee-list management. Invariant 3: matching is on the address, labels are display only,
//! and "Une fois" never adds a payee (that one is enforced by the handler, which simply
//! does not call `push_payee`; see tests/apdu_contract.rs).
use bsa_sentry_core::wire::{Payee, MAX_LABEL_BYTES, MAX_PAYEES};
use bsa_sentry_core::Policy;

#[test]
fn an_empty_policy_has_no_payees_and_is_inactive() {
    let p = Policy::empty();
    assert_eq!(p.payee_count, 0);
    assert!(!p.active);
    assert!(!p.payees_full());
    assert_eq!(p.find_payee(&[0u8; 20]), None, "the zero address must not match the zeroed slots");
}

#[test]
fn a_payee_is_found_by_address() {
    let mut p = Policy::empty();
    p.push_payee(Payee::new([0x11; 20], b"Cafe")).unwrap();
    assert!(p.find_payee(&[0x11; 20]).is_some());
    assert!(p.find_payee(&[0x12; 20]).is_none());
}

#[test]
fn one_differing_byte_is_a_different_payee() {
    let mut p = Policy::empty();
    let mut addr = [0x11; 20];
    p.push_payee(Payee::new(addr, b"Cafe")).unwrap();
    addr[19] ^= 0x01;
    assert!(p.find_payee(&addr).is_none());
}

#[test]
fn the_label_plays_no_part_in_matching() {
    let mut p = Policy::empty();
    p.push_payee(Payee::new([0x11; 20], b"Cafe Sat")).unwrap();
    // Same address, different label: still the same payee.
    let found = p.find_payee(&[0x11; 20]).unwrap();
    assert_eq!(found.label(), b"Cafe Sat");
    // Two labels never collide into a match.
    assert!(p.find_payee(&[0x22; 20]).is_none());
}

#[test]
fn a_long_label_is_truncated_to_the_byte_budget() {
    let payee = Payee::new([0x11; 20], b"a-very-long-merchant-name");
    assert_eq!(payee.label_len(), MAX_LABEL_BYTES);
    assert_eq!(payee.label(), b"a-very-long-merc");
}

#[test]
fn an_empty_label_is_allowed() {
    let payee = Payee::new([0x11; 20], b"");
    assert_eq!(payee.label_len(), 0);
    assert_eq!(payee.label(), b"");
}

#[test]
fn the_list_fills_to_eight_then_refuses() {
    let mut p = Policy::empty();
    for i in 0..MAX_PAYEES {
        assert!(!p.payees_full());
        p.push_payee(Payee::new([i as u8 + 1; 20], b"x")).unwrap();
    }
    assert!(p.payees_full());
    assert_eq!(p.payee_count, MAX_PAYEES);
    assert_eq!(p.push_payee(Payee::new([0xff; 20], b"one too many")), Err(()));
    assert_eq!(p.payee_count, MAX_PAYEES, "a refused push must not grow the list");
}

#[test]
fn pushing_an_address_that_is_already_trusted_does_not_waste_a_slot() {
    let mut p = Policy::empty();
    p.push_payee(Payee::new([0x11; 20], b"Cafe")).unwrap();
    p.push_payee(Payee::new([0x11; 20], b"Cafe again")).unwrap();
    assert_eq!(p.payee_count, 1);
    assert_eq!(p.find_payee(&[0x11; 20]).unwrap().label(), b"Cafe", "the first label is kept");
}

#[test]
fn removing_a_payee_keeps_the_rest_in_order() {
    let mut p = Policy::empty();
    for i in 1..=3u8 {
        p.push_payee(Payee::new([i; 20], &[b'a' + i - 1])).unwrap();
    }
    assert!(p.remove_payee(&[2; 20]));
    assert_eq!(p.payee_count, 2);
    assert_eq!(p.payees()[0].addr, [1; 20]);
    assert_eq!(p.payees()[1].addr, [3; 20]);
    assert!(p.find_payee(&[2; 20]).is_none());
}

#[test]
fn removing_an_absent_payee_changes_nothing() {
    let mut p = Policy::empty();
    p.push_payee(Payee::new([0x11; 20], b"Cafe")).unwrap();
    assert!(!p.remove_payee(&[0x99; 20]));
    assert_eq!(p.payee_count, 1);
}

#[test]
fn removing_the_last_payee_empties_the_list_and_clears_the_slot() {
    let mut p = Policy::empty();
    p.push_payee(Payee::new([0x11; 20], b"Cafe")).unwrap();
    assert!(p.remove_payee(&[0x11; 20]));
    assert_eq!(p.payee_count, 0);
    assert_eq!(p.payees().len(), 0);
    // The freed slot must not keep the old address where a later find could see it.
    assert_eq!(p.payees[0], Payee::default());
}

#[test]
fn removing_frees_a_slot_so_trust_becomes_possible_again() {
    let mut p = Policy::empty();
    for i in 0..MAX_PAYEES {
        p.push_payee(Payee::new([i as u8 + 1; 20], b"x")).unwrap();
    }
    assert!(p.payees_full());
    p.remove_payee(&[1; 20]);
    assert!(!p.payees_full());
    p.push_payee(Payee::new([0xff; 20], b"new")).unwrap();
    assert_eq!(p.payee_count, MAX_PAYEES);
}
