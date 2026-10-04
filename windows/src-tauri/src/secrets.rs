// API keys live in the Windows Credential Manager or, on Linux, the Secret
// Service (GNOME Keyring, KWallet) — never on disk and never in the front end — the island can only ask whether a key is present.

use keyring::Entry;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Values already read from the keyring. Each read is a D-Bus round trip plus a
/// key exchange, and the pollers ask for the same keys every few seconds; only
/// Coucou writes these entries, so the cache stays right through set/clear.
fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember(key: &str, value: Option<String>) {
    if let Ok(mut c) = cache().lock() {
        c.insert(key.to_string(), value);
    }
}

const SERVICE: &str = "fr.louisraille.coucou";

/// Every key Coucou may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
    "discord-client-id",
    "discord-client-secret",
    "discord-refresh-token",
];

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    if let Some(hit) = cache().lock().ok().and_then(|c| c.get(key).cloned()) {
        return hit;
    }
    let value = entry(key)?.get_password().ok().filter(|v| !v.is_empty());
    remember(key, value.clone());
    value
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        remember(key, None);
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())?;
    remember(key, Some(value.to_string()));
    Ok(())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            remember(key, None);
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}
