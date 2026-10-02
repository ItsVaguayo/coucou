// Linux desktop bridges over the session D-Bus, through the gio that GTK
// already brings in (no extra dependency):
//   * Mochi's eyes — on X11 the pointer can be read anywhere on screen, so the
//     island gets it the way the Windows build does, not only over itself.
//   * WhatsApp — WhatsApp Web's notifications, read off the bus as the
//     browser sends them to the desktop (a monitor connection, read-only).
//   * Spotify — the MPRIS player it publishes: what is playing, and
//     play/pause/next/previous. Signal-driven, so nothing runs while the song
//     does not change; the island moves the progress bar itself.
//
// Each one reports to the island as an ordinary `integration` event, so the
// pills, cards and badges work exactly like the network integrations.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use gtk::gio;
use gtk::glib::{ToVariant, Variant};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::integrations::{emit, IntegrationUpdate};
use crate::island::{self, CursorPayload, PollGate};
use crate::log;

pub const SPOTIFY_ID: &str = "integration_spotify";
const SPOTIFY_BUS: &str = "org.mpris.MediaPlayer2.spotify";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";

static BUS: OnceLock<gio::DBusConnection> = OnceLock::new();

/// Must run on the GTK main thread: signal callbacks fire on its main loop.
pub fn start(app: AppHandle) {
    let bus = match gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) {
        Ok(bus) => bus,
        Err(err) => {
            log::line(format!("desktop: no session bus ({err})"));
            return;
        }
    };
    let _ = BUS.set(bus.clone());

    // Track changes, play/pause, and seeks.
    for member in ["PropertiesChanged", "Seeked"] {
        let app = app.clone();
        let iface = if member == "Seeked" { PLAYER_IFACE } else { "org.freedesktop.DBus.Properties" };
        bus.signal_subscribe(
            Some(SPOTIFY_BUS),
            Some(iface),
            Some(member),
            Some(MPRIS_PATH),
            None,
            gio::DBusSignalFlags::NONE,
            move |_, _, _, _, _, _| refresh_spotify(app.clone()),
        );
    }
    // Spotify opening or quitting.
    let on_owner = app.clone();
    bus.signal_subscribe(
        Some("org.freedesktop.DBus"),
        Some("org.freedesktop.DBus"),
        Some("NameOwnerChanged"),
        Some("/org/freedesktop/DBus"),
        Some(SPOTIFY_BUS),
        gio::DBusSignalFlags::NONE,
        move |_, _, _, _, _, _| refresh_spotify(on_owner.clone()),
    );

    refresh_spotify(app.clone());

    start_notification_watch(app.clone());

    if let Some(shared) = app.try_state::<crate::Shared>() {
        spawn_eye_poll(app.clone(), shared.gate.clone());
    }
}

// ── WhatsApp (desktop notifications) ──────────────────────────────────────────

pub const WHATSAPP_ID: &str = "integration_whatsapp";
const WHATSAPP_KEEP: usize = 20;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub from: String,
    pub text: String,
    pub at: u64,
}

static WHATSAPP: Mutex<VecDeque<ChatMessage>> = Mutex::new(VecDeque::new());
/// Last (from, text, at) seen: the same notification can cross the bus twice
/// (a proxy forwarding it to the shell), and must count once.
static LAST_SEEN: Mutex<Option<(String, String, u64)>> = Mutex::new(None);

/// A second connection to the session bus that only watches: it turns into a
/// monitor for `Notify` calls and never sends anything else. Any app on the
/// session may do this; the bus delivers copies, nothing is intercepted.
fn start_notification_watch(app: AppHandle) {
    let address = match gio::dbus_address_get_for_bus_sync(gio::BusType::Session, gio::Cancellable::NONE) {
        Ok(a) => a,
        Err(err) => return log::line(format!("whatsapp: no bus address ({err})")),
    };
    let conn = match gio::DBusConnection::for_address_sync(
        &address,
        gio::DBusConnectionFlags::AUTHENTICATION_CLIENT | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION,
        None,
        gio::Cancellable::NONE,
    ) {
        Ok(c) => c,
        Err(err) => return log::line(format!("whatsapp: could not connect ({err})")),
    };

    conn.add_filter(move |_, msg, incoming| {
        if incoming
            && msg.message_type() == gio::DBusMessageType::MethodCall
            && msg.member().as_deref() == Some("Notify")
        {
            if let Some(body) = msg.body() {
                on_notify(&app, &body);
            }
            // Swallowed: GDBus would otherwise answer the copied call with an
            // error, and a monitor must never send anything.
            return None;
        }
        // Everything else (our own BecomeMonitor reply first of all) goes on.
        Some(msg.clone())
    });

    let rules = vec![
        "type='method_call',interface='org.freedesktop.Notifications',member='Notify'".to_string(),
    ];
    match conn.call_sync(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus.Monitoring",
        "BecomeMonitor",
        Some(&(rules, 0u32).to_variant()),
        None,
        gio::DBusCallFlags::NONE,
        2_000,
        gio::Cancellable::NONE,
    ) {
        Ok(_) => log::line("whatsapp: watching desktop notifications"),
        Err(err) => log::line(format!("whatsapp: monitor refused ({err})")),
    }
    // The connection lives as long as the app.
    std::mem::forget(conn);
}

