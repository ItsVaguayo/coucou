// Discord over its local RPC socket: mute and deafen yourself, see the voice
// channel you are in and who is talking, get mentions and DMs on the island, and
// toggle mute with a global key.
//
// Discord only lets the *owner* of an application use the voice scopes, so the
// user registers their own app once (client id + secret in Settings) and
// authorizes it from Discord's own prompt. The refresh token lives in the
// keyring; the access token only in memory.
//
// Nothing polls: one thread waits on the socket. While Discord is closed, or the
// pill is off, it looks for the socket every few seconds and does nothing else.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::integrations::{emit, IntegrationUpdate};
use crate::island::WINDOW_LABEL;
use crate::{log, secrets};

pub const ID: &str = "integration_discord";
const SCOPES: &[&str] = &["rpc", "rpc.voice.read", "rpc.voice.write", "rpc.notifications.read"];
const RETRY: Duration = Duration::from_secs(5);
const TOKEN_URL: &str = "https://discord.com/api/oauth2/token";
const REDIRECT: &str = "http://127.0.0.1";

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    id: String,
    name: String,
    avatar: String,
    speaking: bool,
    mute: bool,
    deaf: bool,
}

#[derive(Default)]
struct Voice {
    running: bool,
    configured: bool,
    authorized: bool,
    mute: bool,
    deaf: bool,
    channel_id: Option<String>,
    channel_name: String,
    guild_id: Option<String>,
    members: Vec<Member>,
    speaking: HashSet<String>,
    error: Option<String>,
}

fn voice() -> &'static Mutex<Voice> {
    static V: OnceLock<Mutex<Voice>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(Voice::default()))
}

/// The write half of the live connection, if any.
fn writer() -> &'static Mutex<Option<UnixStream>> {
    static W: OnceLock<Mutex<Option<UnixStream>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(None))
}

fn access_token() -> &'static Mutex<Option<String>> {
    static T: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(None))
}

static NONCE: AtomicU64 = AtomicU64::new(1);

/// Debug builds only: `COUCOU_DISCORD_FAKE=1` skips OAuth (client id and token
/// "test"), for checking the island against a fake Discord socket.
fn test_mode() -> bool {
    cfg!(debug_assertions) && std::env::var_os("COUCOU_DISCORD_FAKE").is_some()
}
static APP: OnceLock<AppHandle> = OnceLock::new();

// ── Wire format ───────────────────────────────────────────────────────────────

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;
const OP_PONG: u32 = 4;

fn write_frame(stream: &mut UnixStream, op: u32, body: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    let mut buf = Vec::with_capacity(8 + bytes.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    buf.extend_from_slice(&bytes);
    stream.write_all(&buf)
}

fn read_frame(stream: &mut UnixStream) -> std::io::Result<(u32, Value)> {
    let mut head = [0u8; 8];
    stream.read_exact(&mut head)?;
    let op = u32::from_le_bytes([head[0], head[1], head[2], head[3]]);
    let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
    if len > 4 << 20 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body)?;
    Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

/// Sends one RPC command on the live connection. False when Discord isn't there.
fn send(cmd: &str, args: Value, evt: Option<&str>) -> bool {
    let mut body = json!({
        "cmd": cmd,
        "args": args,
        "nonce": NONCE.fetch_add(1, Ordering::Relaxed).to_string(),
    });
    if let Some(evt) = evt {
        body["evt"] = json!(evt);
    }
    let mut guard = writer().lock().unwrap();
    let Some(stream) = guard.as_mut() else { return false };
    write_frame(stream, OP_FRAME, &body).is_ok()
}

fn subscribe(evt: &str, args: Value) {
    send("SUBSCRIBE", args, Some(evt));
}

fn unsubscribe(evt: &str, args: Value) {
    send("UNSUBSCRIBE", args, Some(evt));
}

// ── Socket discovery ──────────────────────────────────────────────────────────

/// Discord's socket: the plain client, the snap and the flatpak each keep it
/// somewhere else under the runtime dir.
fn socket_candidates() -> Vec<PathBuf> {
    let run = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() })));
    let dirs = [
        run.clone(),
        run.join("snap.discord"),
        run.join("app/com.discordapp.Discord"),
        run.join(".flatpak/dev.vencord.Vesktop/xdg-run"),
    ];
    let mut out = Vec::new();
    for dir in dirs {
        for i in 0..10 {
            out.push(dir.join(format!("discord-ipc-{i}")));
        }
    }
    out
}

