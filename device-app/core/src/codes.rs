//! Reason codes. These byte values are a frozen contract shared with `packages/types`
//! (`fixtures/wire.json` records them) and must never be renumbered.

/// The byte the device appends after status word 0x6985.
/// 0 is reserved so a zeroed buffer can never be read as a valid reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RefusalReason {
    NoPolicy = 1,
    NoSession = 2,
    WrongChainOrToken = 3,
    InvalidAmount = 4,
    OverHardMax = 5,
    UserRejected = 6,
    Timeout = 7,
}

impl RefusalReason {
    pub const fn byte(self) -> u8 {
        self as u8
    }
}

/// Why `decide` chose the orange screen. Shown to the user; never returned after 0x6985.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum OrangeReason {
    UnknownPayee = 1,
    OverAutoMax = 2,
    BudgetExceeded = 3,
    CountExceeded = 4,
}

impl OrangeReason {
    pub const fn byte(self) -> u8 {
        self as u8
    }
}
