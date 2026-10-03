// Tail of a Claude Code session transcript, for the island's session detail view.
// Only the last few hundred KB of the JSONL are read: a long session's transcript
// runs to tens of MB and the view polls every few seconds.

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use serde::Serialize;

/// How much of the end of the file is read. One assistant turn rarely exceeds it.
const TAIL_BYTES: u64 = 256 * 1024;
/// Longest "last thing Claude said" handed to the island.
const MAX_TEXT_CHARS: usize = 600;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTail {
    pub model: Option<String>,
    /// Tokens in the context window on the last turn (input + cache read + cache write).
    pub context_tokens: Option<u64>,
    pub last_text: Option<String>,
    /// The title Claude Code gives the session; it is also the terminal's title.
    pub title: Option<String>,
}

/// Only files under ~/.claude/projects are readable: the path comes from a hook
/// payload, and the island must not become a way to read arbitrary files.
fn allowed(path: &str) -> Result<PathBuf, String> {
    let root = crate::platform::home_dir().join(".claude").join("projects");
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let file = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&root) || file.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("not a Claude Code transcript".into());
    }
    Ok(file)
}

pub fn tail(path: &str) -> Result<TranscriptTail, String> {
    let file = allowed(path)?;
    let mut f = std::fs::File::open(&file).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    // The first line is almost always cut in half by the seek.
    Ok(parse(&text, start > 0))
}

fn parse(text: &str, first_line_cut: bool) -> TranscriptTail {
    let mut lines: Vec<&str> = text.lines().collect();
    if first_line_cut && !lines.is_empty() {
        lines.remove(0);
    }

    let mut out = TranscriptTail::default();
    for line in lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let kind = v.get("type").and_then(|t| t.as_str());
        if kind == Some("ai-title") {
            if out.title.is_none() {
                out.title = v.get("aiTitle").and_then(|t| t.as_str()).map(str::to_string);
            }
            continue;
        }
        if kind != Some("assistant") {
            continue;
        }
        let Some(msg) = v.get("message") else { continue };
        if out.model.is_none() {
            out.model = msg.get("model").and_then(|m| m.as_str()).map(str::to_string);
        }
        if out.context_tokens.is_none() {
            if let Some(u) = msg.get("usage") {
                let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                let total =
                    n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
                if total > 0 {
                    out.context_tokens = Some(total);
                }
            }
        }
        if out.last_text.is_none() {
            if let Some(items) = msg.get("content").and_then(|c| c.as_array()) {
                let said = items
                    .iter()
                    .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n");
                let said = said.trim();
                if !said.is_empty() {
                    out.last_text = Some(said.chars().take(MAX_TEXT_CHARS).collect());
                }
            }
        }
        if out.model.is_some()
            && out.context_tokens.is_some()
            && out.last_text.is_some()
            && out.title.is_some()
        {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn reads_model_context_and_last_text_from_the_end() {
        let jsonl = [
            r#"{"type":"assistant","message":{"model":"claude-old","usage":{"input_tokens":1},"content":[{"type":"text","text":"old reply"}]}}"#,
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500},"content":[{"type":"text","text":"Done, tests pass."}]}}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":3,"cache_read_input_tokens":2000,"cache_creation_input_tokens":0},"content":[{"type":"tool_use","name":"Bash"}]}}"#,
        ]
        .join("\n");
        let t = parse(&jsonl, false);
        assert_eq!(t.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(t.context_tokens, Some(2003));
        assert_eq!(t.last_text.as_deref(), Some("Done, tests pass."));
        assert!(t.title.is_none());
    }

    #[test]
    fn reads_the_session_title() {
        let jsonl = [
            r#"{"type":"ai-title","aiTitle":"old-title"}"#,
            r#"{"type":"assistant","message":{"model":"m","usage":{"input_tokens":1},"content":[{"type":"text","text":"hi"}]}}"#,
            r#"{"type":"ai-title","aiTitle":"mochi-per-session-color"}"#,
        ]
        .join("\n");
        assert_eq!(parse(&jsonl, false).title.as_deref(), Some("mochi-per-session-color"));
    }

    #[test]
    fn skips_the_half_line_left_by_the_seek() {
        let text = "ssistant\",\"message\":{\"model\":\"x\"}}\n{\"type\":\"user\"}";
        let t = parse(text, true);
        assert!(t.model.is_none());
    }
}