fn connect() -> Option<UnixStream> {
    socket_candidates().into_iter().filter(|p| p.exists()).find_map(|p| UnixStream::connect(p).ok())
}

// ── State out to the island ───────────────────────────────────────────────────

fn publish() {
    let Some(app) = APP.get() else { return };
    let v = voice().lock().unwrap();
    let members: Vec<Member> = v
        .members
        .iter()
        .map(|m| Member { speaking: v.speaking.contains(&m.id), ..m.clone() })
        .collect();
    let channel = v.channel_id.as_ref().map(|id| json!({ "id": id, "name": v.channel_name }));
    let data = json!({
        "running": v.running,
        "configured": v.configured,
        "authorized": v.authorized,
        "mute": v.mute,
        "deaf": v.deaf,
        "channel": channel,
        "members": members,
    });
    let error = v.error.clone();
    drop(v);
    emit(app, IntegrationUpdate { id: ID, data, error, event: None });
}

fn update(f: impl FnOnce(&mut Voice)) {
    f(&mut voice().lock().unwrap());
    publish();
}

fn avatar_url(id: &str, hash: Option<&str>) -> String {
    match hash {
        Some(h) if !h.is_empty() => format!("https://cdn.discordapp.com/avatars/{id}/{h}.png?size=64"),
        _ => {
            let n = id.parse::<u64>().map(|n| (n >> 22) % 6).unwrap_or(0);
            format!("https://cdn.discordapp.com/embed/avatars/{n}.png")
        }
    }
}

/// One entry of `voice_states` (GET_SELECTED_VOICE_CHANNEL, VOICE_STATE_*).
fn member_of(state: &Value) -> Option<Member> {
    let user = state.get("user")?;
    let id = user.get("id")?.as_str()?.to_string();
    let name = state
        .get("nick")
        .and_then(Value::as_str)
        .or_else(|| user.get("global_name").and_then(Value::as_str))
        .or_else(|| user.get("username").and_then(Value::as_str))
        .unwrap_or("?")
        .to_string();
    let vs = state.get("voice_state").cloned().unwrap_or(Value::Null);
    let flag = |k: &str| vs.get(k).and_then(Value::as_bool).unwrap_or(false);
    Some(Member {
        avatar: avatar_url(&id, user.get("avatar").and_then(Value::as_str)),
        id,
        name,
        speaking: false,
        mute: flag("mute") || flag("self_mute"),
        deaf: flag("deaf") || flag("self_deaf"),
    })
}

// ── OAuth ─────────────────────────────────────────────────────────────────────

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Code or refresh token → access token; the new refresh token is kept.
fn token(grant: &[(&str, &str)]) -> Result<String, String> {
    if crate::integrations::PAUSED.load(Ordering::Relaxed) {
        return Err("paused".into());
    }
    let id = secrets::get("discord-client-id").ok_or("no client id")?;
    let secret = secrets::get("discord-client-secret").ok_or("no client secret")?;
    let mut form: Vec<(&str, &str)> = vec![("client_id", &id), ("client_secret", &secret)];
    form.extend_from_slice(grant);
    let reply: Value = tauri::async_runtime::block_on(async {
        let res = crate::integrations::client()
            .post(TOKEN_URL)
            .form(&form)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        res.json::<Value>().await.map_err(|e| e.to_string())
    })?;
    let access = reply
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| reply.get("error_description").or(reply.get("error")).map(|e| e.to_string()).unwrap_or_default())?;
    if let Some(refresh) = reply.get("refresh_token").and_then(Value::as_str) {
        let _ = secrets::set("discord-refresh-token", refresh);
    }
    Ok(access.to_string())
}

fn exchange_code(code: &str) -> Result<String, String> {
    // Discord wants the redirect the app registered; RPC codes are also accepted
    // without one on some apps. Try with, then without.
    token(&[("grant_type", "authorization_code"), ("code", code), ("redirect_uri", REDIRECT)])
        .or_else(|_| token(&[("grant_type", "authorization_code"), ("code", code)]))
}

fn refresh() -> Result<String, String> {
    let refresh = secrets::get("discord-refresh-token").ok_or("not authorized yet")?;
    token(&[("grant_type", "refresh_token"), ("refresh_token", &refresh)])
}

