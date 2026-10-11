//! Test 6: payloads larger than one APDU, reassembled on the device, hashed, and kept in NVM.
//!
//! LONG_CMD (INS 0x11): P1 = 0x00 first chunk / 0x01 next chunk, P2 = 0x80 more / 0x00 last.
//!   The last chunk replies keccak256(payload).
//! STORE_BLOB (0x12): writes the last reassembled payload to NVM. Replies its length (u16).
//! READ_BLOB (0x13, P1 = chunk index): replies len(u16) | up to 200 bytes from offset 200 * P1.
//! BLOB_HASH (0x14): replies keccak256 of the payload stored in NVM.
use crate::AppSW;
use ledger_device_sdk::hash::{sha3::Keccak256, HashInit};
use ledger_device_sdk::io::{Command, CommandResponse};
use ledger_device_sdk::nvm::*;
use ledger_device_sdk::NVMData;

pub const BLOB_MAX: usize = 1024;
const READ_CHUNK: usize = 200;

/// Reassembly buffer (RAM), reset by every first chunk. Zero-initialised fixed array (not a Vec):
/// Ledger's link script requires an empty .data section, and Vec::new() is not all-zero.
static mut BUF: [u8; BLOB_MAX] = [0u8; BLOB_MAX];
static mut BUF_LEN: usize = 0;
static mut BUF_OPEN: bool = false;
static mut BUF_DONE: bool = false;

/// Persistent copy: length (2 bytes, big-endian) followed by up to BLOB_MAX bytes.
#[link_section = ".nvm_data"]
static mut BLOB: NVMData<AtomicStorage<[u8; BLOB_MAX + 2]>> =
    NVMData::new(AtomicStorage::new(&[0u8; BLOB_MAX + 2]));

fn keccak(data: &[u8]) -> Result<[u8; 32], AppSW> {
    let mut h = Keccak256::new();
    h.update(data).map_err(|_| AppSW::TxHashFail)?;
    let mut out = [0u8; 32];
    h.finalize(&mut out).map_err(|_| AppSW::TxHashFail)?;
    Ok(out)
}

fn stored() -> &'static [u8] {
    let blob = &raw const BLOB;
    let raw = unsafe { (*blob).get_ref() }.get_ref();
    let len = (u16::from_be_bytes([raw[0], raw[1]]) as usize).min(BLOB_MAX);
    &raw[2..2 + len]
}

pub fn handler_long_cmd(command: Command<'_>, first: bool, last: bool) -> Result<CommandResponse<'_>, AppSW> {
    let buf = unsafe { &mut *(&raw mut BUF) };
    let len = unsafe { &mut *(&raw mut BUF_LEN) };
    unsafe {
        if first {
            *len = 0;
            BUF_OPEN = true;
            BUF_DONE = false;
        } else if !BUF_OPEN {
            return Err(AppSW::BadState);
        }
    }
    let data = command.get_data();
    if *len + data.len() > BLOB_MAX {
        unsafe { BUF_OPEN = false };
        return Err(AppSW::TxWrongLength);
    }
    buf[*len..*len + data.len()].copy_from_slice(data);
    *len += data.len();
    let mut response = command.into_response();
    if last {
        unsafe {
            BUF_OPEN = false;
            BUF_DONE = true;
        }
        response.append(&keccak(&buf[..*len])?)?;
    }
    Ok(response)
}

pub fn handler_store_blob(command: Command<'_>) -> Result<CommandResponse<'_>, AppSW> {
    if unsafe { !BUF_DONE } {
        return Err(AppSW::BadState);
    }
    let buf = unsafe { &(&*(&raw const BUF))[..BUF_LEN] };
    let mut value = [0u8; BLOB_MAX + 2];
    value[..2].copy_from_slice(&(buf.len() as u16).to_be_bytes());
    value[2..2 + buf.len()].copy_from_slice(buf);
    let blob = &raw mut BLOB;
    unsafe { (*blob).get_mut() }.update(&value);
    let mut response = command.into_response();
    response.append(&(stored().len() as u16).to_be_bytes())?;
    Ok(response)
}

pub fn handler_read_blob(command: Command<'_>, chunk: u8) -> Result<CommandResponse<'_>, AppSW> {
    let data = stored();
    let start = (chunk as usize * READ_CHUNK).min(data.len());
    let end = (start + READ_CHUNK).min(data.len());
    let mut response = command.into_response();
    response.append(&(data.len() as u16).to_be_bytes())?;
    response.append(&data[start..end])?;
    Ok(response)
}

pub fn handler_blob_hash(command: Command<'_>) -> Result<CommandResponse<'_>, AppSW> {
    let hash = keccak(stored())?;
    let mut response = command.into_response();
    response.append(&hash)?;
    Ok(response)
}
