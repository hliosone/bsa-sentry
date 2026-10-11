//! Chunked-APDU reassembly, mirroring `packages/types/src/apdu.ts`.
//!
//! P1 0x00 = first chunk, 0x01 = next. P2 0x80 = more follow, 0x00 = last.
//! A payload larger than the buffer, or a "next" without a "first", is an error rather
//! than something to patch up: a desynchronised transfer is very hard to debug on hardware.

pub const MAX_APDU_DATA: usize = 250;
pub const MAX_REASSEMBLY: usize = 1024;

pub const P1_FIRST: u8 = 0x00;
pub const P1_NEXT: u8 = 0x01;
pub const P2_MORE: u8 = 0x80;
pub const P2_LAST: u8 = 0x00;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkError {
    /// 0xB004: the payload would not fit the reassembly buffer.
    PayloadTooLarge,
    /// 0xB00B: a "next" chunk with no transfer in progress.
    NextWithoutFirst,
    /// 0x6700-ish: a P1/P2 we do not define, or a chunk bigger than one APDU.
    BadParameter,
}

impl ChunkError {
    /// The status word the device answers with.
    pub const fn status_word(self) -> u16 {
        match self {
            ChunkError::PayloadTooLarge => 0xb004,
            ChunkError::NextWithoutFirst => 0xb00b,
            ChunkError::BadParameter => 0x6700,
        }
    }
}

/// Reassembles a chunked payload in a fixed buffer.
///
/// The buffer is a plain array, not a `Vec`: Ledger's link script requires an empty `.data`
/// section, so the device allocates this once as a zero-initialised static.
pub struct Reassembler {
    buf: [u8; MAX_REASSEMBLY],
    len: usize,
    open: bool,
}

impl Default for Reassembler {
    fn default() -> Self {
        Self::new()
    }
}

impl Reassembler {
    pub const fn new() -> Self {
        Reassembler { buf: [0u8; MAX_REASSEMBLY], len: 0, open: false }
    }

    /// Feeds one chunk. Returns the complete payload on the last chunk, `None` while more
    /// are expected.
    pub fn push(&mut self, p1: u8, p2: u8, data: &[u8]) -> Result<Option<&[u8]>, ChunkError> {
        if (p1 != P1_FIRST && p1 != P1_NEXT) || (p2 != P2_MORE && p2 != P2_LAST) {
            return Err(ChunkError::BadParameter);
        }
        if data.len() > MAX_APDU_DATA {
            return Err(ChunkError::BadParameter);
        }

        if p1 == P1_FIRST {
            // A new transfer always discards whatever was in flight, so an abandoned
            // transfer can never be concatenated onto a later one.
            self.len = 0;
            self.open = true;
        } else if !self.open {
            return Err(ChunkError::NextWithoutFirst);
        }

        if self.len + data.len() > MAX_REASSEMBLY {
            self.reset();
            return Err(ChunkError::PayloadTooLarge);
        }
        self.buf[self.len..self.len + data.len()].copy_from_slice(data);
        self.len += data.len();

        if p2 == P2_LAST {
            self.open = false;
            return Ok(Some(&self.buf[..self.len]));
        }
        Ok(None)
    }

    /// Discards any transfer in progress.
    pub fn reset(&mut self) {
        self.len = 0;
        self.open = false;
    }

    /// The payload of the last completed transfer, for a follow-up command.
    pub fn completed(&self) -> &[u8] {
        if self.open {
            &[]
        } else {
            &self.buf[..self.len]
        }
    }
}