fn authenticate(token: String) {
    *access_token().lock().unwrap() = Some(token.clone());
    send("AUTHENTICATE", json!({ "access_token": token }), None);
}

/// From READY: a saved refresh token gets us in without asking again.
fn sign_in() {
    if test_mode() {
        authenticate("test".into());
        return;
    }
    let cached = access_token().lock().unwrap().clone();
    if let Some(t) = cached {
        authenticate(t);
        return;
    }
    match refresh() {
        Ok(t) => authenticate(t),
        Err(err) => {
            log::line(format!("discord: not signed in ({err})"));
            update(|v| v.authorized = false);
        }
    }
}

// ── Incoming messages ─────────────────────────────────────────────────────────

fn on_authenticated() {
    update(|v| {
        v.authorized = true;
        v.error = None;
    });
    send("GET_VOICE_SETTINGS", json!({}), None);
    subscribe("VOICE_SETTINGS_UPDATE", json!({}));
    subscribe("VOICE_CHANNEL_SELECT", json!({}));
    subscribe("NOTIFICATION_CREATE", json!({}));
    send("GET_SELECTED_VOICE_CHANNEL", json!({}), None);
}

const CHANNEL_EVENTS: &[&str] =
    &["SPEAKING_START", "SPEAKING_STOP", "VOICE_STATE_CREATE", "VOICE_STATE_UPDATE", "VOICE_STATE_DELETE"];

fn set_channel(data: &Value) {
    let old = voice().lock().unwrap().channel_id.clone();
    let new = data.get("id").and_then(Value::as_str).map(str::to_string);
    if old != new {
        if let Some(old) = &old {
            for evt in CHANNEL_EVENTS {
                unsubscribe(evt, json!({ "channel_id": old }));
            }
        }
        if let Some(new) = &new {
            for evt in CHANNEL_EVENTS {
                subscribe(evt, json!({ "channel_id": new }));
            }
        }
    }
    let members: Vec<Member> = data
        .get("voice_states")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(member_of).collect())
        .unwrap_or_default();
    update(|v| {
        v.channel_id = new;
        v.channel_name = data.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        v.guild_id = data.get("guild_id").and_then(Value::as_str).map(str::to_string);
        v.members = members;
        v.speaking.clear();
    });
}

fn on_voice_settings(data: &Value) {
    let mute = data.get("mute").and_then(Value::as_bool);
    let deaf = data.get("deaf").and_then(Value::as_bool);
    update(|v| {
        if let Some(m) = mute {
            v.mute = m;
        }
        if let Some(d) = deaf {
            v.deaf = d;
        }
    });
}

#[derive(Serialize, Clone)]
struct DiscordMessage {
    from: String,
    text: String,
    at: u64,
    image: Option<String>,
}

fn on_notification(data: &Value) {
    let Some(app) = APP.get() else { return };
    let s = |k: &str| data.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let msg = DiscordMessage {
        from: s("title"),
        text: s("body"),
        at: now_ms(),
        image: data.get("icon_url").and_then(Value::as_str).map(str::to_string),
    };
    let _ = app.emit_to(WINDOW_LABEL, "discord-message", msg);
}

