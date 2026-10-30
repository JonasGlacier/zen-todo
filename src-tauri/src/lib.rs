use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

mod vault;

#[derive(Default)]
struct VaultState { key: Option<vault::Key>, sealed_session: Option<Vec<u8>> }
#[derive(Default)]
struct VaultRuntime(Mutex<VaultState>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatus { encrypted: bool, locked: bool, lock_on_hide: bool, legacy_temp: bool }

#[derive(Clone, Copy, PartialEq)]
enum UiPhase { Visible, Suspending, Hidden, Restoring }

struct UiState {
    phase: UiPhase,
    ready: bool,
    hide_requested: bool,
    show_requested: bool,
    destroying: HashSet<String>,
    session: Option<serde_json::Value>,
    pinned: bool,
    position: Option<PhysicalPosition<i32>>,
    size: Option<PhysicalSize<u32>>,
}

struct UiRuntime(Mutex<UiState>);

impl Default for UiRuntime {
    fn default() -> Self {
        Self(Mutex::new(UiState {
            phase: UiPhase::Visible, ready: false, hide_requested: false,
            show_requested: false, destroying: HashSet::new(), session: None,
            pinned: true, position: None, size: None,
        }))
    }
}

fn with_ui<R: Runtime, T>(app: &AppHandle<R>, update: impl FnOnce(&mut UiState) -> T) -> Result<T, String> {
    let state = app.state::<UiRuntime>();
    let mut ui = state.inner().0.lock().map_err(|error| error.to_string())?;
    Ok(update(&mut ui))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Todo {
    id: String,
    title: String,
    completed: bool,
    created_at: i64,
    group_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    id: String,
    title: String,
    prerequisite_ids: Vec<String>,
    #[serde(default)]
    collapsed: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Board {
    groups: Vec<Group>,
    todos: Vec<Todo>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TodoList {
    id: String,
    title: String,
    board: Board,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    lists: Vec<TodoList>,
    active_list_id: String,
}

fn data_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("todos.json"))
}

#[tauri::command]
fn load_board<R: Runtime>(app: AppHandle<R>) -> Result<Option<Workspace>, String> {
    let state = app.state::<VaultRuntime>();
    let vault = state.0.lock().map_err(|e| e.to_string())?;
    let path = data_file(&app)?;
    if !path.exists() { return Ok(None); }
    let contents = fs::read(path).map_err(|error| error.to_string())?;
    let contents = if vault::is_encrypted(&contents)? { vault::open(vault.key.as_ref().ok_or("Vault locked")?, &contents)? } else { contents };
    serde_json::from_slice(&contents).map(Some).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_board<R: Runtime>(app: AppHandle<R>, board: Workspace) -> Result<(), String> {
    let state = app.state::<VaultRuntime>();
    let vault = state.0.lock().map_err(|e| e.to_string())?;
    let path = data_file(&app)?;
    let contents = serde_json::to_vec(&board).map_err(|error| error.to_string())?;
    let encrypted = if path.exists() { vault::is_encrypted(&fs::read(&path).map_err(|e| e.to_string())?)? } else { vault.key.is_some() };
    let contents = if encrypted || vault.key.is_some() { vault::seal(vault.key.as_ref().ok_or("Vault locked")?, &contents)? } else { contents };
    vault::atomic_write(&path, &contents)
}

fn lock_on_hide(path: &std::path::Path) -> Result<bool, String> {
    match fs::read(path.with_file_name("vault-settings.json")) {
        Ok(data) => serde_json::from_slice::<bool>(&data).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn vault_status<R: Runtime>(app: AppHandle<R>) -> Result<VaultStatus, String> {
    let state = app.state::<VaultRuntime>();
    let vault = state.0.lock().map_err(|e| e.to_string())?;
    let path = data_file(&app)?;
    let encrypted = if path.exists() { vault::is_encrypted(&fs::read(&path).map_err(|e| e.to_string())?)? } else { false };
    Ok(VaultStatus { encrypted, locked: encrypted && vault.key.is_none(), lock_on_hide: lock_on_hide(&path)?, legacy_temp: path.with_extension("json.tmp").exists() })
}

#[tauri::command]
fn enable_encryption<R: Runtime>(app: AppHandle<R>, password: String) -> Result<(), String> {
    if password.is_empty() { return Err("Password required".into()); }
    let state = app.state::<VaultRuntime>();
    let mut vault = state.0.lock().map_err(|e| e.to_string())?;
    if !with_ui(&app, |ui| ui.phase == UiPhase::Visible && ui.ready)? { return Err("Window is suspending".into()); }
    let path = data_file(&app)?;
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    if vault::is_encrypted(&data)? { return Err("Encryption already enabled".into()); }
    let _: Workspace = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    let key = vault::create(&password)?;
    let encrypted = vault::seal(&key, &data)?;
    let (_, verified) = vault::unlock(&encrypted, &password)?;
    if verified != data { return Err("Encryption verification failed".into()); }
    vault::atomic_write(&path, &encrypted)?;
    vault.key = Some(key);
    with_ui(&app, |ui| ui.session = None)?;
    Ok(())
}

#[tauri::command]
fn unlock_vault<R: Runtime>(app: AppHandle<R>, password: String) -> Result<(), String> {
    let state = app.state::<VaultRuntime>();
    let mut vault = state.0.lock().map_err(|e| e.to_string())?;
    let data = fs::read(data_file(&app)?).map_err(|e| e.to_string())?;
    let (key, plaintext) = vault::unlock(&data, &password)?;
    let _: Workspace = serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;
    vault.key = Some(key);
    Ok(())
}

#[tauri::command]
fn set_lock_on_hide<R: Runtime>(app: AppHandle<R>, value: bool) -> Result<(), String> {
    let path = data_file(&app)?.with_file_name("vault-settings.json");
    vault::atomic_write(&path, &serde_json::to_vec(&value).map_err(|e| e.to_string())?)
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    app.get_webview_window("main").ok_or_else(|| "main window not found".to_string())
}

#[tauri::command]
fn set_always_on_top<R: Runtime>(app: AppHandle<R>, value: bool) -> Result<(), String> {
    main_window(&app)?.set_always_on_top(value).map_err(|error| error.to_string())?;
    with_ui(&app, |ui| ui.pinned = value)
}

#[tauri::command]
fn load_session<R: Runtime>(app: AppHandle<R>) -> Result<Option<serde_json::Value>, String> {
    let state = app.state::<VaultRuntime>();
    let mut vault = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(session) = vault.sealed_session.as_ref() {
        let bytes = vault::open(vault.key.as_ref().ok_or("Vault locked")?, session)?;
        let result = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        vault.sealed_session = None;
        return Ok(Some(result));
    }
    with_ui(&app, |ui| ui.session.clone())
}

#[tauri::command]
async fn hide_window<R: Runtime>(app: AppHandle<R>, session: Option<serde_json::Value>) -> Result<(), String> {
    let path = data_file(&app)?;
    let lock = lock_on_hide(&path)? && path.exists() && vault::is_encrypted(&fs::read(&path).map_err(|e| e.to_string())?)?;
    let main = main_window(&app)?;
    let position = main.outer_position().ok();
    let size = main.inner_size().ok();
    let windows: Vec<_> = ["settings", "main"].iter().filter_map(|label| app.get_webview_window(label)).collect();
    let started = with_ui(&app, |ui| {
        if ui.phase != UiPhase::Visible { return false; }
        ui.phase = UiPhase::Suspending;
        ui.ready = false;
        ui.hide_requested = false;
        ui.destroying = windows.iter().map(|window| window.label().to_string()).collect();
        if !lock && session.is_some() { ui.session = session.clone(); }
        ui.position = position;
        ui.size = size;
        true
    })?;
    if !started { return Ok(()); }
    let mut locked_key = None;
    if lock {
        let result = (|| -> Result<(), String> {
            let state = app.state::<VaultRuntime>();
            let mut vault = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(key) = vault.key.as_ref() {
                let sealed = session.as_ref().map(|s| serde_json::to_vec(s).map_err(|e| e.to_string()).and_then(|v| vault::seal(key, &v))).transpose()?;
                with_ui(&app, |ui| ui.session = None)?;
                vault.sealed_session = sealed;
                locked_key = vault.key.take();
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = with_ui(&app, |ui| { ui.phase = UiPhase::Visible; ui.ready = true; ui.destroying.clear(); ui.show_requested = false; });
            return Err(error);
        }
    }
    // Destroy the settings WebView too; retaining any WebView can keep the
    // shared browser/GPU processes alive. No window handles are cached here.
    for window in windows {
        if let Err(error) = window.destroy() {
            if locked_key.is_some() {
                let state = app.state::<VaultRuntime>();
                if let Ok(mut vault) = state.0.lock() { vault.key = locked_key.take(); vault.sealed_session = None; };
            }
            let _ = with_ui(&app, |ui| {
                ui.phase = UiPhase::Visible;
                ui.ready = true;
                ui.destroying.clear();
                ui.show_requested = false;
            });
            return Err(error.to_string());
        }
    }
    // A settings window may have finished closing between enumeration and
    // the transition above. Do not wait forever for an already-delivered event.
    let remaining: HashSet<_> = ["settings", "main"].iter()
        .filter(|label| app.get_webview_window(label).is_some())
        .map(|label| label.to_string()).collect();
    let show = with_ui(&app, |ui| {
        if ui.phase != UiPhase::Suspending { return false; }
        ui.destroying.retain(|label| remaining.contains(label));
        if !ui.destroying.is_empty() { return false; }
        ui.phase = UiPhase::Hidden;
        std::mem::take(&mut ui.show_requested)
    })?;
    if show { show_main(&app); }
    Ok(())
}

#[tauri::command]
fn start_dragging(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

async fn restore_main<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let action = with_ui(&app, |ui| match ui.phase {
        UiPhase::Suspending => { ui.show_requested = true; 0 }
        UiPhase::Restoring => 0,
        UiPhase::Visible => 1,
        UiPhase::Hidden => { ui.phase = UiPhase::Restoring; ui.ready = false; 2 }
    })?;
    if action == 0 { return Ok(()); }
    if action == 1 {
        if let Some(window) = app.get_webview_window("main") {
            window.unminimize().map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
            return window.set_focus().map_err(|error| error.to_string());
        }
        with_ui(&app, |ui| { ui.phase = UiPhase::Restoring; ui.ready = false; })?;
    }
    let result = (|| {
        // A Destroyed callback can precede removal of the old label from the
        // manager. Wait on this worker, never on the native event-loop thread.
        for _ in 0..100 {
            if app.get_webview_window("main").is_none() { break; }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let config = app.config().app.windows.iter().find(|window| window.label == "main")
            .ok_or_else(|| "main window configuration not found".to_string())?;
        let (pinned, position, size) = with_ui(&app, |ui| (ui.pinned, ui.position, ui.size))?;
        let window = WebviewWindowBuilder::from_config(&app, config).map_err(|error| error.to_string())?
            .visible(false).always_on_top(pinned).build().map_err(|error| error.to_string())?;
        if let Some(size) = size { let _ = window.set_size(size); }
        if let Some(position) = position { let _ = window.set_position(position); }
        // main_ready shows the window only after its board and drafts are back.
        Ok(())
    })();
    if result.is_err() {
        let _ = with_ui(&app, |ui| ui.phase = UiPhase::Hidden);
    }
    result
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = restore_main(app).await { eprintln!("Unable to restore main window: {error}"); }
    });
}

#[tauri::command]
fn main_ready<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let action = with_ui(&app, |ui| {
        if ui.phase == UiPhase::Suspending || ui.phase == UiPhase::Hidden { return 0; }
        ui.phase = UiPhase::Visible;
        ui.ready = true;
        if std::mem::take(&mut ui.hide_requested) { 2 } else { 1 }
    })?;
    if action == 0 { return Ok(()); }
    let window = main_window(&app)?;
    if action == 2 { window.emit("tray-hide-requested", ()).map_err(|error| error.to_string()) }
    else {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())
    }
}

#[tauri::command]
async fn open_settings<R: Runtime>(app: AppHandle<R>, language: String) -> Result<(), String> {
    if !with_ui(&app, |ui| ui.phase == UiPhase::Visible && ui.ready)? {
        return Err("Main window is suspending".to_string());
    }
    if let Some(window) = app.get_webview_window("settings") {
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    let title = if language == "en" { "Settings · Zen Todo" } else { "设置 · Zen Todo" };
    let window = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("index.html?view=settings".into()))
        .title(title)
        .inner_size(640.0, 480.0)
        .min_inner_size(480.0, 360.0)
        .resizable(true)
        .decorations(true)
        .center()
        .parent(&main_window(&app)?).map_err(|error| error.to_string())?
        .build().map_err(|error| error.to_string())?;
    if !with_ui(&app, |ui| ui.phase == UiPhase::Visible)? {
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn close_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn tray_menu<R: Runtime>(app: &AppHandle<R>, language: &str) -> Result<tauri::menu::Menu<R>, String> {
    let english = language == "en";
    tauri::menu::MenuBuilder::new(app)
        .text("show", if english { "Show Zen Todo" } else { "显示 Zen Todo" })
        .separator()
        .text("quit", if english { "Quit" } else { "退出" })
        .build()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_language<R: Runtime>(app: AppHandle<R>, language: String) -> Result<(), String> {
    if language != "zh-CN" && language != "en" {
        return Err("Unsupported language".to_string());
    }
    let tray = app.tray_by_id("main-tray").ok_or_else(|| "tray not found".to_string())?;
    tray.set_menu(Some(tray_menu(&app, &language)?)).map_err(|error| error.to_string())?;
    if let Some(window) = app.get_webview_window("settings") {
        window.set_title(if language == "en" { "Settings · Zen Todo" } else { "设置 · Zen Todo" })
            .map_err(|error| error.to_string())?;
    }
    app.emit("settings-changed", &language).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(UiRuntime::default())
        .manage(VaultRuntime::default())
        .setup(|app| {
            let menu = tray_menu(app.handle(), "zh-CN").map_err(std::io::Error::other)?;
            let tray_icon = tauri::image::Image::from_app_icon_resource(32)?;
            tauri::tray::TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .menu(&menu)
                .tooltip("Zen Todo")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                    api.prevent_close();
                    let emit = with_ui(window.app_handle(), |ui| {
                        if ui.phase == UiPhase::Suspending || ui.phase == UiPhase::Hidden { return false; }
                        if ui.ready { true } else { ui.hide_requested = true; false }
                    }).unwrap_or(false);
                    if emit { let _ = window.emit("tray-hide-requested", ()); }
                }
                WindowEvent::Destroyed => {
                    let show = with_ui(window.app_handle(), |ui| {
                        ui.destroying.remove(window.label());
                        if ui.phase == UiPhase::Suspending && ui.destroying.is_empty() {
                            ui.phase = UiPhase::Hidden;
                            return std::mem::take(&mut ui.show_requested);
                        }
                        if window.label() == "main" && ui.phase != UiPhase::Suspending {
                            ui.phase = UiPhase::Hidden;
                            ui.ready = false;
                        }
                        false
                    }).unwrap_or(false);
                    if show { show_main(window.app_handle()); }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![load_board, save_board, load_session, vault_status, enable_encryption, unlock_vault, set_lock_on_hide, main_ready, set_always_on_top, hide_window, start_dragging, set_language, open_settings, close_settings])
        .build(tauri::generate_context!())
        .expect("error while building Zen Todo")
        .run(|_, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                // No windows is the normal tray-only state. Explicit Quit
                // still exits because app.exit(0) supplies an exit code.
                if code.is_none() { api.prevent_exit(); }
            }
        });
}
