//! coucou-hook — the relay Claude Code runs on every hook event.
//!
//! Reads the hook JSON on stdin, adds a little terminal context, and hands it to
//! Coucou over the named pipe `\\.\pipe\coucou-<sid>` (Windows) or the Unix
//! socket `$XDG_RUNTIME_DIR/coucou.sock` (Linux).
//!
//! Hard rule (docs/CLAUDE.md): **never block Claude Code.**
//! * If the pipe does not exist — Coucou is closed — we exit 0 immediately with
//!   nothing on stdout, and the session carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means empty stdout, and Claude Code
//!   asks in the terminal exactly as if Coucou were not installed.
//!
//! Usage: `coucou-hook <EventName>` (the name is also read from the JSON).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

/// Budget for getting a pipe connection. Beyond this Claude Code wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them. `transcript_path` is
/// only a path and is kept: the session detail view reads the transcript's tail.
const DROPPED_FIELDS: &[&str] = &["tool_response"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

#[cfg(windows)]
mod win;
#[cfg(windows)]
use win::connect;

#[cfg(target_os = "linux")]
mod unix;
#[cfg(target_os = "linux")]
use unix::connect;

fn main() {
    let Some((payload, event, original)) = read_event() else { std::process::exit(0) };

    let waits_for_answer = event == "PermissionRequest";
    let budget = if waits_for_answer { DECISION_BUDGET } else { FIRE_AND_FORGET_BUDGET };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&payload, waits_for_answer));
    });

    if let Ok(Some(decision)) = rx.recv_timeout(budget) {
        if let Some(json) = decision_json(&decision, &original) {
            let mut out = std::io::stdout();
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
    // Nothing printed: Claude Code asks in the terminal, as if we were not here.
    std::process::exit(0);
}

/// The tool being approved and its input exactly as Claude sent it, before
/// `truncate_strings` shortened anything for the island.
struct Original {
    tool: String,
    input: serde_json::Value,
    /// Claude Code's own "don't ask again" options for this request.
    suggestions: serde_json::Value,
}

/// The suggestions "Always" may apply: allow rules kept for this session or in
/// the project's .claude/settings.local.json. Never a mode change (that is how
/// bypassPermissions would get in) and never the user's own settings file.
fn always_rules(suggestions: &serde_json::Value) -> Vec<serde_json::Value> {
    suggestions
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|s| {
                    s["type"] == "addRules"
                        && s["behavior"] == "allow"
                        && (s["destination"] == "session" || s["destination"] == "localSettings")
                        && s["rules"].as_array().is_some_and(|r| !r.is_empty())
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Tools for which a bare allow does nothing: Claude Code wants `updatedInput`
/// with them, holding the user's answer (AskUserQuestion) or the input itself.
const NEEDS_UPDATED_INPUT: &[&str] = &["AskUserQuestion", "ExitPlanMode"];

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
///
/// Besides `allow` / `deny`, the app may send `answer {"<question>": "<label>"}`
/// for AskUserQuestion: the answers are added to the original input, which
/// stays here so a long question never reaches Claude Code cut short.
fn decision_json(decision: &str, original: &Original) -> Option<String> {
    let decision = decision.trim();
    let behavior = if let Some(answers) = decision.strip_prefix("answer ") {
        if original.tool != "AskUserQuestion" {
            return None;
        }
        let answers = serde_json::from_str::<serde_json::Value>(answers).ok()?;
        let all_strings = answers.as_object()?.values().all(|v| v.is_string());
        if !all_strings || answers.as_object()?.is_empty() {
            return None;
        }
        let mut input = original.input.as_object()?.clone();
        input.insert("answers".into(), answers);
        serde_json::json!({ "behavior": "allow", "updatedInput": input }).to_string()
    } else {
        match decision {
            // An answer is the only way to allow a question; a bare allow would
            // leave Claude Code waiting in the terminal anyway.
            "allow" | "always" if original.tool == "AskUserQuestion" => return None,
            "allow" | "always" if NEEDS_UPDATED_INPUT.contains(&original.tool.as_str()) => {
                serde_json::json!({ "behavior": "allow", "updatedInput": original.input }).to_string()
            }
            // "Always": the allow rules Claude Code itself offered, or a plain allow
            // when it offered none we accept.
            "always" => {
                let rules = always_rules(&original.suggestions);
                if rules.is_empty() {
                    r#"{"behavior":"allow"}"#.to_string()
                } else {
                    serde_json::json!({ "behavior": "allow", "updatedPermissions": rules }).to_string()
                }
            }
            "allow" => r#"{"behavior":"allow"}"#.to_string(),
            "deny" => r#"{"behavior":"deny","message":"Denied from Coucou"}"#.to_string(),
            _ => return None,
        }
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// Reads stdin and returns the payload to forward, the event name, and the
/// untouched tool input.
fn read_event() -> Option<(String, String, Original)> {
    let mut raw = Vec::new();
    if std::io::stdin().read_to_end(&mut raw).is_err() || raw.is_empty() {
        return None;
    }
    // Some shells hand us a UTF-8 BOM; serde_json would choke on it.
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw.drain(..3);
    }

    let mut payload = serde_json::from_slice::<serde_json::Value>(&raw).ok()?;
    let original = Original {
        tool: payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        input: payload.get("tool_input").cloned().unwrap_or(serde_json::Value::Null),
        suggestions: payload.get("permission_suggestions").cloned().unwrap_or(serde_json::Value::Null),
    };
    let map = payload.as_object_mut()?;

    // Parse argv: "coucou-hook.exe [--agent <name>] [<EventName>]"
    // --agent tags the payload with coucou_agent so the app routes to the right pill.
    // Absent or invalid names are validated and discarded by the app, not here.
    let mut agent = String::new();
    let mut arg_event = String::new();
    {
        let mut it = std::env::args().skip(1);
        while let Some(arg) = it.next() {
            if arg == "--agent" {
                agent = it.next().unwrap_or_default();
            } else if arg_event.is_empty() {
                arg_event = arg;
            }
        }
    }
    // Which agent this hook was installed for. Absent means Claude Code,
    // so existing hook commands keep working unchanged.
    if !agent.is_empty() {
        map.insert("coucou_agent".into(), serde_json::Value::String(agent));
    }
    let event = map
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .unwrap_or(arg_event);
    map.insert("hook_event_name".into(), serde_json::Value::String(event.clone()));

    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    let cwd_missing = map
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::is_empty)
        .unwrap_or(true);
    if cwd_missing {
        if let Ok(cwd) = std::env::current_dir() {
            map.insert(
                "cwd".into(),
                serde_json::Value::String(cwd.to_string_lossy().to_string()),
            );
        }
    }

    // Which terminal the session runs in. Unlike macOS, Coucou here accepts
    // events from every terminal, so this is context only — never a filter.
    for (key, var) in [
        ("term_program", "TERM_PROGRAM"),
        ("wt_session", "WT_SESSION"),
        ("term_session_id", "TERM_SESSION_ID"),
        ("vscode_pid", "VSCODE_PID"),
        ("session_pid", "CLAUDE_CODE_SSE_PORT"),
    ] {
        if !map.contains_key(key) {
            let value = std::env::var(var).unwrap_or_default();
            map.insert(key.into(), serde_json::Value::String(value));
        }
    }

    // The claude process behind this hook, so the island can bring its terminal
    // window forward. Linux only: /proc is where the parent chain lives.
    #[cfg(target_os = "linux")]
    if let Some(pid) = claude_pid() {
        map.insert("claude_pid".into(), serde_json::Value::from(pid));
    }

    truncate_strings(&mut payload);

    let mut line = payload.to_string();
    line.push('\n');
    Some((line, event, original))
}

/// Walks up from our parent to the first process that is Claude Code: `claude`
/// itself, or a runtime whose command line runs it (the VS Code extension).
#[cfg(target_os = "linux")]
fn claude_pid() -> Option<u32> {
    let mut pid = std::os::unix::process::parent_id();
    for _ in 0..8 {
        if pid <= 1 {
            return None;
        }
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        let argv0 = cmdline.split(|&b| b == 0).next().unwrap_or_default();
        let argv0 = String::from_utf8_lossy(argv0);
        let runs_claude = String::from_utf8_lossy(&cmdline).contains("claude")
            && !comm.trim().ends_with("sh")
            && !argv0.contains("coucou-hook");
        if comm.trim() == "claude" || argv0.rsplit('/').next() == Some("claude") || runs_claude {
            return Some(pid);
        }
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // "pid (comm) state ppid …" — comm may contain spaces, so cut after ')'.
        let after = stat.rsplit_once(')')?.1;
        pid = after.split_whitespace().nth(1)?.parse().ok()?;
    }
    None
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                // Cut on a char boundary; a lone byte index can split UTF-8.
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        serde_json::Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Option<String> {
    let mut pipe = connect()?;

    if pipe.write_all(payload.as_bytes()).is_err() {
        return None;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return None;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    (!answer.is_empty()).then_some(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bash() -> Original {
        Original { tool: "Bash".into(), input: serde_json::json!({ "command": "ls" }), suggestions: serde_json::Value::Null }
    }

    fn question() -> Original {
        Original {
            tool: "AskUserQuestion".into(),
            input: serde_json::json!({ "questions": [{
                "question": "Which framework?", "header": "Framework", "multiSelect": false,
                "options": [{ "label": "React", "description": "x" }, { "label": "Vue", "description": "y" }],
            }] }),
            suggestions: serde_json::Value::Null,
        }
    }

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow", &bash()).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            decision_json("deny", &bash()).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Coucou"}}}"#
        );
        // "always" is an island concept; Claude Code just gets an allow.
        assert!(decision_json("always", &bash()).unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("", &bash()).is_none());
        assert!(decision_json("maybe", &bash()).is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, &bash()).is_none());
    }

    #[test]
    fn a_question_is_answered_with_the_original_input_plus_answers() {
        let out = decision_json(r#"answer {"Which framework?":"React"}"#, &question()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let d = &v["hookSpecificOutput"]["decision"];
        assert_eq!(d["behavior"], "allow");
        assert_eq!(d["updatedInput"]["answers"]["Which framework?"], "React");
        assert_eq!(d["updatedInput"]["questions"][0]["options"][1]["label"], "Vue");
    }

    #[test]
    fn a_question_is_never_allowed_without_answers() {
        assert!(decision_json("allow", &question()).is_none());
        assert!(decision_json("answer {}", &question()).is_none());
        assert!(decision_json("answer nope", &question()).is_none());
        assert!(decision_json(r#"answer {"q":1}"#, &question()).is_none());
        // Answers only make sense for a question.
        assert!(decision_json(r#"answer {"q":"a"}"#, &bash()).is_none());
        // Deny still works.
        assert!(decision_json("deny", &question()).unwrap().contains(r#""behavior":"deny""#));
    }

    #[test]
    fn plan_approval_echoes_the_untruncated_input() {
        let plan = "p".repeat(5000);
        let o = Original { tool: "ExitPlanMode".into(), input: serde_json::json!({ "plan": plan }), suggestions: serde_json::Value::Null };
        let v: serde_json::Value = serde_json::from_str(&decision_json("allow", &o).unwrap()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["decision"]["updatedInput"]["plan"].as_str().unwrap().len(), 5000);
    }

    #[test]
    fn always_applies_only_safe_allow_rules() {
        let o = Original {
            tool: "Bash".into(),
            input: serde_json::json!({ "command": "npm test" }),
            suggestions: serde_json::json!([
                { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test:*" }], "behavior": "allow", "destination": "localSettings" },
                { "type": "setMode", "mode": "bypassPermissions", "destination": "session" },
                { "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "allow", "destination": "userSettings" },
            ]),
        };
        let v: serde_json::Value = serde_json::from_str(&decision_json("always", &o).unwrap()).unwrap();
        let d = &v["hookSpecificOutput"]["decision"];
        assert_eq!(d["behavior"], "allow");
        let up = d["updatedPermissions"].as_array().unwrap();
        assert_eq!(up.len(), 1);
        assert_eq!(up[0]["rules"][0]["ruleContent"], "npm test:*");
        // Nothing acceptable offered: a plain allow, no rules.
        let plain = decision_json("always", &bash()).unwrap();
        assert!(!plain.contains("updatedPermissions"));
        // A plain allow never carries rules, even when some were offered.
        assert!(!decision_json("allow", &o).unwrap().contains("updatedPermissions"));
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }
}