fn handle(msg: &Value) {
    let cmd = msg.get("cmd").and_then(Value::as_str).unwrap_or_default();
    let evt = msg.get("evt").and_then(Value::as_str);
    let data = msg.get("data").cloned().unwrap_or(Value::Null);

    if evt == Some("ERROR") {
        let message = data.get("message").and_then(Value::as_str).unwrap_or("error").to_string();
        log::line(format!("discord: {cmd} failed: {message}"));
        if cmd == "AUTHENTICATE" {
            // The access token went stale: drop it and try the refresh token once.
            *access_token().lock().unwrap() = None;
            match refresh() {
                Ok(t) => authenticate(t),
                Err(_) => update(|v| v.authorized = false),
            }
        } else if cmd == "AUTHORIZE" {
            update(|v| v.error = Some(message));
        }
        return;
    }

    match (cmd, evt) {
        ("DISPATCH", Some("READY")) => sign_in(),
        ("AUTHORIZE", _) => match data.get("code").and_then(Value::as_str).map(exchange_code) {
            Some(Ok(t)) => authenticate(t),
            Some(Err(err)) => {
                log::line(format!("discord: token exchange failed: {err}"));
                update(|v| v.error = Some(format!("Discord refused the code: {err}")));
            }
            None => {}
        },
        ("AUTHENTICATE", _) => on_authenticated(),
        ("GET_VOICE_SETTINGS", _) | ("SET_VOICE_SETTINGS", _) => on_voice_settings(&data),
        ("DISPATCH", Some("VOICE_SETTINGS_UPDATE")) => on_voice_settings(&data),
        ("DISPATCH", Some("VOICE_CHANNEL_SELECT")) => {
            if data.get("channel_id").map_or(true, Value::is_null) {
                set_channel(&Value::Null);
            } else {
                send("GET_SELECTED_VOICE_CHANNEL", json!({}), None);
            }
        }
        ("GET_SELECTED_VOICE_CHANNEL", _) => set_channel(&data),
        ("DISPATCH", Some("SPEAKING_START")) | ("DISPATCH", Some("SPEAKING_STOP")) => {
            let Some(user) = data.get("user_id").and_then(Value::as_str).map(str::to_string) else { return };
            let on = evt == Some("SPEAKING_START");
            update(|v| {
                if on {
                    v.speaking.insert(user);
                } else {
                    v.speaking.remove(&user);
                }
            });
        }
        ("DISPATCH", Some("VOICE_STATE_CREATE")) | ("DISPATCH", Some("VOICE_STATE_UPDATE")) => {
            let Some(m) = member_of(&data) else { return };
            update(|v| match v.members.iter_mut().find(|x| x.id == m.id) {
                Some(slot) => *slot = m,
                None => v.members.push(m),
            });
        }
        ("DISPATCH", Some("VOICE_STATE_DELETE")) => {
            let Some(m) = member_of(&data) else { return };
            update(|v| {
                v.members.retain(|x| x.id != m.id);
                v.speaking.remove(&m.id);
            });
        }
        ("DISPATCH", Some("NOTIFICATION_CREATE")) => on_notification(&data),
        _ => {}
    }
}

// ── Connection loop ───────────────────────────────────────────────────────────

fn enabled(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().active_integrations.iter().any(|x| x == ID))
        .unwrap_or(false)
}

fn session(app: &AppHandle, client_id: &str) -> std::io::Result<()> {
    let Some(mut stream) = connect() else {
        return Err(std::io::ErrorKind::NotFound.into());
    };
    write_frame(&mut stream, OP_HANDSHAKE, &json!({ "v": 1, "client_id": client_id }))?;
    *writer().lock().unwrap() = Some(stream.try_clone()?);
    update(|v| {
        v.running = true;
        v.error = None;
    });
    log::line("discord: connected");
    let result = loop {
        let (op, msg) = match read_frame(&mut stream) {
            Ok(frame) => frame,
            Err(err) => break Err(err),
        };
        match op {
            OP_FRAME => handle(&msg),
            OP_PING => {
                if let Some(w) = writer().lock().unwrap().as_mut() {
                    let _ = write_frame(w, OP_PONG, &msg);
                }
            }
            OP_CLOSE => {
                let reason = msg.get("message").and_then(Value::as_str).unwrap_or_default();
                log::line(format!("discord: closed ({reason})"));
                if reason.to_lowercase().contains("client id") {
                    update(|v| v.error = Some("Discord does not know that Client ID".into()));
                }
                break Ok(());
            }
            _ => {}
        }
        if !enabled(app) {
            break Ok(());
        }
    };
    *writer().lock().unwrap() = None;
    result
}

pub fn start(app: AppHandle) {
    let _ = APP.set(app.clone());
    std::thread::spawn(move || {
        let mut said_closed = false;
        loop {
            let client_id = if test_mode() { Some("test".into()) } else { secrets::get("discord-client-id") };
            let on = enabled(&app);
            {
                let mut v = voice().lock().unwrap();
                v.configured = client_id.is_some();
            }
            if !on || client_id.is_none() {
                std::thread::sleep(RETRY);
                continue;
            }
            match session(&app, client_id.as_deref().unwrap_or_default()) {
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => log::line(format!("discord: connection lost ({err})")),
                Ok(()) => {}
            }
            // Discord gone (or never there): tell the island once, then wait.
            let was_running = voice().lock().unwrap().running;
            if was_running || !said_closed {
                said_closed = true;
                update(|v| {
                    let configured = v.configured;
                    let error = v.error.take();
                    *v = Voice { configured, error, ..Voice::default() };
                });
            }
            std::thread::sleep(RETRY);
        }
    });
}

