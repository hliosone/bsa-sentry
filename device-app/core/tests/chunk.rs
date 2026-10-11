//! The chunked-APDU reassembler, checked against the same golden vectors as the TypeScript
//! encoder. The two error paths matter as much as the happy one: a desynchronised transfer
//! on real hardware is very hard to debug, so both are pinned here.
use bsa_sentry_core::chunk::{Reassembler, ChunkError, MAX_APDU_DATA, MAX_REASSEMBLY, P1_FIRST, P1_NEXT, P2_LAST, P2_MORE};
use serde_json::Value;

fn fixtures() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/types/fixtures/wire.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i & 0xff) as u8).collect()
}

#[test]
fn the_limits_match_the_contract() {
    assert_eq!(MAX_APDU_DATA, 250);
    assert_eq!(MAX_REASSEMBLY, 1024);
}

#[test]
fn every_chunking_fixture_reassembles_to_the_original_payload() {
    let f = fixtures();
    for case in f["chunking"].as_array().unwrap() {
        let len = case["payloadLen"].as_u64().unwrap() as usize;
        let mut r = Reassembler::new();
        let mut done: Option<&[u8]> = None;
        let apdus = case["apdus"].as_array().unwrap();

        for (i, apdu) in apdus.iter().enumerate() {
            let raw = hex::decode(apdu.as_str().unwrap().trim_start_matches("0x")).unwrap();
            let (p1, p2, data) = (raw[2], raw[3], &raw[5..]);
            assert_eq!(raw[4] as usize, data.len(), "len {len}, chunk {i}: Lc must match the data");
            done = r.push(p1, p2, data).unwrap_or_else(|e| panic!("len {len}, chunk {i}: {e:?}"));
            if i + 1 < apdus.len() {
                assert!(done.is_none(), "len {len}: only the last chunk completes the transfer");
            }
        }
        assert_eq!(done.expect("the last chunk must complete"), &pattern(len)[..], "payload for len {len}");
    }
}

#[test]
fn a_transfer_of_exactly_the_buffer_size_is_accepted() {
    let mut r = Reassembler::new();
    let payload = pattern(MAX_REASSEMBLY);
    let mut done = None;
    for (i, chunk) in payload.chunks(MAX_APDU_DATA).enumerate() {
        let last = (i + 1) * MAX_APDU_DATA >= payload.len();
        let p1 = if i == 0 { P1_FIRST } else { P1_NEXT };
        let p2 = if last { P2_LAST } else { P2_MORE };
        done = r.push(p1, p2, chunk).unwrap();
    }
    assert_eq!(done.unwrap(), &payload[..]);
}

#[test]
fn one_byte_past_the_buffer_is_refused_with_payload_too_large() {
    let mut r = Reassembler::new();
    for i in 0..4 {
        r.push(if i == 0 { P1_FIRST } else { P1_NEXT }, P2_MORE, &pattern(250)).unwrap();
    }
    // 1000 bytes in; 25 more would be 1025.
    assert_eq!(r.push(P1_NEXT, P2_LAST, &pattern(25)), Err(ChunkError::PayloadTooLarge));
}

#[test]
fn an_overflow_drops_the_partial_buffer_so_the_host_cannot_keep_pushing() {
    let mut r = Reassembler::new();
    for i in 0..4 {
        r.push(if i == 0 { P1_FIRST } else { P1_NEXT }, P2_MORE, &pattern(250)).unwrap();
    }
    assert_eq!(r.push(P1_NEXT, P2_LAST, &pattern(25)), Err(ChunkError::PayloadTooLarge));
    // The transfer is gone: this is now a "next without first", not a resumption.
    assert_eq!(r.push(P1_NEXT, P2_LAST, &pattern(1)), Err(ChunkError::NextWithoutFirst));
    // And a fresh transfer works.
    assert_eq!(r.push(P1_FIRST, P2_LAST, &[7]).unwrap().unwrap(), &[7]);
}

#[test]
fn a_next_chunk_without_a_first_is_refused() {
    let mut r = Reassembler::new();
    assert_eq!(r.push(P1_NEXT, P2_LAST, &pattern(10)), Err(ChunkError::NextWithoutFirst));
}

#[test]
fn a_next_chunk_after_a_completed_transfer_is_refused() {
    let mut r = Reassembler::new();
    r.push(P1_FIRST, P2_LAST, &pattern(5)).unwrap();
    assert_eq!(r.push(P1_NEXT, P2_LAST, &pattern(5)), Err(ChunkError::NextWithoutFirst));
}

#[test]
fn a_new_first_chunk_discards_an_abandoned_transfer() {
    // Otherwise a host could prepend 250 bytes of its own to the next policy.
    let mut r = Reassembler::new();
    r.push(P1_FIRST, P2_MORE, &pattern(250)).unwrap();
    let done = r.push(P1_FIRST, P2_LAST, &[9, 9, 9]).unwrap().unwrap();
    assert_eq!(done, &[9, 9, 9]);
}

#[test]
fn unknown_p1_or_p2_values_are_refused_rather_than_guessed() {
    let mut r = Reassembler::new();
    assert_eq!(r.push(0x02, P2_LAST, &[1]), Err(ChunkError::BadParameter));
    assert_eq!(r.push(P1_FIRST, 0x7f, &[1]), Err(ChunkError::BadParameter));
}

#[test]
fn a_chunk_larger_than_one_apdu_is_refused() {
    let mut r = Reassembler::new();
    assert_eq!(r.push(P1_FIRST, P2_MORE, &pattern(251)), Err(ChunkError::BadParameter));
}

#[test]
fn an_empty_payload_completes_immediately() {
    let mut r = Reassembler::new();
    assert_eq!(r.push(P1_FIRST, P2_LAST, &[]).unwrap().unwrap(), &[] as &[u8]);
}

#[test]
fn a_reset_clears_everything() {
    let mut r = Reassembler::new();
    r.push(P1_FIRST, P2_MORE, &pattern(100)).unwrap();
    r.reset();
    assert_eq!(r.push(P1_NEXT, P2_MORE, &pattern(1)), Err(ChunkError::NextWithoutFirst));
}
