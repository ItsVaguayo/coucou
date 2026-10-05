// Coucou for Windows — app wiring and the commands the island calls.

mod claude;
#[cfg(target_os = "linux")]
mod desktop;
#[cfg(target_os = "linux")]
mod discord;
mod files;
mod hooks;
mod integrations;
mod island;
mod log;
mod pipe;
mod platform;
mod secrets;
mod settings;
mod transcript;
mod tray;
mod usage;

use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use claude::{Chat, ChatContext, ChatReply};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    settings.hooks_installed = hooks::status().installed;
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed =
            current.screen != settings.screen || current.island_offset != settings.island_offset;
        let autostart_changed = current.autostart != settings.autostart;
        #[cfg(target_os = "linux")]
        if current.discord_mute_key != settings.discord_mute_key {
            discord::set_mute_key(&settings.discord_mute_key);
        }
        *current = settings.clone();
        (screen_changed, autostart_changed)
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[coucou] could not save settings: {err}");
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[coucou] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings, collapsed);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let current = shared.settings.lock().unwrap().clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &current, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let current = shared.settings.lock().unwrap().clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &current, collapsed);
}

/// Live while the island is dragged sideways: moves the window without saving.
/// Returns the offset actually applied (kept on the display). The page saves
/// the settings once the drag ends.
#[tauri::command]
fn move_island(app: AppHandle, shared: State<Shared>, offset: f64) -> f64 {
    let current = {
        let mut s = shared.settings.lock().unwrap();
        s.island_offset = offset;
        s.clone()
    };
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    let used = island::slide(&app, &current, collapsed);
    shared.settings.lock().unwrap().island_offset = used;
    used
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to the file manager otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        platform::reveal_folder(p);
    }
    false
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        let _ = settings::save(&current);
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    pipe::answer(&app, &request_id, &decision);
}

/// Answers an AskUserQuestion: `answers` maps each question's text to the label
/// picked (several joined with commas).
#[tauri::command]
fn approval_answer(app: AppHandle, request_id: String, answers: serde_json::Value) {
    pipe::answer_question(&app, &request_id, &answers);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn. The API key and any file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let model = shared.settings.lock().unwrap().model.clone();
    claude::send(&chat, &model, query, context).await
}

#[tauri::command]
fn chat_reset(chat: State<Chat>) {
    chat.reset();
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// The island may only ask whether a key exists — never read it.
// Async + spawn_blocking: a sync command runs on the main thread, and a keyring
// call (D-Bus, possibly a locked keyring) froze the island while it waited.
#[tauri::command]
async fn secret_present(key: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || secrets::present(&key))
        .await
        .unwrap_or(false)
}

#[tauri::command]
async fn secret_set(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || secrets::set(&key, &value))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn secret_clear(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || secrets::clear(&key))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// Spotify buttons in its card: "toggle", "next" or "previous".
#[tauri::command]
fn media_control(action: String) {
    #[cfg(target_os = "linux")]
    desktop::spotify_control(&action);
    #[cfg(not(target_os = "linux"))]
    let _ = action;
}

/// Discord card buttons and the toast: "mute", "deaf", "leave" or "open".
#[tauri::command]
fn discord_control(action: String) -> bool {
    #[cfg(target_os = "linux")]
    {
        if action == "open" {
            desktop::open_discord();
            return true;
        }
        discord::control(&action)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = action;
        false
    }
}

/// Settings → Connect: Discord shows its own "Authorize?" prompt.
#[tauri::command]
fn discord_connect() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return discord::authorize();
    #[cfg(not(target_os = "linux"))]
    Err("Discord is only wired on Linux for now.".into())
}

/// Clicking a WhatsApp message on the island.
#[tauri::command]
fn open_whatsapp() {
    #[cfg(target_os = "linux")]
    desktop::open_whatsapp();
    #[cfg(not(target_os = "linux"))]
    platform::open_url("https://web.whatsapp.com");
}

/// Lets the island write to the same log as the Rust side.
/// Model, context size and last reply of a Claude Code session (detail view).
#[tauri::command]
async fn session_transcript_tail(path: String) -> Result<transcript::TranscriptTail, String> {
    tauri::async_runtime::spawn_blocking(move || transcript::tail(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// Double-click on a session's Mochi: bring its terminal window forward.
#[tauri::command]
async fn focus_session(
    claude_pid: Option<u32>,
    transcript_path: Option<String>,
    cwd: Option<String>,
) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let title = transcript_path.and_then(|p| transcript::tail(&p).ok()).and_then(|t| t.title);
        #[cfg(target_os = "linux")]
        {
            let folder = cwd.as_deref().map(|c| c.rsplit('/').next().unwrap_or(c).to_string());
            desktop::focus_session(claude_pid, title.as_deref(), folder.as_deref())
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (claude_pid, title, cwd);
            false
        }
    })
    .await
    .unwrap_or(false)
}

/// Tokens and estimated cost of every Claude Code session since `since_ms`.
#[tauri::command]
async fn usage_today(since_ms: i64) -> usage::UsageToday {
    tauri::async_runtime::spawn_blocking(move || usage::today(since_ms))
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title("Settings — Coucou")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    // Only WebView2 needs it built up front; elsewhere it is built on first use
    // so launching doesn't pay for a second webview nobody may open.
    #[cfg(not(windows))]
    if app.get_webview_window("settings").is_none() {
        create_settings_window(app);
    }
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

pub fn run() {
    platform::prepare_environment();
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            move_island,
            focus_window,
            reposition,
            open_url,
            open_in_vscode,
            quit_app,
            hooks_status,
            hooks_preview,
            hooks_apply,
            approval_decision,
            approval_answer,
            approval_ack,
            approval_decline,
            log_line,
            session_transcript_tail,
            focus_session,
            usage_today,
            chat_send,
            chat_reset,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_settings_window,
            set_paused,
            media_control,
            open_whatsapp,
            discord_control,
            discord_connect,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window. Windows only: on
            // Linux it is a second WebKit process and page load at every launch.
            #[cfg(windows)]
            create_settings_window(&handle);

            if let Some(win) = island::window(&handle) {
                platform::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Coucou {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            #[cfg(target_os = "linux")]
            {
                desktop::start(handle.clone());
                discord::start(handle.clone());
                let key = handle.state::<Shared>().settings.lock().unwrap().discord_mute_key.clone();
                discord::start_mute_key(&key);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Coucou");
}
