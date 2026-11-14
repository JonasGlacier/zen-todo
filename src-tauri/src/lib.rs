use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::PathBuf,
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::{RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

mod agent;
mod ai;
pub mod app_functions;
mod history;
mod causal;
pub mod sync_lan;
pub mod sync_merge;
mod vault;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod cli;

#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod cli {
    use tauri::{AppHandle, Runtime};

    #[derive(Default)]
    pub struct CliRuntime;

    #[tauri::command]
    pub fn execute_cli_request<R: Runtime>(
        _app: AppHandle<R>,
        _id: String,
        _reject: bool,
    ) -> Result<serde_json::Value, String> {
        Err("CLI is only available on desktop".into())
    }

    #[tauri::command]
    pub fn copy_agent_prompt(_language: String) -> Result<(), String> {
        Err("CLI is only available on desktop".into())
    }
}

#[derive(Default)]
struct VaultState {
    key: Option<vault::Key>,
    sealed_session: Option<Vec<u8>>,
}
#[derive(Default)]
struct VaultRuntime(Mutex<VaultState>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatus {
    encrypted: bool,
    locked: bool,
    lock_on_hide: bool,
    legacy_temp: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum UiPhase {
    Visible,
    #[allow(dead_code)]
    Suspending,
    #[allow(dead_code)]
    Hidden,
    #[allow(dead_code)]
    Restoring,
    #[allow(dead_code)]
    AgentEditing,
}

struct UiState {
    phase: UiPhase,
    ready: bool,
    #[allow(dead_code)]
    hide_requested: bool,
    #[allow(dead_code)]
    show_requested: bool,
    #[allow(dead_code)]
    destroying: HashSet<String>,
    session: Option<serde_json::Value>,
    pinned: bool,
    #[allow(dead_code)]
    position: Option<PhysicalPosition<i32>>,
    #[allow(dead_code)]
    size: Option<PhysicalSize<u32>>,
}

struct UiRuntime(Mutex<UiState>);

impl Default for UiRuntime {
    fn default() -> Self {
        Self(Mutex::new(UiState {
            phase: UiPhase::Visible,
            ready: cfg!(any(target_os = "android", target_os = "ios")),
            hide_requested: false,
            show_requested: false,
            destroying: HashSet::new(),
            session: None,
            pinned: true,
            position: None,
            size: None,
        }))
    }
}

fn with_ui<R: Runtime, T>(app: &AppHandle<R>, update: impl FnOnce(&mut UiState) -> T) -> Result<T, String> {
    let state = app.state::<UiRuntime>();
    let mut ui = state.inner().0.lock().map_err(|error| error.to_string())?;
    Ok(update(&mut ui))
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub title: String,
    pub completed: bool,
    pub created_at: i64,
    #[serde(default, alias = "nextId")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub order: i64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Board {
    pub todos: Vec<Todo>,
}

impl Board {
    fn reconcile(&mut self) {
        loop {
            let updates: Vec<_> = self
                .todos
                .iter()
                .filter_map(|todo| {
                    let children: Vec<_> = self
                        .todos
                        .iter()
                        .filter(|child| child.parent_id.as_deref() == Some(todo.id.as_str()))
                        .collect();
                    if children.is_empty() {
                        return None;
                    }
                    let completed = children.iter().all(|child| child.completed);
                    (todo.completed != completed).then_some((todo.id.clone(), completed))
                })
                .collect();
            if updates.is_empty() {
                break;
            }
            for (id, completed) in updates {
                self.todos
                    .iter_mut()
                    .find(|todo| todo.id == id)
                    .unwrap()
                    .completed = completed;
            }
        }
    }

    fn normalize(&mut self) {
        let ids: HashSet<_> = self.todos.iter().map(|todo| todo.id.clone()).collect();
        for todo in &mut self.todos {
            if todo
                .parent_id
                .as_ref()
                .is_some_and(|id| id == &todo.id || !ids.contains(id))
            {
                todo.parent_id = None;
            }
        }
        for index in 0..self.todos.len() {
            let mut seen = HashSet::new();
            let mut current = index;
            while let Some(parent_id) = self.todos[current].parent_id.clone() {
                seen.insert(self.todos[current].id.clone());
                if seen.contains(&parent_id) {
                    self.todos[current].parent_id = None;
                    break;
                }
                current = self
                    .todos
                    .iter()
                    .position(|todo| todo.id == parent_id)
                    .unwrap();
            }
        }
        self.reconcile();
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoList {
    pub id: String,
    pub title: String,
    pub board: Board,
    #[serde(default)]
    pub archived: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub order: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    #[serde(default, skip_serializing_if = "causal::State::is_empty")]
    pub causal: causal::State,
    pub lists: Vec<TodoList>,
    pub active_list_id: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub deleted_todos: BTreeMap<String, i64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub deleted_lists: BTreeMap<String, i64>,
}

impl Workspace {
    fn normalize(&mut self) {
        for list in &mut self.lists {
            list.board.normalize();
        }
    }
}

fn data_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("todos.json"))
}

#[tauri::command]
fn get_platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "desktop"
    }
}