/// `Notify(app_name s, replaces_id u, icon s, summary s, body s, actions as, hints a{sv}, timeout i)`
fn on_notify(app: &AppHandle, body: &Variant) {
    if body.n_children() < 7 {
        return;
    }
    let s = |i: usize| body.child_value(i).str().unwrap_or_default().to_string();
    let (app_name, summary, text) = (s(0), s(3), s(4));
    let mut desktop_entry = String::new();
    for_each_entry(&body.child_value(6), |key, value| {
        if key == "desktop-entry" {
            desktop_entry = value.str().unwrap_or_default().to_string();
        }
    });
    crate::log::line(format!(
        "notify app={app_name:?} entry={desktop_entry:?} summary={summary:?} body_len={}",
        text.len()
    ));
    let Some((from, text)) = whatsapp_message(&app_name, &desktop_entry, &summary, &text) else { return };

    let at = now_ms();
    {
        let mut last = LAST_SEEN.lock().unwrap();
        if let Some((f, t, when)) = last.as_ref() {
            if *f == from && *t == text && at.saturating_sub(*when) < 2_000 {
                return;
            }
        }
        *last = Some((from.clone(), text.clone(), at));
    }

    let message = ChatMessage { from, text, at };
    let messages: Vec<ChatMessage> = {
        let mut list = WHATSAPP.lock().unwrap();
        list.push_front(message.clone());
        list.truncate(WHATSAPP_KEEP);
        list.iter().cloned().collect()
    };
    emit(app, IntegrationUpdate {
        id: WHATSAPP_ID,
        data: json!({ "messages": messages }),
        error: None,
        event: None,
    });
    let _ = app.emit_to(island::WINDOW_LABEL, "whatsapp", message);
}

/// Picks WhatsApp Web's notifications out of everything the browser sends.
/// Returns (sender, text).
fn whatsapp_message(app_name: &str, entry: &str, summary: &str, body: &str) -> Option<(String, String)> {
    let from_browser = ["firefox", "chrome", "chromium", "brave"]
        .iter()
        .any(|b| app_name.to_lowercase().contains(b) || entry.to_lowercase().contains(b));
    let whatsapp_app = app_name.to_lowercase().contains("whatsapp") || entry.to_lowercase().contains("whatsapp");
    if !(from_browser || whatsapp_app) {
        return None;
    }
    // Firefox puts the site on the body's first line ("web.whatsapp.com").
    let mut lines = body.lines();
    let first = lines.clone().next().unwrap_or_default().trim().to_lowercase();
    let text = if first.contains("whatsapp.com") {
        lines.next();
        lines.collect::<Vec<_>>().join("\n")
    } else if whatsapp_app {
        body.to_string()
    } else {
        return None;
    };
    let from = summary.trim();
    if from.is_empty() {
        return None;
    }
    Some((from.to_string(), strip_markup(text.trim())))
}

/// The spec allows a little HTML in bodies; the island shows plain text.
fn strip_markup(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
}

// ── Eyes (X11) ────────────────────────────────────────────────────────────────

mod x11 {
    use std::os::raw::{c_char, c_int, c_uint, c_ulong, c_void};

    #[link(name = "X11")]
    extern "C" {
        pub fn XOpenDisplay(name: *const c_char) -> *mut c_void;
        pub fn XDefaultRootWindow(display: *mut c_void) -> c_ulong;
        pub fn XQueryPointer(
            display: *mut c_void,
            window: c_ulong,
            root: *mut c_ulong,
            child: *mut c_ulong,
            root_x: *mut c_int,
            root_y: *mut c_int,
            win_x: *mut c_int,
            win_y: *mut c_int,
            mask: *mut c_uint,
        ) -> c_int;
    }
}

