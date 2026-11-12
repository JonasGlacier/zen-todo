use crate::agent::{self, Request};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs::{self, File, OpenOptions}, io::{BufRead, BufReader, Read, Write}, net::{TcpListener, TcpStream}, path::PathBuf, sync::{mpsc, Mutex}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, Runtime};

type Reply = Result<serde_json::Value, String>;
struct Pending { request: Request, reply: mpsc::Sender<Reply> }
#[derive(Default)]
pub struct CliRuntime {
    pending: Mutex<HashMap<String, Pending>>,
    lock: Mutex<Option<File>>,
}

#[derive(Serialize, Deserialize)]
struct Session { port: u16, token: String }
#[derive(Serialize, Deserialize)]
struct Envelope { token: String, request: Request }

pub fn start<R: Runtime>(app: AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let path = crate::data_file(&app).map_err(std::io::Error::other)?.with_file_name("cli-session.json");
    let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path.with_extension("lock"))?;
    lock.try_lock_exclusive().map_err(|_| std::io::Error::other("Zen Todo is already running"))?;
    *app.state::<CliRuntime>().lock.lock().unwrap() = Some(lock);
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let token = uuid::Uuid::new_v4().to_string();
    let session = Session { port: listener.local_addr()?.port(), token: token.clone() };
    crate::vault::atomic_write(&path, &serde_json::to_vec(&session)?).map_err(std::io::Error::other)?;
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = serve_connection(stream, &token, |request| dispatch(&app, request));
        }
    });
    Ok(())
}

fn serve_connection(stream: TcpStream, token: &str, handler: impl FnOnce(Request) -> Reply) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(stream);
    let reply = (|| -> Reply {
        let mut line = String::new();
        reader.by_ref().take(262_145).read_line(&mut line).map_err(|e| e.to_string())?;
        if line.len() > 262_144 || !line.ends_with('\n') { return Err("Invalid or oversized request".into()); }
        let envelope: Envelope = serde_json::from_str(&line).map_err(|_| "Invalid request")?;
        if envelope.token != token { return Err("Invalid session token".into()); }
        handler(envelope.request)
    })();
    let result = match reply { Ok(value) => serde_json::json!({"ok":true,"result":value}), Err(error) => serde_json::json!({"ok":false,"error":error}) };
    writeln!(reader.get_mut(), "{}", result)
}

fn dispatch<R: Runtime>(app: &AppHandle<R>, request: Request) -> Reply {
    let phase = crate::with_ui(app, |ui| {
        let phase = (ui.phase, ui.ready);
        if ui.phase == crate::UiPhase::Hidden { ui.phase = crate::UiPhase::AgentEditing; }
        phase
    })?;
    if phase.0 == crate::UiPhase::Hidden {
        let result = agent::execute(app, request);
        let show = crate::with_ui(app, |ui| { ui.phase = crate::UiPhase::Hidden; std::mem::take(&mut ui.show_requested) })?;
        if show { crate::show_main(app); }
        return result;
    }
    if phase != (crate::UiPhase::Visible, true) { return Err("App is busy starting, hiding or restoring; retry shortly".into()); }
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel();
    let runtime = app.state::<CliRuntime>();
    runtime.pending.lock().map_err(|e| e.to_string())?.insert(id.clone(), Pending { request, reply: tx });
    let result = app.emit_to("main", "cli-request", &id).map_err(|e| e.to_string()).and_then(|_| {
        rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "UI did not respond; read current state before retrying".to_string())?
    });
    runtime.pending.lock().map_err(|e| e.to_string())?.remove(&id);
    result
}

// The WebView queues this after committing editors and flushing pending saves.
// Hidden mode uses the exact same engine without recreating the WebView.
#[tauri::command]
pub fn execute_cli_request<R: Runtime>(app: AppHandle<R>, id: String, reject: bool) -> Result<serde_json::Value, String> {
    let pending = app.state::<CliRuntime>().pending.lock().map_err(|e| e.to_string())?.remove(&id).ok_or("CLI request expired")?;
    let result = if reject { Err("App is suspending or a pending save failed; retry".into()) } else { agent::execute(&app, pending.request) };
    let _ = pending.reply.send(result.clone());
    result
}

fn session_path() -> Result<PathBuf, String> {
    Ok(dirs::data_dir().ok_or("Cannot locate application data")?.join("com.zentodo.app").join("cli-session.json"))
}

