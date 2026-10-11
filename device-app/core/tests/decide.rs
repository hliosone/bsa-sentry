//! `decide()` is the whole product: it is the only thing standing between an AI agent and
//! the user's money. One test per rule, plus the ordering between rules, because a rule that
//! fires in the wrong order is a bypass.
use bsa_sentry_core::{decide, Counters, Decision, OrangeReason, Payee, Payment, Policy, RefusalReason, Session};

const TOKEN: [u8; 20] = [0x36, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const OTHER_TOKEN: [u8; 20] = [0x99; 20];
const CAFE: [u8; 20] = [0x11; 20];
const CAVE: [u8; 20] = [0x22; 20];
const RESTO: [u8; 20] = [0x33; 20];
const STRANGER: [u8; 20] = [0xee; 20];
const ARC: u64 = 5042002;

const USDC: u64 = 1_000_000;

/// The demo policy: auto 5, hard 50, budget 20, 10 payments, cafe/cave/resto.
fn demo() -> Policy {
    let mut p = Policy::empty();
    p.active = true;
    p.chain_id = ARC;
    p.token = TOKEN;
    p.auto_max = 5 * USDC;
    p.hard_max = 50 * USDC;
    p.budget = 20 * USDC;
    p.max_count = 10;
    p.push_payee(Payee::new(CAFE, b"Cafe Sat")).unwrap();
    p.push_payee(Payee::new(CAVE, b"Cave du Coin")).unwrap();
    p.push_payee(Payee::new(RESTO, b"Resto")).unwrap();
    p
}

fn armed() -> Session {
    Session { armed: true }
}

fn pay(to: [u8; 20], value: u64) -> Payment {
    Payment { chain_id: ARC, token: TOKEN, to, value: Payment::value_from_u64(value) }
}

fn zero() -> Counters {
    Counters { spent: 0, count: 0 }
}

// ---------------------------------------------------------------- refusals, in rule order

#[test]
fn no_policy_is_refused_even_with_an_armed_session() {
    let p = Policy::empty(); // active == false
    assert_eq!(decide(&p, &zero(), &armed(), &pay(CAFE, USDC)), Decision::Refuse(RefusalReason::NoPolicy));
}

#[test]
fn no_policy_is_checked_before_no_session() {
    // Both are wrong; the spec fixes the order, and NO_POLICY must win.
    let p = Policy::empty();
    let disarmed = Session { armed: false };
    assert_eq!(decide(&p, &zero(), &disarmed, &pay(CAFE, USDC)), Decision::Refuse(RefusalReason::NoPolicy));
}

#[test]
fn a_disarmed_session_refuses_even_a_perfect_payment() {
    let disarmed = Session { armed: false };
    assert_eq!(decide(&demo(), &zero(), &disarmed, &pay(CAFE, USDC)), Decision::Refuse(RefusalReason::NoSession));
}

#[test]
fn no_session_is_checked_before_the_chain_and_token() {
    let disarmed = Session { armed: false };
    let mut payment = pay(CAFE, USDC);
    payment.chain_id = 1;
    payment.token = OTHER_TOKEN;
    assert_eq!(decide(&demo(), &zero(), &disarmed, &payment), Decision::Refuse(RefusalReason::NoSession));
}

#[test]
fn the_wrong_chain_is_refused() {
    let mut payment = pay(CAFE, USDC);
    payment.chain_id = 1; // Ethereum mainnet
    assert_eq!(decide(&demo(), &zero(), &armed(), &payment), Decision::Refuse(RefusalReason::WrongChainOrToken));
}

#[test]
fn the_wrong_token_is_refused_even_on_the_right_chain() {
    let mut payment = pay(CAFE, USDC);
    payment.token = OTHER_TOKEN;
    assert_eq!(decide(&demo(), &zero(), &armed(), &payment), Decision::Refuse(RefusalReason::WrongChainOrToken));
}

#[test]
fn a_token_that_differs_in_one_byte_is_still_the_wrong_token() {
    let mut payment = pay(CAFE, USDC);
    payment.token[19] = 0x01;
    assert_eq!(decide(&demo(), &zero(), &armed(), &payment), Decision::Refuse(RefusalReason::WrongChainOrToken));
}

#[test]
fn the_chain_and_token_are_checked_before_the_amount() {
    let mut payment = pay(CAFE, 0);
    payment.chain_id = 1;
    assert_eq!(decide(&demo(), &zero(), &armed(), &payment), Decision::Refuse(RefusalReason::WrongChainOrToken));
}

#[test]
fn a_zero_amount_is_refused() {
    assert_eq!(decide(&demo(), &zero(), &armed(), &pay(CAFE, 0)), Decision::Refuse(RefusalReason::InvalidAmount));
}

#[test]
fn the_amount_is_checked_before_the_hard_max() {
    // value 0 is both "invalid" and (trivially) not over hard_max; INVALID_AMOUNT must win.
    assert_eq!(decide(&demo(), &zero(), &armed(), &pay(STRANGER, 0)), Decision::Refuse(RefusalReason::InvalidAmount));
}

#[test]
fn over_the_hard_max_is_refused_for_a_trusted_payee_too() {
    assert_eq!(
        decide(&demo(), &zero(), &armed(), &pay(CAFE, 51 * USDC)),
        Decision::Refuse(RefusalReason::OverHardMax)
    );
}

#[test]
fn exactly_the_hard_max_is_not_over_it() {
    // 50 USDC is <= hard_max, so it survives rule 5 and lands on an orange screen
    // (over auto_max, and over the remaining budget).
    assert!(matches!(decide(&demo(), &zero(), &armed(), &pay(CAFE, 50 * USDC)), Decision::Orange(_)));
}

#[test]
fn the_hard_max_is_checked_before_the_unknown_payee() {
    // The evil deposit: 400 USDC to an address that is not in the policy. The spec requires
    // OVER_HARD_MAX, not UNKNOWN_PAYEE, so the user is never offered "trust this merchant".
    let d = decide(&demo(), &zero(), &armed(), &pay(STRANGER, 400 * USDC));
    assert_eq!(d, Decision::Refuse(RefusalReason::OverHardMax));
}

#[test]
fn a_value_too_large_for_a_u64_is_over_the_hard_max_not_an_overflow() {
    // The APDU carries a u256. Anything above u64::MAX cannot be under a u64 hard_max.
    let payment = Payment { chain_id: ARC, token: TOKEN, to: CAFE, value: [0xff; 32] };
    assert_eq!(decide(&demo(), &zero(), &armed(), &payment), Decision::Refuse(RefusalReason::OverHardMax));

    let mut just_over = [0u8; 32];
    just_over[23] = 0x01; // 2^64, one more than u64::MAX
    let payment = Payment { chain_id: ARC, token: TOKEN, to: CAFE, value: just_over };
    assert_eq!(decide(&demo(), &zero(), &armed(), &payment), Decision::Refuse(RefusalReason::OverHardMax));
}

#[test]
fn the_u64_maximum_itself_is_handled_without_wrapping() {
    let mut p = demo();
    p.hard_max = u64::MAX;
    p.auto_max = u64::MAX;
    p.budget = u64::MAX;
    let payment = Payment { chain_id: ARC, token: TOKEN, to: CAFE, value: Payment::value_from_u64(u64::MAX) };
    assert_eq!(decide(&p, &zero(), &armed(), &payment), Decision::Auto);
}

// ---------------------------------------------------------------- the silent path

#[test]
fn a_known_payee_within_every_limit_signs_silently() {
    assert_eq!(decide(&demo(), &zero(), &armed(), &pay(CAFE, 3 * USDC)), Decision::Auto);
}

#[test]
fn exactly_the_auto_max_is_still_automatic() {
    assert_eq!(decide(&demo(), &zero(), &armed(), &pay(CAFE, 5 * USDC)), Decision::Auto);
}

#[test]
fn spending_exactly_the_remaining_budget_is_automatic() {
    let c = Counters { spent: 15 * USDC, count: 3 };
    assert_eq!(decide(&demo(), &c, &armed(), &pay(CAFE, 5 * USDC)), Decision::Auto);
}

#[test]
fn the_last_allowed_payment_by_count_is_automatic() {
    let c = Counters { spent: 0, count: 9 }; // max_count is 10
    assert_eq!(decide(&demo(), &c, &armed(), &pay(CAFE, USDC)), Decision::Auto);
}

#[test]
fn every_payee_in_the_list_is_matched_by_address() {
    for to in [CAFE, CAVE, RESTO] {
        assert_eq!(decide(&demo(), &zero(), &armed(), &pay(to, USDC)), Decision::Auto);
    }
}

// ---------------------------------------------------------------- the orange screen

#[test]
fn an_unknown_payee_raises_an_orange_screen_and_may_be_trusted() {
    let d = decide(&demo(), &zero(), &armed(), &pay(STRANGER, 2 * USDC));
    assert_eq!(d.orange_reason(), Some(OrangeReason::UnknownPayee));
    assert_eq!(d.trust_allowed(), Some(true));
}

#[test]
fn over_the_auto_max_raises_an_orange_screen_without_the_trust_option() {
    // The restaurant: 20 USDC to a known payee. Trusting it would change nothing, so the
    // device must not offer it.
    let d = decide(&demo(), &zero(), &armed(), &pay(RESTO, 20 * USDC));
    assert_eq!(d.orange_reason(), Some(OrangeReason::OverAutoMax));
    assert_eq!(d.trust_allowed(), Some(false));
}

#[test]
fn an_unknown_payee_that_is_also_over_the_auto_max_reports_the_payee_but_forbids_trust() {
    // "Trust" is only offered when the unknown payee is the ONLY problem.
    let d = decide(&demo(), &zero(), &armed(), &pay(STRANGER, 10 * USDC));
    assert_eq!(d.orange_reason(), Some(OrangeReason::UnknownPayee));
    assert_eq!(d.trust_allowed(), Some(false));
}

#[test]
fn trust_is_unavailable_when_the_payee_list_is_full() {
    let mut p = demo();
    while p.payee_count < bsa_sentry_core::wire::MAX_PAYEES {
        let n = p.payee_count as u8;
        p.push_payee(Payee::new([0x40 + n; 20], b"filler")).unwrap();
    }
    assert_eq!(p.payee_count, bsa_sentry_core::wire::MAX_PAYEES);
    let d = decide(&p, &zero(), &armed(), &pay(STRANGER, USDC));
    assert_eq!(d.orange_reason(), Some(OrangeReason::UnknownPayee));
    assert_eq!(d.trust_allowed(), Some(false), "a full payee list cannot take another entry");
}

#[test]
fn the_budget_boundary_is_exact() {
    // 15 spent + 6 would be 21 > 20. Known payee, under auto_max, so the only failure is budget.
    let c = Counters { spent: 15 * USDC, count: 3 };
    let d = decide(&demo(), &c, &armed(), &pay(CAFE, 5 * USDC + 1));
    assert_eq!(d.orange_reason(), Some(OrangeReason::OverAutoMax), "5.000001 is over auto_max first");

    let mut p = demo();
    p.auto_max = 10 * USDC;
    let d = decide(&p, &c, &armed(), &pay(CAFE, 5 * USDC + 1));
    assert_eq!(d.orange_reason(), Some(OrangeReason::BudgetExceeded));
    assert_eq!(d.trust_allowed(), Some(false));
}

#[test]
fn the_count_limit_raises_an_orange_screen() {
    let c = Counters { spent: 0, count: 10 };
    let d = decide(&demo(), &c, &armed(), &pay(CAFE, USDC));
    assert_eq!(d.orange_reason(), Some(OrangeReason::CountExceeded));
    assert_eq!(d.trust_allowed(), Some(false));
}

#[test]
fn orange_reasons_are_reported_in_the_documented_priority() {
    // Unknown payee, over auto_max, over budget and over count all at once.
    let c = Counters { spent: 20 * USDC, count: 10 };
    let d = decide(&demo(), &c, &armed(), &pay(STRANGER, 10 * USDC));
    assert_eq!(d.orange_reason(), Some(OrangeReason::UnknownPayee));

    // Known payee: auto_max wins over budget and count.
    let d = decide(&demo(), &c, &armed(), &pay(CAFE, 10 * USDC));
    assert_eq!(d.orange_reason(), Some(OrangeReason::OverAutoMax));

    // Known payee, under auto_max: budget wins over count.
    let d = decide(&demo(), &c, &armed(), &pay(CAFE, USDC));
    assert_eq!(d.orange_reason(), Some(OrangeReason::BudgetExceeded));
}

// ---------------------------------------------------------------- salami slicing

#[test]
fn four_payments_just_under_the_auto_max_pass_then_the_budget_stops_the_fifth() {
    // The attack the budget exists for: 4.99 USDC is always under auto_max, but the
    // cumulative budget must still bite.
    let slice = 4 * USDC + 990_000; // 4.99
    let mut c = zero();
    let p = demo();
    for i in 0..4 {
        assert_eq!(decide(&p, &c, &armed(), &pay(CAFE, slice)), Decision::Auto, "slice {i} should be automatic");
        c = c.apply(slice).unwrap();
    }
    assert_eq!(c.spent, 19 * USDC + 960_000);
    assert_eq!(c.count, 4);
    // 19.96 + 4.99 = 24.95 > 20 budget.
    let d = decide(&p, &c, &armed(), &pay(CAFE, slice));
    assert_eq!(d.orange_reason(), Some(OrangeReason::BudgetExceeded));
}

#[test]
fn ten_small_payments_pass_then_the_count_stops_the_eleventh() {
    let mut c = zero();
    let p = demo();
    for i in 0..10 {
        assert_eq!(decide(&p, &c, &armed(), &pay(CAFE, 1000)), Decision::Auto, "payment {i}");
        c = c.apply(1000).unwrap();
    }
    assert_eq!(c.count, 10);
    assert_eq!(decide(&p, &c, &armed(), &pay(CAFE, 1000)).orange_reason(), Some(OrangeReason::CountExceeded));
}

// ---------------------------------------------------------------- counter arithmetic

#[test]
fn applying_a_payment_increments_both_counters() {
    let c = zero().apply(3 * USDC).unwrap();
    assert_eq!(c, Counters { spent: 3 * USDC, count: 1 });
}

#[test]
fn counter_arithmetic_is_checked_not_wrapping() {
    let c = Counters { spent: u64::MAX, count: 0 };
    assert_eq!(c.apply(1), Err(RefusalReason::InvalidAmount));
    let c = Counters { spent: 0, count: u16::MAX };
    assert_eq!(c.apply(1), Err(RefusalReason::InvalidAmount));
}

#[test]
fn an_overflowing_spend_is_refused_rather_than_silently_wrapping() {
    // A policy with a huge budget and a spent counter near the top: spent + value must not wrap
    // into a small number and pass the budget check.
    let mut p = demo();
    p.budget = u64::MAX;
    p.auto_max = u64::MAX;
    p.hard_max = u64::MAX;
    let c = Counters { spent: u64::MAX - 10, count: 0 };
    let payment = Payment { chain_id: ARC, token: TOKEN, to: CAFE, value: Payment::value_from_u64(100) };
    // spent + value overflows, so it cannot be "within budget".
    assert_eq!(decide(&p, &c, &armed(), &payment).orange_reason(), Some(OrangeReason::BudgetExceeded));
}

// ---------------------------------------------------------------- the empty policy

#[test]
fn a_policy_with_no_payees_sends_everything_to_the_orange_screen() {
    let mut p = demo();
    p.payee_count = 0;
    let d = decide(&p, &zero(), &armed(), &pay(CAFE, USDC));
    assert_eq!(d.orange_reason(), Some(OrangeReason::UnknownPayee));
    assert_eq!(d.trust_allowed(), Some(true));
}

#[test]
fn an_inactive_policy_with_payees_is_still_no_policy() {
    let mut p = demo();
    p.active = false;
    assert_eq!(decide(&p, &zero(), &armed(), &pay(CAFE, USDC)), Decision::Refuse(RefusalReason::NoPolicy));
}
