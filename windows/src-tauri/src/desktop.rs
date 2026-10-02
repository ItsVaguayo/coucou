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
use gtk::glib::{self, ToVariant, Variant};
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
    /// The picture the site attached (WhatsApp: the contact's photo), as a
    /// data: URL, or empty.
    pub image: String,
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
    let mut image: Option<Variant> = None;
    for_each_entry(&body.child_value(6), |key, value| match key {
        "desktop-entry" => desktop_entry = value.str().unwrap_or_default().to_string(),
        "image-data" | "image_data" | "icon_data" => image = Some(value),
        _ => {}
    });
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

    let image = image.as_ref().and_then(image_data_url).unwrap_or_default();
    let message = ChatMessage { from, text, at, image };
    let messages: Vec<ChatMessage> = {
        let mut list = WHATSAPP.lock().unwrap();
        list.push_front(message.clone());
        list.truncate(WHATSAPP_KEEP);
        // Pictures only for the rows the card shows.
        for old in list.iter_mut().skip(3) {
            old.image.clear();
        }
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

/// Web notifications from the browser (or a WhatsApp desktop app). Firefox
/// does not say which site sent one, so every site allowed to notify comes
/// through; WhatsApp Web is the one that matters here, and it is told apart by
/// what it sends: the contact as the title, the message as the body and the
/// contact's photo as the picture. Returns (sender, text).
fn whatsapp_message(app_name: &str, entry: &str, summary: &str, body: &str) -> Option<(String, String)> {
    let app = app_name.to_lowercase();
    let entry = entry.to_lowercase();
    let from_browser = ["firefox", "chrome", "chromium", "brave"]
        .iter()
        .any(|b| app.contains(b) || entry.contains(b));
    let whatsapp_app = app.contains("whatsapp") || entry.contains("whatsapp") || app.contains("wasistlos");
    if !(from_browser || whatsapp_app) {
        return None;
    }
    // Chrome puts the site on the body's first line; drop it.
    let mut lines = body.lines().peekable();
    if lines.peek().map(|l| l.trim().to_lowercase().ends_with(".com")).unwrap_or(false) {
        lines.next();
    }
    let text = lines.collect::<Vec<_>>().join("\n");
    let from = summary.trim();
    if from.is_empty() {
        return None;
    }
    Some((from.to_string(), strip_markup(text.trim())))
}

/// `image-data` is `(iiibiiay)`: width, height, rowstride, has_alpha,
/// bits_per_sample, channels, pixels (RGB or RGBA). Wrapped as a 32-bit BMP,
/// which the webview shows without any image library on our side.
fn image_data_url(v: &Variant) -> Option<String> {
    if v.n_children() < 7 {
        return None;
    }
    let w = v.child_value(0).get::<i32>()? as usize;
    let h = v.child_value(1).get::<i32>()? as usize;
    let stride = v.child_value(2).get::<i32>()? as usize;
    let bits = v.child_value(4).get::<i32>()?;
    let channels = v.child_value(5).get::<i32>()? as usize;
    let pixels = v.child_value(6).fixed_array::<u8>().ok()?.to_vec();
    if w == 0 || h == 0 || w > 512 || h > 512 || bits != 8 || !(channels == 3 || channels == 4) {
        return None;
    }
    if pixels.len() < stride * (h - 1) + w * channels {
        return None;
    }
    // The island draws it at 22 px: 48 is plenty, and keeps the event small.
    let step = w.max(h).div_ceil(48).max(1);
    let (src_w, src_h) = (w, h);
    let (w, h) = (src_w.div_ceil(step), src_h.div_ceil(step));
    let data_len = w * h * 4;
    let mut bmp = Vec::with_capacity(54 + 68 + data_len);
    let header_len: u32 = 14 + 108; // BITMAPV4HEADER, for the alpha mask
    let file_len = header_len as usize + data_len;
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&(file_len as u32).to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&header_len.to_le_bytes());
    bmp.extend_from_slice(&108u32.to_le_bytes());
    bmp.extend_from_slice(&(w as i32).to_le_bytes());
    bmp.extend_from_slice(&(-(h as i32)).to_le_bytes()); // top-down rows
    bmp.extend_from_slice(&1u16.to_le_bytes());
    bmp.extend_from_slice(&32u16.to_le_bytes());
    bmp.extend_from_slice(&3u32.to_le_bytes()); // BI_BITFIELDS
    bmp.extend_from_slice(&(data_len as u32).to_le_bytes());
    bmp.extend_from_slice(&[0u8; 16]); // resolution, palette
    for mask in [0x00ff_0000u32, 0x0000_ff00, 0x0000_00ff, 0xff00_0000] {
        bmp.extend_from_slice(&mask.to_le_bytes());
    }
    bmp.extend_from_slice(b" niW"); // LCS_WINDOWS_COLOR_SPACE
    bmp.extend_from_slice(&[0u8; 48]); // endpoints + gamma
    for y in 0..h {
        let row = &pixels[(y * step).min(src_h - 1) * stride..];
        for x in 0..w {
            let p = &row[(x * step).min(src_w - 1) * channels..];
            let a = if channels == 4 { p[3] } else { 255 };
            bmp.extend_from_slice(&[p[2], p[1], p[0], a]);
        }
    }
    Some(format!("data:image/bmp;base64,{}", glib::base64_encode(&bmp)))
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

/// The focused window's class over XCB, which reports X errors as values: a
/// window closing between two requests must not reach the process-wide Xlib
/// error handler that GDK owns.
mod xcb {
    use std::os::raw::{c_char, c_int, c_void};

    #[repr(C)]
    pub struct Cookie {
        pub sequence: u32,
    }
    #[repr(C)]
    pub struct AtomReply {
        pub response_type: u8,
        pub pad0: u8,
        pub sequence: u16,
        pub length: u32,
        pub atom: u32,
    }

    #[link(name = "xcb")]
    extern "C" {
        pub fn xcb_connect(name: *const c_char, screen: *mut c_int) -> *mut c_void;
        pub fn xcb_connection_has_error(c: *mut c_void) -> c_int;
        pub fn xcb_intern_atom(c: *mut c_void, only_if_exists: u8, len: u16, name: *const c_char) -> Cookie;
        pub fn xcb_intern_atom_reply(c: *mut c_void, cookie: Cookie, err: *mut *mut c_void) -> *mut AtomReply;
        pub fn xcb_get_property(
            c: *mut c_void, delete: u8, window: u32, property: u32, type_: u32, offset: u32, length: u32,
        ) -> Cookie;
        pub fn xcb_get_property_reply(c: *mut c_void, cookie: Cookie, err: *mut *mut c_void) -> *mut c_void;
        pub fn xcb_get_property_value(reply: *const c_void) -> *const c_void;
        pub fn xcb_get_property_value_length(reply: *const c_void) -> c_int;
    }

    pub const ATOM_WINDOW: u32 = 33;
    pub const ATOM_STRING: u32 = 31;
    pub const ATOM_WM_CLASS: u32 = 67;

    pub struct Conn {
        c: *mut c_void,
        active_atom: u32,
    }

    impl Conn {
        pub fn open() -> Option<Conn> {
            unsafe {
                let c = xcb_connect(std::ptr::null(), std::ptr::null_mut());
                if c.is_null() || xcb_connection_has_error(c) != 0 {
                    return None;
                }
                let name = b"_NET_ACTIVE_WINDOW";
                let cookie = xcb_intern_atom(c, 1, name.len() as u16, name.as_ptr() as *const c_char);
                let mut err = std::ptr::null_mut();
                let reply = xcb_intern_atom_reply(c, cookie, &mut err);
                if !err.is_null() {
                    libc::free(err);
                }
                if reply.is_null() {
                    return None;
                }
                let atom = (*reply).atom;
                libc::free(reply as *mut c_void);
                (atom != 0).then_some(Conn { c, active_atom: atom })
            }
        }

        fn property(&self, window: u32, prop: u32, ty: u32, len: u32) -> Option<Vec<u8>> {
            unsafe {
                let cookie = xcb_get_property(self.c, 0, window, prop, ty, 0, len);
                let mut err = std::ptr::null_mut();
                let reply = xcb_get_property_reply(self.c, cookie, &mut err);
                if !err.is_null() {
                    libc::free(err);
                }
                if reply.is_null() {
                    return None;
                }
                let n = xcb_get_property_value_length(reply).max(0) as usize;
                let data = std::slice::from_raw_parts(xcb_get_property_value(reply) as *const u8, n).to_vec();
                libc::free(reply);
                Some(data)
            }
        }

        /// WM_CLASS of the focused window, lowercased ("firefox", "google-chrome"…).
        pub fn active_class(&self, root: u32) -> Option<String> {
            let win = self.property(root, self.active_atom, ATOM_WINDOW, 1)?;
            let win = u32::from_ne_bytes(win.get(..4)?.try_into().ok()?);
            if win == 0 {
                return Some(String::new());
            }
            let class = self.property(win, ATOM_WM_CLASS, ATOM_STRING, 64)?;
            // "instance\0Class\0": both halves are worth matching.
            Some(String::from_utf8_lossy(&class).replace('\0', " ").to_lowercase())
        }
    }
}

/// Is the focused window a web browser?
fn is_browser(class: &str) -> bool {
    ["firefox", "chrome", "chromium", "brave", "vivaldi", "opera", "microsoft-edge"]
        .iter()
        .any(|b| class.contains(b))
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
        let focus = xcb::Conn::open();
        log::line("eyes follow the pointer across the screen (X11)");
        let mut last = (i32::MIN, i32::MIN);
        loop {
            gate.wait_until_active();
            // Re-announced on every wake: the island may have missed changes.
            let mut last_browser: Option<bool> = None;
            let mut ticks: u32 = 0;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(33));

                // Twice a second: is a browser in front? The island fades so the
                // tabs under it show through.
                ticks = ticks.wrapping_add(1);
                if ticks % 15 == 1 {
                    if let Some(class) = focus.as_ref().and_then(|f| f.active_class(root as u32)) {
                        let browser = is_browser(&class);
                        if last_browser != Some(browser) {
                            last_browser = Some(browser);
                            log::line(format!("focus: {class:?} → browser={browser}"));
                            let _ = app.emit_to(island::WINDOW_LABEL, "browser-focus", browser);
                        }
                    }
                }

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