// ── Commands from the island ──────────────────────────────────────────────────

pub fn toggle_mute() -> bool {
    let mute = !voice().lock().unwrap().mute;
    send("SET_VOICE_SETTINGS", json!({ "mute": mute }), None)
}

/// "mute", "deaf" or "leave".
pub fn control(action: &str) -> bool {
    match action {
        "mute" => toggle_mute(),
        "deaf" => {
            let deaf = !voice().lock().unwrap().deaf;
            send("SET_VOICE_SETTINGS", json!({ "deaf": deaf }), None)
        }
        "leave" => send("SELECT_VOICE_CHANNEL", json!({ "channel_id": null, "force": true }), None),
        _ => false,
    }
}

/// Opens Discord's "Authorize Coucou?" prompt. Err when Discord isn't running
/// or the client id is missing.
pub fn authorize() -> Result<(), String> {
    let id = secrets::get("discord-client-id").ok_or("Paste the Client ID first.")?;
    *access_token().lock().unwrap() = None;
    update(|v| v.error = None);
    // No redirect_uri here: RPC refuses one. But the app must have a redirect
    // registered in the developer portal, or Discord answers "Missing
    // redirect_uri" — the token exchange then uses that same redirect.
    if send("AUTHORIZE", json!({ "client_id": id, "scopes": SCOPES }), None) {
        Ok(())
    } else {
        Err("Open Discord first.".into())
    }
}

// ── Global mute key (X11) ─────────────────────────────────────────────────────

/// Over XCB, whose errors come back as values: a key another app already grabbed
/// must not reach the process-wide Xlib error handler GDK owns.
mod xcb {
    use std::os::raw::{c_int, c_void};

    #[repr(C)]
    pub struct Cookie {
        pub sequence: u32,
    }
    #[repr(C)]
    pub struct ScreenIterator {
        pub data: *const u32, // xcb_screen_t starts with its root window id
        pub rem: c_int,
        pub index: c_int,
    }
    #[repr(C)]
    pub struct GenericEvent {
        pub response_type: u8,
        pub detail: u8,
        pub sequence: u16,
    }

    #[link(name = "xcb")]
    extern "C" {
        pub fn xcb_connect(name: *const i8, screen: *mut c_int) -> *mut c_void;
        pub fn xcb_connection_has_error(c: *mut c_void) -> c_int;
        pub fn xcb_get_setup(c: *mut c_void) -> *const u8;
        pub fn xcb_setup_roots_iterator(setup: *const u8) -> ScreenIterator;
        pub fn xcb_get_keyboard_mapping(c: *mut c_void, first: u8, count: u8) -> Cookie;
        pub fn xcb_get_keyboard_mapping_reply(c: *mut c_void, cookie: Cookie, err: *mut *mut c_void) -> *mut u8;
        pub fn xcb_get_keyboard_mapping_keysyms(reply: *const u8) -> *const u32;
        pub fn xcb_get_keyboard_mapping_keysyms_length(reply: *const u8) -> c_int;
        pub fn xcb_grab_key_checked(
            c: *mut c_void, owner_events: u8, grab_window: u32, modifiers: u16, key: u8, pointer_mode: u8,
            keyboard_mode: u8,
        ) -> Cookie;
        pub fn xcb_ungrab_key(c: *mut c_void, key: u8, grab_window: u32, modifiers: u16) -> Cookie;
        pub fn xcb_request_check(c: *mut c_void, cookie: Cookie) -> *mut c_void;
        pub fn xcb_get_file_descriptor(c: *mut c_void) -> c_int;
        pub fn xcb_poll_for_event(c: *mut c_void) -> *mut GenericEvent;
        pub fn xcb_flush(c: *mut c_void) -> c_int;
    }
}

/// X keysym for a key name offered in Settings.
fn keysym(name: &str) -> Option<u32> {
    match name {
        "Pause" => Some(0xff13),
        "ScrollLock" => Some(0xff14),
        "F13" => Some(0xffca),
        "F14" => Some(0xffcb),
        _ => None,
    }
}

static KEY_WAKE: OnceLock<i32> = OnceLock::new();
fn wanted_key() -> &'static Mutex<String> {
    static K: OnceLock<Mutex<String>> = OnceLock::new();
    K.get_or_init(|| Mutex::new(String::new()))
}

