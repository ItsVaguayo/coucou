// Linux desktop bridges over the session D-Bus, through the gio that GTK
// already brings in (no extra dependency):
//   * Mochi's eyes — on X11 the pointer can be read anywhere on screen, so the
//     island gets it the way the Windows build does, not only over itself.
//   * Spotify — the MPRIS player it publishes: what is playing, and
//     play/pause/next/previous. Signal-driven, so nothing runs while the song
//     does not change; the island moves the progress bar itself.
//
// Each one reports to the island as an ordinary `integration` event, so the
// pills, cards and badges work exactly like the network integrations.

use std::sync::{Arc, OnceLock};
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

    if let Some(shared) = app.try_state::<crate::Shared>() {
        spawn_eye_poll(app.clone(), shared.gate.clone());
    }
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
