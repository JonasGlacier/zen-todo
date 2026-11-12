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
        format!("Please use the Zen Todo CLI to manage my task lists.\n\nThe CLI's absolute path on this computer is:\n{path}\n\nStart by learning the protocol with schema, then read the workspace with list. PowerShell commands (use the appropriate quoting if your shell differs):\n& '{quoted}' schema\n& '{quoted}' list\n\nFollow my request and submit changes with apply using a UTF-8 JSON file or stdin. Updates require revision and listId from list. todos is the COMPLETE target list: include every task to retain and preserve its existing ID. nextId points from a prerequisite to its next step. On conflict, read again and re-plan. Use undo to revert the latest AI/Agent update when requested.\n\nZen Todo must be running (it may be hidden in the tray) and unlocked. Do not edit its data or session files directly. No API key or model configuration in Zen Todo is needed for this CLI workflow. After writing, read the result with list and briefly summarize the changes. If I have not provided a task request yet, ask what I would like to create or change.")
    } else {
        format!("请通过 Zen Todo CLI 帮我管理待办清单。\n\n本机 CLI 的绝对路径是：\n{path}\n\n请先运行 schema 学习协议，再运行 list 读取工作区。PowerShell 命令如下（使用其他 Shell 时请按对应规则引用路径）：\n& '{quoted}' schema\n& '{quoted}' list\n\n根据我的要求，通过 UTF-8 JSON 文件或标准输入执行 apply。更新时使用 list 返回的 revision 和明确的 listId。todos 是完整的目标清单：提交所有希望保留的待办，并保留其原始 ID。nextId 从“上一步”指向“下一步”。遇到冲突先重新读取并重新规划。需要撤销时使用 undo 撤销最近一次 AI / Agent 更新。\n\nZen Todo 必须保持运行，可以隐藏到托盘，但保险库需要解锁。不要直接修改应用的数据文件或会话文件。通过 CLI 操作无需在 Zen Todo 中配置模型或 API Key。写入后请用 list 检查结果，并简短说明修改了什么。如果我还没有提供具体任务需求，请询问我想创建或调整什么清单。")
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
            "description":"apply accepts a request with action and optional revision. todos is the COMPLETE target list, omitted tasks are removed. Updates require revision from list and action.listId. nextId points from a prerequisite to its next step; null means independent/final. Existing IDs are retained; temporary IDs are mapped to UUIDs. Titles: list 80, task 200 characters. Maximum 300 tasks. Undo only works before subsequent edits. Locked vaults reject requests.",
            "createExample":{"command":"apply","action":{"mode":"create","title":"Release","todos":[{"id":"test","title":"Run tests","nextId":"ship"},{"id":"ship","title":"Publish release","nextId":null}]}},
            "updateExample":{"command":"apply","revision":"COPY_FROM_LIST","action":{"mode":"update","listId":"COPY_FROM_LIST","todos":[{"id":"EXISTING_TASK_ID","title":"Updated task","nextId":null}]}},
            "optionalActionFields":{"title":"string", "color":agent::COLORS, "summary":"string"},
            "optionalTaskFields":{"completed":"boolean; omitted preserves existing state, false for new tasks", "nextId":"string or null"}
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