#[tauri::command]
pub fn copy_agent_prompt(language: String) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable.parent().ok_or("Cannot locate the application directory")?;
    let mut cli = directory.join("zen-todo-cli.exe");
    // `tauri dev` builds the GUI in debug; the installer build produces a release CLI.
    if cfg!(debug_assertions) && !cli.is_file() && directory.file_name().is_some_and(|name| name == "debug") {
        cli = directory.parent().ok_or("Cannot locate the build directory")?.join("release/zen-todo-cli.exe");
    }
    if !cli.is_file() {
        return Err(if language == "en" {
            "zen-todo-cli.exe is missing. Reinstall the app; for development, run npm run build:cli."
        } else {
            "未找到 zen-todo-cli.exe，请重新安装应用；开发环境请先执行 npm run build:cli。"
        }.into());
    }
    let path = cli.to_str().ok_or("CLI path is not valid Unicode")?;
    let quoted = path.replace('\'', "''");
    let prompt = if language == "en" {
        let guidance = agent::PLANNING_GUIDANCE_EN;
        format!("Please use Zen Todo, a todo list with nested subtasks, to manage my tasks via its CLI.\n\nThe CLI's absolute path on this computer is:\n{path}\n\nStart with schema, then list. PowerShell commands (adapt quoting to your shell):\n& '{quoted}' schema\n& '{quoted}' list\n\n{guidance}\n\nPrefer the nested taskLists view from list. Submit top-level tasks in action.todos and subtasks in children arrays. New tasks need unique temporary IDs. Use apply with a UTF-8 JSON file or stdin. Updates require revision and listId from list. todos and its children are the COMPLETE target list: retain every task that should remain, its existing ID, completion state and nesting. Only expand relevant tasks on edits. Re-read and re-plan on conflict.\n\nundo reverts the latest workspace operation, whether manual, AI or CLI. History keeps at most 20 operations, is cleared whenever the app is hidden to the tray or exits, and is not recorded for hidden-mode changes. Check list.canUndo and list.undoCount before undoing.\n\nKeep Zen Todo running and unlocked; tray mode supports reading and applying changes. Do not edit data or session files directly. No in-app API key or model setup is needed. Read the result with list and summarize the changes. If no task request has been provided yet, ask what I would like to create or change.")
    } else {
        let guidance = agent::PLANNING_GUIDANCE_ZH;
        format!("请通过 CLI 帮我管理 Zen Todo：这是一个可以嵌套子任务的待办清单应用。\n\n本机 CLI 的绝对路径是：\n{path}\n\n先运行 schema，再运行 list。PowerShell 命令如下（使用其他 Shell 时请按对应规则引用路径）：\n& '{quoted}' schema\n& '{quoted}' list\n\n{guidance}\n\n优先阅读 list 返回的嵌套 taskLists 视图。父任务放在 action.todos 中，子任务放在对应父任务的 children 数组中，新任务使用临时唯一 ID。通过 UTF-8 JSON 文件或标准输入执行 apply。更新时附上 list 返回的 revision 和明确的 listId。todos 及其 children 是完整的目标清单，须保留所有希望保留的任务、原始 ID、完成状态及层级。只拆分请求相关任务，遇到冲突先重新读取并重新规划。\n\nundo 撤销最近一次清单操作，可能是手动、AI 或 CLI 修改。历史最多保留20次操作，每次隐藏到托盘或退出时清空，隐藏期间的修改不记录撤销历史。撤销前先检查 list 返回的 canUndo 和 undoCount。\n\nZen Todo 必须保持运行且已解锁，隐藏到托盘时仍可读取和修改。不要直接修改应用的数据文件或会话文件，CLI 操作无需配置应用内模型或 API Key。写入后用 list 检查结果并简短说明修改了什么；如果我还没有给出具体需求，请先询问想创建或调整什么清单。")
    };
    arboard::Clipboard::new().map_err(|e| e.to_string())?.set_text(prompt).map_err(|e| e.to_string())
}

