//! Display formatting. Everything the user reads on the device is built here, so the
//! amount and the address shown are always derived from the bytes that will be signed.
use alloc::ffi::CString;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;


/// Formats a u64 of USDC base units, trimming trailing zeros: `3000000` -> `"3"`,
/// `4500000` -> `"4.5"`, `1` -> `"0.000001"`.
pub fn amount(units: u64) -> String {
    let int = units / 1_000_000;
    let frac = units % 1_000_000;
    if frac == 0 {
        return format!("{int}");
    }
    let frac = format!("{frac:06}");
    format!("{int}.{}", frac.trim_end_matches('0'))
}

/// `3.00 USDC` style, always with the token, so no screen can show a bare number.
pub fn amount_usdc(units: u64) -> String {
    format!("{} USDC", amount(units))
}

/// A big-endian u256 of token units. Values above u64::MAX are shown as-is in hex rather
/// than truncated, because such a payment is always refused anyway and the user should see
/// something obviously wrong rather than a plausible small number.
pub fn amount_u256(be: &[u8; 32]) -> String {
    if be[..24].iter().all(|&b| b == 0) {
        let mut w = [0u8; 8];
        w.copy_from_slice(&be[24..]);
        amount_usdc(u64::from_be_bytes(w))
    } else {
        format!("0x{} (hors limite)", hex20_of(&be[..8]))
    }
}

/// The FULL address, never truncated: a shortened address is exactly what an attacker
/// substituting a lookalike payee relies on.
pub fn address(addr: &[u8; 20]) -> String {
    format!("0x{}", hex20_of(addr))
}

fn hex20_of(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

/// A label or hint coming from the host, for display only.
///
/// Any byte that is not printable ASCII is replaced: the host controls this text, and a
/// control character or a right-to-left override could rearrange what the user reads.
pub fn untrusted_text(raw: &[u8]) -> String {
    match core::str::from_utf8(raw) {
        Err(_) => String::from("?"),
        Ok(s) => {
            let cleaned: String = s
                .chars()
                .map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '?' })
                .collect();
            if cleaned.is_empty() {
                String::from("(vide)")
            } else {
                cleaned
            }
        }
    }
}

/// A C string for the NBGL API. Interior null bytes are dropped rather than panicking,
/// because some of these strings come from the host.
pub fn cstr(s: &str) -> CString {
    let bytes: Vec<u8> = s.bytes().filter(|&b| b != 0).collect();
    CString::new(bytes).unwrap_or_default()
}

/// A unix timestamp as `YYYY-MM-DD` (UTC), for the delegation expiry screen.
/// Days-since-epoch to civil date, Howard Hinnant's algorithm.
pub fn date_utc(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}
