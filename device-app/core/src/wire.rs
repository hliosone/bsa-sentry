//! The policy as the device holds it, plus the binary codecs shared with `packages/types`.
//!
//! Fixed-size arrays everywhere: Ledger's link script requires an empty `.data` section, so
//! no `Vec` and no non-zero static initialisers. The byte layout is frozen in
//! `packages/types/fixtures/wire.json`, which the host tests here read back.

pub const MAX_PAYEES: usize = 8;
/// Labels are stored as bytes, so the limit is 16 **bytes** of UTF-8, not 16 codepoints.
pub const MAX_LABEL_BYTES: usize = 16;
pub const POLICY_WIRE_VERSION: u8 = 1;
pub const POLICY_WIRE_MIN_LEN: usize = 57;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Payee {
    pub addr: [u8; 20],
    label: [u8; MAX_LABEL_BYTES],
    label_len: u8,
}

impl Payee {
    /// Builds a payee, truncating the label at [`MAX_LABEL_BYTES`].
    ///
    /// Truncation rather than rejection is deliberate: the label is display-only (invariant 3),
    /// so a clipped name is harmless, while refusing to store a payee the user just approved
    /// on screen would be worse.
    pub fn new(addr: [u8; 20], label: &[u8]) -> Self {
        let n = if label.len() > MAX_LABEL_BYTES { MAX_LABEL_BYTES } else { label.len() };
        let mut buf = [0u8; MAX_LABEL_BYTES];
        buf[..n].copy_from_slice(&label[..n]);
        Payee { addr, label: buf, label_len: n as u8 }
    }

    pub fn label(&self) -> &[u8] {
        &self.label[..self.label_len as usize]
    }

    pub fn label_len(&self) -> usize {
        self.label_len as usize
    }
}

