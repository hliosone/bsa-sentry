//! The spending decision. This is the whole product: the only thing between an AI agent and
//! the user's money. It is a pure function so that it can be exhaustively tested on the host.
use crate::codes::{OrangeReason, RefusalReason};
use crate::wire::Policy;

/// Armed from the device menu only, and kept in RAM: a reboot disarms the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Session {
    pub armed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counters {
    pub spent: u64,
    pub count: u16,
}

impl Counters {
    /// The counters after `value` is spent. Checked arithmetic: an overflow is a refusal,
    /// never a wrap into a small number that would pass the budget check.
    pub fn apply(&self, value: u64) -> Result<Counters, RefusalReason> {
        let spent = self.spent.checked_add(value).ok_or(RefusalReason::InvalidAmount)?;
        let count = self.count.checked_add(1).ok_or(RefusalReason::InvalidAmount)?;
        Ok(Counters { spent, count })
    }
}

/// A payment request, exactly as it arrives in the PAY APDU.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Payment {
    pub chain_id: u64,
    pub token: [u8; 20],
    pub to: [u8; 20],
    /// Big-endian u256. Kept raw because the EIP-712 digest needs these exact bytes, and
    /// because a value above `u64::MAX` must be refused rather than truncated.
    pub value: [u8; 32],
}

impl Payment {
    /// Big-endian u256 word for a u64 amount. Test and host helper.
    pub fn value_from_u64(v: u64) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[24..].copy_from_slice(&v.to_be_bytes());
        out
    }

    /// `None` when the value does not fit a u64, which no policy limit ever could.
    pub fn value_as_u64(&self) -> Option<u64> {
        if self.value[..24].iter().any(|&b| b != 0) {
            return None;
        }
        let mut be = [0u8; 8];
        be.copy_from_slice(&self.value[24..]);
        Some(u64::from_be_bytes(be))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrangeInfo {
    pub reason: OrangeReason,
    /// "Faire confiance" is offered only when the unknown payee is the *only* problem and
    /// there is a free slot. Otherwise trusting the merchant would not change the outcome.
    pub trust_allowed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Sign with no button press.
    Auto,
    /// Show the orange screen: Refuse / Once / Trust, 60 s then refuse.
    Orange(OrangeInfo),
    /// Refuse outright. A tap cannot override this.
    Refuse(RefusalReason),
}

impl Decision {
    pub fn orange_reason(&self) -> Option<OrangeReason> {
        match self {
            Decision::Orange(o) => Some(o.reason),
            _ => None,
        }
    }

    pub fn trust_allowed(&self) -> Option<bool> {
        match self {
            Decision::Orange(o) => Some(o.trust_allowed),
            _ => None,
        }
    }
}

/// Decides what to do with a payment. The rule order is part of the contract: a rule that
/// fires in the wrong order is a bypass, so each step below is tested in isolation and
/// against its neighbour.
pub fn decide(policy: &Policy, counters: &Counters, session: &Session, payment: &Payment) -> Decision {
    // 1. No policy at all.
    if !policy.active {
        return Decision::Refuse(RefusalReason::NoPolicy);
    }
    // 2. The user has not armed the agent from the device menu.
    if !session.armed {
        return Decision::Refuse(RefusalReason::NoSession);
    }
    // 3. Wrong chain or wrong token: the policy is only ever about one asset on one chain.
    if payment.chain_id != policy.chain_id || payment.token != policy.token {
        return Decision::Refuse(RefusalReason::WrongChainOrToken);
    }

    // A value above u64::MAX cannot be at or under a u64 hard_max, and is never zero,
    // so it lands on rule 5 without any truncation.
    let value = match payment.value_as_u64() {
        Some(v) => v,
        None => return Decision::Refuse(RefusalReason::OverHardMax),
    };
    // 4. A zero-value authorization is meaningless and would still burn a nonce.
    if value == 0 {
        return Decision::Refuse(RefusalReason::InvalidAmount);
    }
    // 5. Above the hard ceiling: refused even for a trusted payee, even with a tap.
    if value > policy.hard_max {
        return Decision::Refuse(RefusalReason::OverHardMax);
    }

    let known = policy.find_payee(&payment.to).is_some();
    let within_auto = value <= policy.auto_max;
    // Checked: an overflowing total is never "within budget".
    let within_budget = counters.spent.checked_add(value).is_some_and(|t| t <= policy.budget);
    let within_count = counters.count < policy.max_count;

    // 6. Everything satisfied: sign with no button press.
    if known && within_auto && within_budget && within_count {
        return Decision::Auto;
    }

    // 7. Otherwise the orange screen, reporting the first failure in the documented order.
    let reason = if !known {
        OrangeReason::UnknownPayee
    } else if !within_auto {
        OrangeReason::OverAutoMax
    } else if !within_budget {
        OrangeReason::BudgetExceeded
    } else {
        OrangeReason::CountExceeded
    };
    let trust_allowed = !known && within_auto && within_budget && within_count && !policy.payees_full();
    Decision::Orange(OrangeInfo { reason, trust_allowed })
}

/// Enforces security invariant 4: the counters are written to NVM **before** the signature
/// leaves the device. Without this, a host that cuts power between signing and persisting
/// would get a free payment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlowError {
    /// A step was taken out of order. The app must abort the payment.
    OutOfOrder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Idle,
    Approved,
    Persisted,
    Signed,
}

#[derive(Debug, Clone, Copy)]
pub struct PayFlow {
    stage: Stage,
    next: Counters,
}

impl Default for PayFlow {
    fn default() -> Self {
        Self::new()
    }
}

impl PayFlow {
    pub const fn new() -> Self {
        PayFlow { stage: Stage::Idle, next: Counters { spent: 0, count: 0 } }
    }

    /// Records that a payment was approved (automatically or on screen) and returns the
    /// counters the app must persist. Can only be called from the idle stage.
    pub fn approve(&mut self, current: Counters, value: u64) -> Result<Counters, RefusalReason> {
        if self.stage != Stage::Idle {
            return Err(RefusalReason::UserRejected);
        }
        let next = current.apply(value)?;
        self.next = next;
        self.stage = Stage::Approved;
        Ok(next)
    }

    /// The counters that must be in NVM before the signature is returned.
    pub fn pending_counters(&self) -> Option<Counters> {
        match self.stage {
            Stage::Approved | Stage::Persisted => Some(self.next),
            _ => None,
        }
    }

    pub fn mark_persisted(&mut self) -> Result<(), FlowError> {
        if self.stage != Stage::Approved {
            return Err(FlowError::OutOfOrder);
        }
        self.stage = Stage::Persisted;
        Ok(())
    }

    /// Whether the app is allowed to hand a signature back to the host.
    pub fn may_sign(&self) -> bool {
        self.stage == Stage::Persisted
    }

    pub fn mark_signed(&mut self) -> Result<(), FlowError> {
        if self.stage != Stage::Persisted {
            return Err(FlowError::OutOfOrder);
        }
        self.stage = Stage::Signed;
        Ok(())
    }

    /// Abandons the payment. Used on refusal, timeout, or any error after approval.
    pub fn abort(&mut self) {
        self.stage = Stage::Idle;
        self.next = Counters { spent: 0, count: 0 };
    }

    pub fn is_idle(&self) -> bool {
        self.stage == Stage::Idle
    }
}