/// Settings changed the key (or turned it off): regrab without a restart.
pub fn set_mute_key(name: &str) {
    *wanted_key().lock().unwrap() = name.to_string();
    if let Some(fd) = KEY_WAKE.get() {
        unsafe { libc::write(*fd, [1u8].as_ptr() as *const _, 1) };
    }
}

pub fn start_mute_key(initial: &str) {
    let x11 = std::env::var("XDG_SESSION_TYPE").map(|v| v == "x11").unwrap_or(false)
        || (std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_some());
    if !x11 {
        return;
    }
    *wanted_key().lock().unwrap() = initial.to_string();
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    let _ = KEY_WAKE.set(fds[1]);
    let wake_read = fds[0];

    std::thread::spawn(move || unsafe {
        let c = xcb::xcb_connect(std::ptr::null(), std::ptr::null_mut());
        if c.is_null() || xcb::xcb_connection_has_error(c) != 0 {
            log::line("discord key: no X connection");
            return;
        }
        let setup = xcb::xcb_get_setup(c);
        let root = *xcb::xcb_setup_roots_iterator(setup).data;
        let (min_kc, max_kc) = (*setup.add(34), *setup.add(35));

        let keycode_for = |sym: u32| -> Option<u8> {
            let count = max_kc - min_kc + 1;
            let mut err = std::ptr::null_mut();
            let reply =
                xcb::xcb_get_keyboard_mapping_reply(c, xcb::xcb_get_keyboard_mapping(c, min_kc, count), &mut err);
            if !err.is_null() {
                libc::free(err);
            }
            if reply.is_null() {
                return None;
            }
            let per = *reply.add(1) as usize;
            let syms = xcb::xcb_get_keyboard_mapping_keysyms(reply);
            let len = xcb::xcb_get_keyboard_mapping_keysyms_length(reply) as usize;
            let found = (0..len).step_by(per.max(1)).find(|&i| *syms.add(i) == sym);
            libc::free(reply as *mut _);
            found.map(|i| min_kc + (i / per.max(1)) as u8)
        };
        // Plain, Caps Lock, Num Lock, both: a grab only matches its exact modifiers.
        const MODS: [u16; 4] = [0, 2, 16, 18];
        let mut grabbed: Option<u8> = None;
        let mut last_press = std::time::Instant::now() - Duration::from_secs(1);

        loop {
            let want = wanted_key().lock().unwrap().clone();
            let want_kc = keysym(&want).and_then(keycode_for);
            if want_kc != grabbed {
                if let Some(kc) = grabbed.take() {
                    for m in MODS {
                        xcb::xcb_ungrab_key(c, kc, root, m);
                    }
                }
                if let Some(kc) = want_kc {
                    let mut ok = true;
                    for m in MODS {
                        let e = xcb::xcb_request_check(c, xcb::xcb_grab_key_checked(c, 1, root, m, kc, 1, 1));
                        if !e.is_null() {
                            ok = false;
                            libc::free(e);
                        }
                    }
                    log::line(format!("discord key: {want} {}", if ok { "grabbed" } else { "taken by another app" }));
                    grabbed = Some(kc);
                }
                xcb::xcb_flush(c);
            }

            let mut pfd = [
                libc::pollfd { fd: xcb::xcb_get_file_descriptor(c), events: libc::POLLIN, revents: 0 },
                libc::pollfd { fd: wake_read, events: libc::POLLIN, revents: 0 },
            ];
            if libc::poll(pfd.as_mut_ptr(), 2, -1) < 0 {
                continue;
            }
            if pfd[1].revents & libc::POLLIN != 0 {
                let mut buf = [0u8; 16];
                libc::read(wake_read, buf.as_mut_ptr() as *mut _, buf.len());
            }
            loop {
                let ev = xcb::xcb_poll_for_event(c);
                if ev.is_null() {
                    break;
                }
                // KeyPress = 2. Held keys auto-repeat: one toggle per 300 ms.
                if (*ev).response_type & 0x7f == 2 && Some((*ev).detail) == grabbed {
                    if last_press.elapsed() > Duration::from_millis(300) {
                        toggle_mute();
                    }
                    last_press = std::time::Instant::now();
                }
                libc::free(ev as *mut _);
            }
            if xcb::xcb_connection_has_error(c) != 0 {
                log::line("discord key: X connection lost");
                return;
            }
        }
    });
}