impl Default for Payee {
    fn default() -> Self {
        Payee { addr: [0u8; 20], label: [0u8; MAX_LABEL_BYTES], label_len: 0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub active: bool,
    pub chain_id: u64,
    pub token: [u8; 20],
    /// Amounts are USDC base units (6 decimals).
    pub auto_max: u64,
    pub hard_max: u64,
    pub budget: u64,
    pub max_count: u16,
    pub payees: [Payee; MAX_PAYEES],
    pub payee_count: usize,
}

impl Policy {
    /// An inactive, all-zero policy. This is what a fresh device holds, and
    /// `active == false` alone makes every payment a `NO_POLICY` refusal.
    pub const fn empty() -> Self {
        Policy {
            active: false,
            chain_id: 0,
            token: [0u8; 20],
            auto_max: 0,
            hard_max: 0,
            budget: 0,
            max_count: 0,
            payees: [Payee { addr: [0u8; 20], label: [0u8; MAX_LABEL_BYTES], label_len: 0 }; MAX_PAYEES],
            payee_count: 0,
        }
    }

    pub fn payees(&self) -> &[Payee] {
        &self.payees[..self.payee_count]
    }

    pub fn payees_full(&self) -> bool {
        self.payee_count >= MAX_PAYEES
    }

    /// Matching is on the address only. Labels never take part (invariant 3).
    pub fn find_payee(&self, addr: &[u8; 20]) -> Option<&Payee> {
        self.payees().iter().find(|p| &p.addr == addr)
    }

    /// Appends a payee. `Err(())` when the list is full; the caller must then not offer "trust".
    pub fn push_payee(&mut self, payee: Payee) -> Result<(), ()> {
        if self.payees_full() {
            return Err(());
        }
        if self.find_payee(&payee.addr).is_some() {
            return Ok(()); // already trusted; adding it twice would waste a slot
        }
        self.payees[self.payee_count] = payee;
        self.payee_count += 1;
        Ok(())
    }

    /// Removes a payee by address, from the device menu. Keeps the remaining order stable.
    pub fn remove_payee(&mut self, addr: &[u8; 20]) -> bool {
        match self.payees().iter().position(|p| &p.addr == addr) {
            None => false,
            Some(i) => {
                for j in i..self.payee_count - 1 {
                    self.payees[j] = self.payees[j + 1];
                }
                self.payee_count -= 1;
                self.payees[self.payee_count] = Payee::default();
                true
            }
        }
    }
}

// ---------------------------------------------------------------------------- errors

/// Every way a host-supplied blob can be wrong. The device answers 0x6700 (wrong length)
/// or 0x6985 for these; what matters is that none of them is silently tolerated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
    TooShort,
    BadVersion,
    BadFlags,
    TooManyPayees,
    LabelTooLong,
    Truncated,
    TrailingBytes,
    InvalidUtf8,
    TooManyClaims,
    ClaimTooLong,
    NameTooLong,
    BadRecoveryByte,
    /// The caller's output buffer is too small. A bug on our side, not the host's.
    BufferTooSmall,
}

// ---------------------------------------------------------------------------- readers

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8]) -> Self {
        Reader { b, at: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], WireError> {
        let end = self.at.checked_add(n).ok_or(WireError::Truncated)?;
        if end > self.b.len() {
            return Err(WireError::Truncated);
        }
        let out = &self.b[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, WireError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, WireError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u64(&mut self) -> Result<u64, WireError> {
        let b = self.take(8)?;
        let mut w = [0u8; 8];
        w.copy_from_slice(b);
        Ok(u64::from_be_bytes(w))
    }

    fn arr20(&mut self) -> Result<[u8; 20], WireError> {
        let mut out = [0u8; 20];
        out.copy_from_slice(self.take(20)?);
        Ok(out)
    }

    fn arr32(&mut self) -> Result<[u8; 32], WireError> {
        let mut out = [0u8; 32];
        out.copy_from_slice(self.take(32)?);
        Ok(out)
    }

    fn arr65(&mut self) -> Result<[u8; 65], WireError> {
        let mut out = [0u8; 65];
        out.copy_from_slice(self.take(65)?);
        Ok(out)
    }

    /// Length-prefixed UTF-8 text, copied into a fixed buffer.
    ///
    /// UTF-8 is validated even though the device stores raw bytes: the text is rendered by
    /// NBGL, and it keeps the must-reject list identical to the TypeScript decoder.
    fn text<const N: usize>(&mut self, max: usize) -> Result<([u8; N], u8), WireError> {
        let len = self.u8()? as usize;
        if len > max || len > N {
            return Err(WireError::LabelTooLong);
        }
        let raw = self.take(len)?;
        core::str::from_utf8(raw).map_err(|_| WireError::InvalidUtf8)?;
        let mut buf = [0u8; N];
        buf[..len].copy_from_slice(raw);
        Ok((buf, len as u8))
    }

}

struct Writer<'a> {
    b: &'a mut [u8],
    at: usize,
}

impl<'a> Writer<'a> {
    fn new(b: &'a mut [u8]) -> Self {
        Writer { b, at: 0 }
    }

    fn put(&mut self, data: &[u8]) -> Result<(), WireError> {
        let end = self.at.checked_add(data.len()).ok_or(WireError::BufferTooSmall)?;
        if end > self.b.len() {
            return Err(WireError::BufferTooSmall);
        }
        self.b[self.at..end].copy_from_slice(data);
        self.at = end;
        Ok(())
    }
}

// ---------------------------------------------------------------------------- policy codec

/// Decodes a policy and requires that it consumed the whole buffer.
pub fn decode_policy(b: &[u8]) -> Result<Policy, WireError> {
    let (policy, read) = read_policy(b)?;
    if read != b.len() {
        return Err(WireError::TrailingBytes);
    }
    Ok(policy)
}

/// Decodes a policy from the start of `b`, returning how many bytes it used.
/// Used by RESTORE, where a policy is followed by a credentials blob.
pub fn read_policy(b: &[u8]) -> Result<(Policy, usize), WireError> {
    if b.len() < POLICY_WIRE_MIN_LEN {
        return Err(WireError::TooShort);
    }
    let mut r = Reader::new(b);
    if r.u8()? != POLICY_WIRE_VERSION {
        return Err(WireError::BadVersion);
    }
    let flags = r.u8()?;
    if flags & !0x01 != 0 {
        return Err(WireError::BadFlags);
    }

    let mut p = Policy::empty();
    p.active = flags & 0x01 != 0;
    p.chain_id = r.u64()?;
    p.token = r.arr20()?;
    p.auto_max = r.u64()?;
    p.hard_max = r.u64()?;
    p.budget = r.u64()?;
    p.max_count = r.u16()?;

    let count = r.u8()? as usize;
    if count > MAX_PAYEES {
        return Err(WireError::TooManyPayees);
    }
    for i in 0..count {
        let addr = r.arr20()?;
        let (label, label_len) = r.text::<MAX_LABEL_BYTES>(MAX_LABEL_BYTES)?;
        p.payees[i] = Payee { addr, label, label_len };
    }
    p.payee_count = count;
    Ok((p, r.at))
}

/// Writes a policy into `out`, returning the number of bytes written.
pub fn encode_policy(p: &Policy, out: &mut [u8]) -> Result<usize, WireError> {
    let mut w = Writer::new(out);
    w.put(&[POLICY_WIRE_VERSION, if p.active { 1 } else { 0 }])?;
    w.put(&p.chain_id.to_be_bytes())?;
    w.put(&p.token)?;
    w.put(&p.auto_max.to_be_bytes())?;
    w.put(&p.hard_max.to_be_bytes())?;
    w.put(&p.budget.to_be_bytes())?;
    w.put(&p.max_count.to_be_bytes())?;
    w.put(&[p.payee_count as u8])?;
    for payee in p.payees() {
        w.put(&payee.addr)?;
        w.put(&[payee.label_len])?;
        w.put(payee.label())?;
    }
    Ok(w.at)
}

// ---------------------------------------------------------------------------- state codec

pub const STATE_WIRE_VERSION: u8 = 1;

/// What GET_STATE reports. The device only ever writes this; the dashboard parses it.
#[derive(Debug, Clone, Copy)]
pub struct DeviceState {
    pub session: crate::decide::Session,
    pub has_credentials: bool,
    pub counters: crate::decide::Counters,
    /// 0 means "no payment yet".
    pub last_value: u64,
    pub last_label: ([u8; MAX_LABEL_BYTES], usize),
    pub policy: Policy,
}

pub fn encode_state(s: &DeviceState, out: &mut [u8]) -> Result<usize, WireError> {
    let flags = (if s.session.armed { 0x01 } else { 0 }) | (if s.has_credentials { 0x02 } else { 0 });
    let (label, label_len) = s.last_label;
    let label_len = if s.last_value == 0 { 0 } else { label_len };
    if label_len > MAX_LABEL_BYTES {
        return Err(WireError::LabelTooLong);
    }
    let mut w = Writer::new(out);
    w.put(&[STATE_WIRE_VERSION, flags])?;
    w.put(&s.counters.spent.to_be_bytes())?;
    w.put(&s.counters.count.to_be_bytes())?;
    w.put(&s.last_value.to_be_bytes())?;
    w.put(&[label_len as u8])?;
    w.put(&label[..label_len])?;
    let n = encode_policy(&s.policy, &mut w.b[w.at..])?;
    Ok(w.at + n)
}

// ---------------------------------------------------------------------------- credentials codec

pub const CREDENTIALS_WIRE_VERSION: u8 = 1;
pub const MAX_CLAIMS: usize = 4;
pub const MAX_CLAIM_BYTES: usize = 32;
pub const MAX_AGENT_NAME_BYTES: usize = 24;

#[derive(Debug, Clone, Copy)]
pub struct AgeAttestation {
    pub subject: [u8; 20],
    claim: [u8; MAX_CLAIM_BYTES],
    claim_len: u8,
    pub issued_at: u64,
    pub expires_at: u64,
    pub evidence: [u8; 32],
}

impl AgeAttestation {
    pub fn claim(&self) -> &[u8] {
        &self.claim[..self.claim_len as usize]
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AgentDelegation {
    pub agent: [u8; 20],
    agent_name: [u8; MAX_AGENT_NAME_BYTES],
    agent_name_len: u8,
    pub attestation: [u8; 32],
    claims: [[u8; MAX_CLAIM_BYTES]; MAX_CLAIMS],
    claim_lens: [u8; MAX_CLAIMS],
    pub claim_count: u8,
    pub expires_at: u64,
    pub nonce: [u8; 32],
}

impl AgentDelegation {
    pub fn agent_name(&self) -> &[u8] {
        &self.agent_name[..self.agent_name_len as usize]
    }

    pub fn claim(&self, i: usize) -> &[u8] {
        if i >= self.claim_count as usize {
            return &[];
        }
        &self.claims[i][..self.claim_lens[i] as usize]
    }

    /// Whether the delegation carries a given claim, e.g. `b"age_over_18"`.
    pub fn has_claim(&self, wanted: &[u8]) -> bool {
        (0..self.claim_count as usize).any(|i| self.claim(i) == wanted)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Credentials {
    pub attestation: AgeAttestation,
    pub attestation_sig: [u8; 65],
    pub delegation: AgentDelegation,
    pub delegation_sig: [u8; 65],
}

/// Decodes a credentials bundle and requires it to consume the whole buffer.
///
/// Deliberately agnostic about meaning: the handler then checks that the delegation was
/// signed by this device's own 0xMAIN and targets its own 0xAGENT. Keeping those checks out
/// of the codec is what makes them testable on their own.
pub fn decode_credentials(b: &[u8]) -> Result<Credentials, WireError> {
    let (c, read) = read_credentials(b)?;
    if read != b.len() {
        return Err(WireError::TrailingBytes);
    }
    Ok(c)
}

pub fn read_credentials(b: &[u8]) -> Result<(Credentials, usize), WireError> {
    // header + both structs with empty strings and no claims
    const MIN_LEN: usize = 2 + (20 + 1 + 8 + 8 + 32) + 65 + (20 + 1 + 32 + 1 + 8 + 32) + 65;
    if b.len() < MIN_LEN {
        return Err(WireError::TooShort);
    }
    let mut r = Reader::new(b);
    if r.u8()? != CREDENTIALS_WIRE_VERSION {
        return Err(WireError::BadVersion);
    }
    if r.u8()? != 0 {
        return Err(WireError::BadFlags);
    }

    let subject = r.arr20()?;
    let (claim, claim_len) = r.text::<MAX_CLAIM_BYTES>(MAX_CLAIM_BYTES).map_err(claim_err)?;
    let attestation = AgeAttestation {
        subject,
        claim,
        claim_len,
        issued_at: r.u64()?,
        expires_at: r.u64()?,
        evidence: r.arr32()?,
    };
    let attestation_sig = r.arr65()?;
    if attestation_sig[0] != 27 && attestation_sig[0] != 28 {
        return Err(WireError::BadRecoveryByte);
    }

    let agent = r.arr20()?;
    let (agent_name, agent_name_len) = r
        .text::<MAX_AGENT_NAME_BYTES>(MAX_AGENT_NAME_BYTES)
        .map_err(|e| if e == WireError::LabelTooLong { WireError::NameTooLong } else { e })?;
    let delegation_attestation = r.arr32()?;
    let claim_count = r.u8()?;
    if claim_count as usize > MAX_CLAIMS {
        return Err(WireError::TooManyClaims);
    }
    let mut claims = [[0u8; MAX_CLAIM_BYTES]; MAX_CLAIMS];
    let mut claim_lens = [0u8; MAX_CLAIMS];
    for i in 0..claim_count as usize {
        let (c, l) = r.text::<MAX_CLAIM_BYTES>(MAX_CLAIM_BYTES).map_err(claim_err)?;
        claims[i] = c;
        claim_lens[i] = l;
    }
    let delegation = AgentDelegation {
        agent,
        agent_name,
        agent_name_len,
        attestation: delegation_attestation,
        claims,
        claim_lens,
        claim_count,
        expires_at: r.u64()?,
        nonce: r.arr32()?,
    };
    let delegation_sig = r.arr65()?;
    if delegation_sig[0] != 27 && delegation_sig[0] != 28 {
        return Err(WireError::BadRecoveryByte);
    }

    Ok((Credentials { attestation, attestation_sig, delegation, delegation_sig }, r.at))
}

fn claim_err(e: WireError) -> WireError {
    if e == WireError::LabelTooLong {
        WireError::ClaimTooLong
    } else {
        e
    }
}
