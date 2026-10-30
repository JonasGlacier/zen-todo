use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow, WindowEvent};

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
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Board {
    groups: Vec<Group>,
    todos: Vec<Todo>,
}

fn data_file<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("todos.json"))
}

#[tauri::command]
fn load_board<R: Runtime>(app: AppHandle<R>) -> Result<Board, String> {
    let path = data_file(&app)?;
    if !path.exists() { return Ok(Board::default()); }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_board<R: Runtime>(app: AppHandle<R>, board: Board) -> Result<(), String> {
    let path = data_file(&app)?;
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_string_pretty(&board).map_err(|error| error.to_string())?;
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    app.get_webview_window("main").ok_or_else(|| "main window not found".to_string())
}

#[tauri::command]
fn set_always_on_top<R: Runtime>(app: AppHandle<R>, value: bool) -> Result<(), String> {
    main_window(&app)?.set_always_on_top(value).map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    main_window(&app)?.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn start_dragging(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(window) = main_window(app) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let menu = tauri::menu::MenuBuilder::new(app)
                .item(&tauri::menu::MenuItemBuilder::with_id("show", "显示 Zen Todo").build(app)?)
                .separator()
                .item(&tauri::menu::MenuItemBuilder::with_id("quit", "退出").build(app)?)
                .build()?;
            let tray_icon = tauri::image::Image::from_app_icon_resource(32)?;
            tauri::tray::TrayIconBuilder::new()
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
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![load_board, save_board, set_always_on_top, hide_window, start_dragging])
        .run(tauri::generate_context!())
        .expect("error while running Zen Todo");
}