#[tauri::command]
fn load_board<R: Runtime>(app: AppHandle<R>) -> Result<Option<Workspace>, String> {
    let state = app.state::<VaultRuntime>();
    let vault = state.0.lock().map_err(|e| e.to_string())?;
    let path = data_file(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read(path).map_err(|error| error.to_string())?;
    let contents = if vault::is_encrypted(&contents)? {
        vault::open(vault.key.as_ref().ok_or("Vault locked")?, &contents)?
    } else {
        contents
    };
    let mut workspace: Workspace = serde_json::from_slice(&contents).map_err(|error| error.to_string())?;
    workspace.normalize();
    causal::initialize(&mut workspace);
    Ok(Some(workspace))
}

#[tauri::command]
fn save_board<R: Runtime>(
    app: AppHandle<R>,
    mut board: Workspace,
    record_history: Option<bool>,
    base: Option<Workspace>,
) -> Result<Workspace, String> {
    let saved = {
        let state = app.state::<VaultRuntime>();
        let vault = state.0.lock().map_err(|e| e.to_string())?;
        let path = data_file(&app)?;
        let existing = if path.exists() {
            Some(fs::read(&path).map_err(|e| e.to_string())?)
        } else {
            None
        };
        let encrypted = match existing.as_ref() {
            Some(data) => vault::is_encrypted(data)?,
            None => vault.key.is_some(),
        };
        let previous: Option<Workspace> = existing
            .as_ref()
            .map(|data| {
                let plaintext = if encrypted {
                    vault::open(vault.key.as_ref().ok_or("Vault locked")?, data)?
                } else {
                    data.clone()
                };
                let mut previous: Workspace =
                    serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;
                previous.normalize();
                Ok::<_, String>(previous)
            })
            .transpose()?;
        board.normalize();
        let empty = Workspace { lists: vec![], active_list_id: String::new(), deleted_lists: Default::default(), deleted_todos: Default::default(), causal: Default::default() };
        let latest = previous.as_ref().unwrap_or(&empty);
        let base = base.as_ref().unwrap_or(&empty);
        board = causal::commit(base, &board, latest, &causal::device_id(&path)?)?;
        let contents = serde_json::to_vec(&board).map_err(|error| error.to_string())?;
        let contents = if encrypted || vault.key.is_some() {
            vault::seal(vault.key.as_ref().ok_or("Vault locked")?, &contents)?
        } else {
            contents
        };
        let runtime = app.state::<history::HistoryRuntime>();
        let mut history = runtime.0.lock().map_err(|e| e.to_string())?;
        if let (Some(bytes), Some(previous)) = (existing.as_ref(), previous.as_ref()) {
            causal::backup_legacy(&path, bytes, previous)?;
        }
        vault::atomic_write(&path, &contents)?;
        if record_history.unwrap_or(false) {
            if let Some(previous) = previous {
                history.record(&previous, &board);
            }
        }
        board
    };
    sync_lan::notify_local_change(&app);
    Ok(saved)
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
    let encrypted = if path.exists() {
        vault::is_encrypted(&fs::read(&path).map_err(|e| e.to_string())?)?
    } else {
        false
    };
    Ok(VaultStatus {
        encrypted,
        locked: encrypted && vault.key.is_none(),
        lock_on_hide: lock_on_hide(&path)?,
        legacy_temp: path.with_extension("json.tmp").exists(),
    })
}

#[tauri::command]
fn enable_encryption<R: Runtime>(app: AppHandle<R>, password: String) -> Result<(), String> {
    if password.is_empty() {
        return Err("Password required".into());
    }
    let state = app.state::<VaultRuntime>();
    let mut vault = state.0.lock().map_err(|e| e.to_string())?;
    if !with_ui(&app, |ui| ui.phase == UiPhase::Visible && ui.ready)? {
        return Err("Window is suspending".into());
    }
    let path = data_file(&app)?;
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    if vault::is_encrypted(&data)? {
        return Err("Encryption already enabled".into());
    }
    let _: Workspace = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    let key = vault::create(&password)?;
    let encrypted = vault::seal(&key, &data)?;
    let (_, verified) = vault::unlock(&encrypted, &password)?;
    if verified != data {
        return Err("Encryption verification failed".into());
    }
    vault::atomic_write(&path, &encrypted)?;
    vault.key = Some(key);
    with_ui(&app, |ui| ui.session = None)?;
    Ok(())
}

#[tauri::command]
fn unlock_vault<R: Runtime>(app: AppHandle<R>, password: String) -> Result<(), String> {
    {
        let state = app.state::<VaultRuntime>();
        let mut vault = state.0.lock().map_err(|e| e.to_string())?;
        let data = fs::read(data_file(&app)?).map_err(|e| e.to_string())?;
        let (key, plaintext) = vault::unlock(&data, &password)?;
        let _: Workspace = serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;
        vault.key = Some(key);
    }
    sync_lan::notify_local_change(&app);
    Ok(())
}

#[tauri::command]
fn change_encryption_password<R: Runtime>(
    app: AppHandle<R>,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    let state = app.state::<VaultRuntime>();
    let mut vault = state.0.lock().map_err(|e| e.to_string())?;
    if vault.key.is_none() {
        return Err("Vault locked".into());
    }
    if !with_ui(&app, |ui| ui.phase == UiPhase::Visible && ui.ready)? {
        return Err("Window is suspending".into());
    }
    let path = data_file(&app)?;
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    let (old_key, new_key, encrypted, plaintext) = vault::rekey(&data, &current_password, &new_password)?;
    let _: Workspace = serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;
    let session = vault
        .sealed_session
        .as_ref()
        .map(|value| vault::open(&old_key, value).and_then(|v| vault::seal(&new_key, &v)))
        .transpose()?;
    vault::atomic_write(&path, &encrypted)?;
    vault.key = Some(new_key);
    vault.sealed_session = session;
    Ok(())
}

#[tauri::command]
fn set_lock_on_hide<R: Runtime>(app: AppHandle<R>, value: bool) -> Result<(), String> {
    let path = data_file(&app)?.with_file_name("vault-settings.json");
    vault::atomic_write(&path, &serde_json::to_vec(&value).map_err(|e| e.to_string())?)
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

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn main_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn set_always_on_top<R: Runtime>(app: AppHandle<R>, value: bool) -> Result<(), String> {
    main_window(&app)?
        .set_always_on_top(value)
        .map_err(|error| error.to_string())?;
    with_ui(&app, |ui| ui.pinned = value)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
fn set_always_on_top<R: Runtime>(app: AppHandle<R>, value: bool) -> Result<(), String> {
    with_ui(&app, |ui| ui.pinned = value)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn hide_window<R: Runtime>(
    app: AppHandle<R>,
    session: Option<serde_json::Value>,
) -> Result<(), String> {
    let path = data_file(&app)?;
    let lock = lock_on_hide(&path)?
        && path.exists()
        && vault::is_encrypted(&fs::read(&path).map_err(|e| e.to_string())?)?;
    let main = main_window(&app)?;
    let position = main.outer_position().ok();
    let size = main.inner_size().ok();
    let windows: Vec<_> = ["settings", "main"]
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .collect();
    let started = with_ui(&app, |ui| {
        if ui.phase != UiPhase::Visible {
            return false;
        }
        ui.phase = UiPhase::Suspending;
        ui.ready = false;
        ui.hide_requested = false;
        ui.destroying = windows.iter().map(|window| window.label().to_string()).collect();
        if !lock && session.is_some() {
            ui.session = session.clone();
        }
        ui.position = position;
        ui.size = size;
        true
    })?;
    if !started {
        return Ok(());
    }
    let mut locked_key = None;
    if lock {
        let result = (|| -> Result<(), String> {
            let state = app.state::<VaultRuntime>();
            let mut vault = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(key) = vault.key.as_ref() {
                let sealed = session
                    .as_ref()
                    .map(|s| {
                        serde_json::to_vec(s)
                            .map_err(|e| e.to_string())
                            .and_then(|v| vault::seal(key, &v))
                    })
                    .transpose()?;
                with_ui(&app, |ui| ui.session = None)?;
                vault.sealed_session = sealed;
                locked_key = vault.key.take();
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = with_ui(&app, |ui| {
                ui.phase = UiPhase::Visible;
                ui.ready = true;
                ui.destroying.clear();
                ui.show_requested = false;
            });
            return Err(error);
        }
    }
    for window in windows {
        if let Err(error) = window.destroy() {
            if locked_key.is_some() {
                let state = app.state::<VaultRuntime>();
                if let Ok(mut vault) = state.0.lock() {
                    vault.key = locked_key.take();
                    vault.sealed_session = None;
                };
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
    let remaining: HashSet<_> = ["settings", "main"]
        .iter()
        .filter(|label| app.get_webview_window(label).is_some())
        .map(|label| label.to_string())
        .collect();
    with_ui(&app, |ui| {
        if ui.phase != UiPhase::Suspending {
            return false;
        }
        ui.destroying.retain(|label| remaining.contains(label));
        true
    })?;
    let show = finish_suspension(&app)?;
    if show {
        show_main(&app);
    }
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
async fn hide_window<R: Runtime>(
    _app: AppHandle<R>,
    _session: Option<serde_json::Value>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn finish_suspension<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let vault = app.state::<VaultRuntime>();
    let _vault = vault.0.lock().map_err(|e| e.to_string())?;
    let runtime = app.state::<history::HistoryRuntime>();
    let mut history = runtime.0.lock().map_err(|e| e.to_string())?;
    with_ui(app, |ui| finish_suspension_state(ui, &mut history))
}

#[allow(dead_code)]
fn finish_suspension_state(ui: &mut UiState, history: &mut history::History) -> bool {
    if ui.phase != UiPhase::Suspending || !ui.destroying.is_empty() {
        return false;
    }
    history.clear();
    ui.phase = UiPhase::Hidden;
    std::mem::take(&mut ui.show_requested)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn start_dragging(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
fn start_dragging() -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn restore_main<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let action = with_ui(&app, |ui| match ui.phase {
        UiPhase::Suspending | UiPhase::AgentEditing => {
            ui.show_requested = true;
            0
        }
        UiPhase::Restoring => 0,
        UiPhase::Visible => 1,
        UiPhase::Hidden => {
            ui.phase = UiPhase::Restoring;
            ui.ready = false;
            2
        }
    })?;
    if action == 0 {
        return Ok(());
    }
    if action == 1 {
        if let Some(window) = app.get_webview_window("main") {
            window.unminimize().map_err(|error| error.to_string())?;
            window.show().map_err(|error| error.to_string())?;
            return window.set_focus().map_err(|error| error.to_string());
        }
        with_ui(&app, |ui| {
            ui.phase = UiPhase::Restoring;
            ui.ready = false;
        })?;
    }
    let result = (|| {
        for _ in 0..100 {
            if app.get_webview_window("main").is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .ok_or_else(|| "main window configuration not found".to_string())?;
        let (pinned, position, size) = with_ui(&app, |ui| (ui.pinned, ui.position, ui.size))?;
        let window = WebviewWindowBuilder::from_config(&app, config)
            .map_err(|error| error.to_string())?
            .visible(false)
            .always_on_top(pinned)
            .build()
            .map_err(|error| error.to_string())?;
        if let Some(size) = size {
            let _ = window.set_size(size);
        }
        if let Some(position) = position {
            let _ = window.set_position(position);
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = with_ui(&app, |ui| ui.phase = UiPhase::Hidden);
    }
    result
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = restore_main(app).await {
            eprintln!("Unable to restore main window: {error}");
        }
    });
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn main_ready<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let action = with_ui(&app, |ui| {
        if ui.phase == UiPhase::Suspending || ui.phase == UiPhase::Hidden {
            return 0;
        }
        ui.phase = UiPhase::Visible;
        ui.ready = true;
        if std::mem::take(&mut ui.hide_requested) {
            2
        } else {
            1
        }
    })?;
    if action == 0 {
        return Ok(());
    }
    let window = main_window(&app)?;
    if action == 2 {
        window
            .emit("tray-hide-requested", ())
            .map_err(|error| error.to_string())
    } else {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
fn main_ready<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    with_ui(&app, |ui| {
        ui.phase = UiPhase::Visible;
        ui.ready = true;
    })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn open_settings<R: Runtime>(app: AppHandle<R>, language: String) -> Result<bool, String> {
    if !with_ui(&app, |ui| ui.phase == UiPhase::Visible && ui.ready)? {
        return Err("Main window is suspending".to_string());
    }
    if let Some(window) = app.get_webview_window("settings") {
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(true);
    }
    let title = if language == "en" {
        "Settings · OneByOne"
    } else {
        "设置 · OneByOne"
    };
    let window = WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App("index.html?view=settings".into()),
    )
    .title(title)
    .inner_size(640.0, 480.0)
    .min_inner_size(480.0, 360.0)
    .resizable(true)
    .decorations(false)
    .center()
    .parent(&main_window(&app)?)
    .map_err(|error| error.to_string())?
    .build()
    .map_err(|error| error.to_string())?;
    if !with_ui(&app, |ui| ui.phase == UiPhase::Visible)? {
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(true)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
async fn open_settings<R: Runtime>(_app: AppHandle<R>, _language: String) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn close_settings<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(true)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
fn close_settings<R: Runtime>(_app: AppHandle<R>) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn tray_menu<R: Runtime>(app: &AppHandle<R>, language: &str) -> Result<tauri::menu::Menu<R>, String> {
    let english = language == "en";
    tauri::menu::MenuBuilder::new(app)
        .text("show", if english { "Show OneByOne" } else { "显示 OneByOne" })
        .separator()
        .text("quit", if english { "Quit" } else { "退出" })
        .build()
        .map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn set_language<R: Runtime>(app: AppHandle<R>, language: String) -> Result<(), String> {
    if language != "zh-CN" && language != "en" {
        return Err("Unsupported language".to_string());
    }
    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "tray not found".to_string())?;
    tray.set_menu(Some(tray_menu(&app, &language)?))
        .map_err(|error| error.to_string())?;
    if let Some(window) = app.get_webview_window("settings") {
        window
            .set_title(if language == "en" {
                "Settings · OneByOne"
            } else {
                "设置 · OneByOne"
            })
            .map_err(|error| error.to_string())?;
    }
    app.emit("settings-changed", &language)
        .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
fn set_language<R: Runtime>(app: AppHandle<R>, language: String) -> Result<(), String> {
    if language != "zh-CN" && language != "en" {
        return Err("Unsupported language".to_string());
    }
    app.emit("settings-changed", &language)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(UiRuntime::default())
        .manage(VaultRuntime::default())
        .manage(history::HistoryRuntime::default())
        .manage(sync_lan::SyncRuntime::default())
        .manage(cli::CliRuntime::default())
        .setup(|app| {
            app_functions::register_app_handle(app.handle().clone());
            sync_lan::start_if_enabled(app.handle().clone());
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                cli::start(app.handle().clone())?;
                let menu = tray_menu(app.handle(), "zh-CN").map_err(std::io::Error::other)?;
                let tray_icon = tauri::image::Image::from_app_icon_resource(32)?;
                tauri::tray::TrayIconBuilder::with_id("main-tray")
                    .icon(tray_icon)
                    .menu(&menu)
                    .tooltip("OneByOne")
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => show_main(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            ..
                        } = event
                        {
                            show_main(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }
            Ok(())
        });

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.on_window_event(|window, event| match event {
        WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
            api.prevent_close();
            let emit = with_ui(window.app_handle(), |ui| {
                if ui.phase == UiPhase::Suspending || ui.phase == UiPhase::Hidden {
                    return false;
                }
                if ui.ready {
                    true
                } else {
                    ui.hide_requested = true;
                    false
                }
            })
            .unwrap_or(false);
            if emit {
                let _ = window.emit("tray-hide-requested", ());
            }
        }
        WindowEvent::Destroyed => {
            let _ = with_ui(window.app_handle(), |ui| {
                ui.destroying.remove(window.label());
                if window.label() == "main" && ui.phase != UiPhase::Suspending {
                    ui.phase = UiPhase::Hidden;
                    ui.ready = false;
                }
            });
            let show = finish_suspension(window.app_handle()).unwrap_or(false);
            if show {
                show_main(window.app_handle());
            }
        }
        _ => {}
    });

    let app = builder
        .invoke_handler(tauri::generate_handler![
            get_platform,
            load_board,
            save_board,
            load_session,
            vault_status,
            enable_encryption,
            unlock_vault,
            change_encryption_password,
            set_lock_on_hide,
            main_ready,
            set_always_on_top,
            hide_window,
            start_dragging,
            set_language,
            open_settings,
            close_settings,
            agent::agent_execute,
            cli::execute_cli_request,
            cli::copy_agent_prompt,
            ai::get_ai_settings,
            ai::has_ai_api_key,
            ai::save_ai_settings,
            ai::run_ai_prompt,
            ai::test_ai_connection,
            sync_lan::get_sync_status,
            sync_lan::set_sync_enabled,
            sync_lan::generate_pairing_code,
            sync_lan::pair_with_peer,
            sync_lan::sync_now,
            sync_lan::remove_paired_peer,
        ])
        .build(tauri::generate_context!())
        .expect("error while building OneByOne");

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    app.run(|_, event| {
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });

    #[cfg(any(target_os = "android", target_os = "ios"))]
    app.run(|_, _| {});
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn tray_transition_clears_history_only_after_all_windows_are_destroyed() {
        let before: Workspace = serde_json::from_value(serde_json::json!({"activeListId":"a","lists":[{"id":"a","title":"Before","board":{"todos":[]}}]})).unwrap();
        let mut after = before.clone();
        after.lists[0].title = "After".into();
        let mut history = history::History::default();
        history.record(&before, &after);
        let mut ui = UiRuntime::default().0.into_inner().unwrap();
        ui.phase = UiPhase::Suspending;
        ui.destroying.insert("main".into());
        assert!(!finish_suspension_state(&mut ui, &mut history));
        assert!(history.status(&after).can_undo);
        ui.phase = UiPhase::Visible;
        ui.destroying.clear();
        assert!(!finish_suspension_state(&mut ui, &mut history));
        assert!(history.status(&after).can_undo);
        ui.phase = UiPhase::Suspending;
        ui.show_requested = true;
        assert!(finish_suspension_state(&mut ui, &mut history));
        assert!(ui.phase == UiPhase::Hidden);
        assert!(!history.status(&after).can_undo);
    }
}