/// Console entry point, kept separate from the GUI-subsystem Windows binary.
pub fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    if command == "help" || command == "--help" {
        println!("zen-todo-cli list | apply [file.json|-] | undo | schema\nRun Zen Todo first. apply reads a JSON request from a file or stdin. Updates require revision and listId from list.");
        return Ok(());
    }
    if command == "schema" {
        println!("{}", serde_json::json!({
            "protocolVersion":2,
            "description":"Zen Todo is a todo list with nested subtasks. list returns taskLists (nested, recommended for Agents) and workspace (flat internal storage using parentId), plus canUndo and undoCount. apply accepts action.todos as the COMPLETE target tree; omitted tasks and subtasks are removed. Updates require revision from list and action.listId. Put subtasks inside children, recursively. Existing IDs are retained; new temporary IDs are mapped to UUIDs. Titles: list 80, task 200 characters. Maximum 300 tasks INCLUDING subtasks. Parent completion is derived from all children, so set leaf completion states to complete or reopen a subtree. Undo shares a 20-operation history across manual, AI and CLI changes. Hiding to tray clears all history; hidden-mode edits do not record undo history. Locked vaults reject requests.",
            "planningGuidance":{"en":agent::PLANNING_GUIDANCE_EN,"zh-CN":agent::PLANNING_GUIDANCE_ZH},
            "createExample":{"command":"apply","action":{"mode":"create","title":"Travel","todos":[{"id":"pack","title":"Pack items for the trip","children":[{"id":"shirts","title":"3 shirts"},{"id":"underwear","title":"5 pairs of underwear"},{"id":"glasses","title":"Sunglasses"},{"id":"brush","title":"Toothbrush"}]}]}},
            "updateExample":{"command":"apply","revision":"COPY_FROM_LIST","action":{"mode":"update","listId":"COPY_FROM_LIST","todos":[{"id":"EXISTING_PARENT_ID","title":"Pack for the trip","children":[{"id":"EXISTING_CHILD_ID","title":"3 shirts","completed":false}]}]}},
            "optionalActionFields":{"title":"string", "color":agent::COLORS, "summary":"string"},
            "optionalTaskFields":{"completed":"boolean; omitted preserves existing leaf state, false for new leaves; parent state derives from children", "children":"array of subtasks; omit or [] for a leaf", "parentId":"for flat input only, the parent task ID or null for a top-level task; do not use alongside nested children unless consistent"}
        }));
        return Ok(());
    }
    let request = if command == "apply" {
        let input = if let Some(path) = args.get(1).filter(|p| p.as_str() != "-") { fs::read_to_string(path).map_err(|e| e.to_string())? }
        else { let mut input = String::new(); std::io::stdin().take(262_145).read_to_string(&mut input).map_err(|e| e.to_string())?; input };
        if input.len() > 262_144 { return Err("Request too large".into()); }
        let request: Request = serde_json::from_str(&input).map_err(|e| e.to_string())?;
        if request.command != "apply" { return Err("Expected command: apply".into()); }
        request
    } else if command == "list" || command == "undo" { Request { command: command.into(), action: None, revision: None } }
    else { return Err("Unknown command; use --help".into()); };
    let session: Session = serde_json::from_slice(&fs::read(session_path()?).map_err(|_| "Start Zen Todo before using the CLI")?).map_err(|_| "Invalid session file; restart Zen Todo")?;
    let result = send_request(session, request)?;
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
    Ok(())
}

fn send_request(session: Session, request: Request) -> Reply {
    let mut stream = TcpStream::connect_timeout(&format!("127.0.0.1:{}", session.port).parse().unwrap(), Duration::from_secs(3)).map_err(|_| "Cannot connect; start or restart Zen Todo")?;
    stream.set_read_timeout(Some(Duration::from_secs(25))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    writeln!(stream, "{}", serde_json::to_string(&Envelope { token: session.token, request }).unwrap()).map_err(|e| e.to_string())?;
    let mut output = String::new();
    BufReader::new(stream).take(8_388_608).read_line(&mut output).map_err(|e| e.to_string())?;
    let response: serde_json::Value = serde_json::from_str(&output).map_err(|_| "Invalid response")?;
    if response["ok"] != true { return Err(response["error"].as_str().unwrap_or("Request failed").into()); }
    Ok(response["result"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authenticated_cli_roundtrip_preserves_payload_and_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve_connection(stream, "session-key", |request| {
                assert_eq!(request.command, "apply");
                assert_eq!(request.revision.as_deref(), Some("revision-123"));
                assert_eq!(request.action.unwrap().title.as_deref(), Some("旅行"));
                Ok(serde_json::json!({"revision":"next", "canUndo":true}))
            }).unwrap();
        });
        let request: Request = serde_json::from_value(serde_json::json!({"command":"apply","revision":"revision-123","action":{"mode":"create","title":"旅行","todos":[]}})).unwrap();
        let result = send_request(Session { port, token:"session-key".into() }, request).unwrap();
        assert_eq!(result["revision"], "next");
        assert_eq!(result["canUndo"], true);
        server.join().unwrap();
    }

    #[test]
    fn wrong_token_never_dispatches_a_request() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve_connection(stream, "correct", |_| panic!("Unauthenticated request dispatched")).unwrap();
        });
        let error = send_request(Session { port, token:"wrong".into() }, Request { command:"undo".into(), action:None, revision:None }).unwrap_err();
        assert_eq!(error, "Invalid session token");
        server.join().unwrap();
    }
}
