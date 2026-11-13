use crate::agent::{self, Request};
use std::{path::Path, sync::OnceLock};
use tauri::{AppHandle, Emitter};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn register_app_handle(handle: AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

/// Executes a JSON-encoded `agent::Request` on behalf of Android 16+ `AppFunctionService`
/// (Gemini Agent). Uses the live Tauri runtime if active (updating undo history, WebView
/// UI, and LAN sync), or safely operates on `todos.json` directly when cold-started.
pub fn handle_external_agent_json(fallback_data_dir: &Path, request_json: &str) -> String {
    let outcome = (|| -> Result<serde_json::Value, String> {
        let request: Request =
            serde_json::from_str(request_json).map_err(|e| format!("Invalid request JSON: {e}"))?;
        if let Some(app) = APP_HANDLE.get() {
            let is_write = request.command != "list";
            let res = agent::execute(app, request)?;
            if is_write {
                let _ = app.emit("sync-updated", ());
            }
            Ok(res)
        } else {
            let todos_path = fallback_data_dir.join("todos.json");
            agent::execute_on_file(&todos_path, request)
        }
    })();

    match outcome {
        Ok(result) => serde_json::json!({ "ok": true, "result": result }).to_string(),
        Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_rossemlab_onebyone_AppFunctionBridge_nativeExecute<'local>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
    data_dir: jni::objects::JString<'local>,
    request_json: jni::objects::JString<'local>,
) -> jni::sys::jstring {
    let dir_str: String = match env.get_string(&data_dir) {
        Ok(s) => s.into(),
        Err(e) => {
            let err = serde_json::json!({"ok": false, "error": format!("JNI dir error: {e}")}).to_string();
            return env.new_string(err).expect("JNI string").into_raw();
        }
    };
    let req_str: String = match env.get_string(&request_json) {
        Ok(s) => s.into(),
        Err(e) => {
            let err = serde_json::json!({"ok": false, "error": format!("JNI req error: {e}")}).to_string();
            return env.new_string(err).expect("JNI string").into_raw();
        }
    };
    let response = handle_external_agent_json(Path::new(&dir_str), &req_str);
    env.new_string(response)
        .unwrap_or_else(|_| env.new_string(r#"{"ok":false,"error":"JNI encode error"}"#).unwrap())
        .into_raw()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_start_app_function_creates_reads_and_updates_nested_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let create_req = serde_json::json!({
            "command": "apply",
            "action": {
                "mode": "create",
                "title": "Camping",
                "color": "green",
                "todos": [{
                    "id": "gear",
                    "title": "Pack camping gear",
                    "children": [
                        {"id": "tent", "title": "Tent"},
                        {"id": "lamp", "title": "Headlamp"}
                    ]
                }]
            }
        })
        .to_string();

        let create_resp: serde_json::Value =
            serde_json::from_str(&handle_external_agent_json(dir.path(), &create_req)).unwrap();
        assert_eq!(create_resp["ok"], true);

        let list_resp: serde_json::Value = serde_json::from_str(&handle_external_agent_json(
            dir.path(),
            r#"{"command":"list"}"#,
        ))
        .unwrap();
        assert_eq!(list_resp["ok"], true);
        let lists = list_resp["result"]["taskLists"].as_array().unwrap();
        let camping = lists.iter().find(|l| l["title"] == "Camping").unwrap();
        assert_eq!(camping["todos"][0]["children"].as_array().unwrap().len(), 2);
    }
}