/// Reads the pointer ~30 times a second while the island is on screen and
/// sends it as the same `cursor` event the Windows poll sends. Parked, like
/// that poll, while the island is hidden. Wayland has no global pointer, so
/// there the page's own mouse events stay the only source.
fn spawn_eye_poll(app: AppHandle, gate: Arc<PollGate>) {
    let x11_session = std::env::var("XDG_SESSION_TYPE").map(|v| v == "x11").unwrap_or(false)
        || (std::env::var_os("WAYLAND_DISPLAY").is_none() && std::env::var_os("DISPLAY").is_some());
    if !x11_session {
        return;
    }
    std::thread::spawn(move || {
        // Our own connection: Xlib displays are not shared across threads.
        let display = unsafe { x11::XOpenDisplay(std::ptr::null()) };
        if display.is_null() {
            log::line("eyes: could not open the X display");
            return;
        }
        let root = unsafe { x11::XDefaultRootWindow(display) };
        log::line("eyes follow the pointer across the screen (X11)");
        let mut last = (i32::MIN, i32::MIN);
        loop {
            gate.wait_until_active();
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(33));
                let (mut r, mut c, mut rx, mut ry, mut wx, mut wy, mut mask) = (0, 0, 0, 0, 0, 0, 0);
                let ok = unsafe {
                    x11::XQueryPointer(display, root, &mut r, &mut c, &mut rx, &mut ry, &mut wx, &mut wy, &mut mask)
                };
                if ok == 0 || (rx, ry) == last {
                    continue;
                }
                last = (rx, ry);
                let Some(win) = island::window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let x = (rx as f64 - origin.x as f64) / scale;
                let y = (ry as f64 - origin.y as f64) / scale;
                let _ = win.emit("cursor", CursorPayload { x, y });
            }
        }
    });
}

/// Reads the player off the main thread and pushes it to the island.
fn refresh_spotify(app: AppHandle) {
    std::thread::spawn(move || {
        let data = spotify_state().unwrap_or_else(|| json!({ "running": false }));
        emit(&app, IntegrationUpdate { id: SPOTIFY_ID, data, error: None, event: None });
    });
}

fn spotify_state() -> Option<Value> {
    let bus = BUS.get()?;
    let reply = bus
        .call_sync(
            Some(SPOTIFY_BUS),
            MPRIS_PATH,
            "org.freedesktop.DBus.Properties",
            "GetAll",
            Some(&(PLAYER_IFACE,).to_variant()),
            None,
            gio::DBusCallFlags::NONE,
            1_000,
            gio::Cancellable::NONE,
        )
        .ok()?;
    let props = reply.child_value(0);

    let mut status = String::new();
    let mut position_us: i64 = 0;
    let mut meta: Option<Variant> = None;
    for_each_entry(&props, |key, value| match key {
        "PlaybackStatus" => status = value.str().unwrap_or_default().to_string(),
        "Position" => position_us = as_i64(&value),
        "Metadata" => meta = Some(value),
        _ => {}
    });

    let (mut title, mut artist, mut album, mut art, mut length_us) =
        (String::new(), String::new(), String::new(), String::new(), 0i64);
    if let Some(meta) = meta {
        for_each_entry(&meta, |key, value| match key {
            "xesam:title" => title = value.str().unwrap_or_default().to_string(),
            "xesam:album" => album = value.str().unwrap_or_default().to_string(),
            "mpris:artUrl" => art = value.str().unwrap_or_default().to_string(),
            "mpris:length" => length_us = as_i64(&value),
            "xesam:artist" => {
                artist = value.get::<Vec<String>>().unwrap_or_default().join(", ");
            }
            _ => {}
        });
    }
    // Spotify still hands out the old open.spotify.com form now and then.
    if let Some(rest) = art.strip_prefix("https://open.spotify.com/image/") {
        art = format!("https://i.scdn.co/image/{rest}");
    }

    Some(json!({
        "running": true,
        "playing": status == "Playing",
        "title": title,
        "artist": artist,
        "album": album,
        "art": art,
        "lengthMs": length_us / 1000,
        "positionMs": position_us / 1000,
        "at": now_ms(),
    }))
}

/// Play/pause, next or previous, from the card's buttons.
pub fn spotify_control(action: &str) {
    let method = match action {
        "toggle" => "PlayPause",
        "next" => "Next",
        "previous" => "Previous",
        _ => return,
    };
    let Some(bus) = BUS.get() else { return };
    if let Err(err) = bus.call_sync(
        Some(SPOTIFY_BUS),
        MPRIS_PATH,
        PLAYER_IFACE,
        method,
        None,
        None,
        gio::DBusCallFlags::NONE,
        1_000,
        gio::Cancellable::NONE,
    ) {
        log::line(format!("spotify {method}: {err}"));
    }
}

// ── Variant helpers ───────────────────────────────────────────────────────────

/// Walks an `a{sv}` dictionary, unboxing each value.
fn for_each_entry(dict: &Variant, mut f: impl FnMut(&str, Variant)) {
    for i in 0..dict.n_children() {
        let entry = dict.child_value(i);
        let key = entry.child_value(0);
        let Some(key) = key.str() else { continue };
        let value = entry.child_value(1);
        let value = value.as_variant().unwrap_or(value);
        f(key, value);
    }
}

/// MPRIS says `x`, Spotify sends `t` for the length: take either.
fn as_i64(v: &Variant) -> i64 {
    v.get::<i64>()
        .or_else(|| v.get::<u64>().map(|n| n as i64))
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
