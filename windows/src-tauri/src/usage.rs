// What every Claude Code session has used today, summed from the transcripts in
// ~/.claude/projects. Read incrementally: each file is remembered by the offset
// already counted, so a poll only reads what was appended since the last one.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageToday {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// What the same tokens would cost on the API, in dollars. An estimate: on a
    /// subscription nothing is billed per token.
    pub usd: f64,
}

struct Cache {
    since_ms: i64,
    offsets: HashMap<PathBuf, u64>,
    /// One assistant reply is written as several lines (one per content block),
    /// each repeating the same usage: count each message id once.
    seen: HashSet<String>,
    total: UsageToday,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// Dollars per million tokens: input, output, cache read. Cache writes are
/// priced from input (×1.25 for 5 minutes, ×2 for an hour).
fn prices(model: &str) -> (f64, f64, f64) {
    let m = model.to_ascii_lowercase();
    if m.contains("haiku") {
        (1.0, 5.0, 0.1)
    } else if m.contains("fable-5-1") || m.contains("mythos-5-1") {
        (10.0, 50.0, 0.25)
    } else if m.contains("fable") || m.contains("mythos") {
        (10.0, 50.0, 1.0)
    } else if m.contains("sonnet-5") {
        (2.0, 10.0, 0.2)
    } else if m.contains("sonnet") {
        (3.0, 15.0, 0.3)
    } else if m.contains("opus-5-5") {
        (4.0, 20.0, 0.2)
    } else if m.contains("opus") {
        (5.0, 25.0, 0.5)
    } else {
        (4.0, 20.0, 0.2)
    }
}

/// Milliseconds since the epoch for an RFC 3339 UTC timestamp
/// ("2026-10-03T13:01:29.393Z"), without a date crate.
fn epoch_ms(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = if b.get(19) == Some(&b'.') { num(20..23).unwrap_or(0) } else { 0 };
    // Days from civil (Howard Hinnant).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
}

fn add_line(cache: &mut Cache, line: &str) {
    if !line.contains("\"assistant\"") || !line.contains("\"usage\"") {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return;
    }
    let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()).and_then(epoch_ms) else { return };
    if ts < cache.since_ms {
        return;
    }
    let Some(msg) = v.get("message") else { return };
    let Some(id) = msg.get("id").and_then(|i| i.as_str()) else { return };
    if !cache.seen.insert(id.to_string()) {
        return;
    }
    let Some(u) = msg.get("usage") else { return };
    let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let (input, output, read) = (n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"));
    let write = n("cache_creation_input_tokens");
    let write_1h = u
        .get("cache_creation")
        .and_then(|c| c.get("ephemeral_1h_input_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0)
        .min(write);
    let model = msg.get("model").and_then(|m| m.as_str()).unwrap_or("");
    let (p_in, p_out, p_read) = prices(model);
    let usd = (input as f64 * p_in
        + output as f64 * p_out
        + read as f64 * p_read
        + (write - write_1h) as f64 * p_in * 1.25
        + write_1h as f64 * p_in * 2.0)
        / 1_000_000.0;
    cache.total.input_tokens += input + read + write;
    cache.total.output_tokens += output;
    cache.total.usd += usd;
}

/// Totals since `since_ms` (the island passes local midnight).
pub fn today(since_ms: i64) -> UsageToday {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if guard.as_ref().map(|c| c.since_ms) != Some(since_ms) {
        *guard = Some(Cache {
            since_ms,
            offsets: HashMap::new(),
            seen: HashSet::new(),
            total: UsageToday::default(),
        });
    }
    let Some(cache) = guard.as_mut() else { return UsageToday::default() };
    let since = UNIX_EPOCH + Duration::from_millis(since_ms.max(0) as u64);

    let root = crate::platform::home_dir().join(".claude").join("projects");
    let Ok(projects) = std::fs::read_dir(&root) else { return cache.total.clone() };
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = file.metadata() else { continue };
            if meta.modified().map(|m| m < since).unwrap_or(true) {
                continue;
            }
            let start = cache.offsets.get(&path).copied().unwrap_or(0);
            if meta.len() <= start {
                continue;
            }
            let Ok(mut f) = std::fs::File::open(&path) else { continue };
            if f.seek(SeekFrom::Start(start)).is_err() {
                continue;
            }
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_err() {
                continue;
            }
            // Only whole lines: a line still being written is read next time.
            let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { continue };
            let text = String::from_utf8_lossy(&buf[..=end]);
            for line in text.lines() {
                add_line(cache, line);
            }
            cache.offsets.insert(path, start + end as u64 + 1);
        }
    }
    cache.total.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_utc_timestamps() {
        assert_eq!(epoch_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(epoch_ms("2026-10-03T13:01:29.393Z"), Some(1_791_032_489_393));
    }

    #[test]
    fn counts_each_message_once_and_skips_older_ones() {
        let mut c = Cache {
            since_ms: epoch_ms("2026-10-03T00:00:00Z").unwrap(),
            offsets: HashMap::new(),
            seen: HashSet::new(),
            total: UsageToday::default(),
        };
        let line = |id: &str, ts: &str| {
            format!(
                r#"{{"type":"assistant","timestamp":"{ts}","message":{{"id":"{id}","model":"claude-opus-5-5","usage":{{"input_tokens":1000000,"output_tokens":100000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
            )
        };
        add_line(&mut c, &line("a", "2026-10-03T10:00:00Z"));
        add_line(&mut c, &line("a", "2026-10-03T10:00:00Z"));
        add_line(&mut c, &line("b", "2026-10-02T23:00:00Z"));
        assert_eq!(c.total.output_tokens, 100_000);
        assert!((c.total.usd - 6.0).abs() < 1e-9);
    }
}
