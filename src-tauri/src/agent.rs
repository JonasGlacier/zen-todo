use crate::{vault, Board, Todo, TodoList, VaultRuntime, Workspace};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs};
use tauri::{AppHandle, Manager, Runtime};

pub const COLORS: [&str; 6] = ["yellow", "orange", "pink", "purple", "blue", "green"];
pub const PLANNING_GUIDANCE_EN: &str = "First write a task list. Then consider each task and, where useful, break it down into more specific subtasks. For example, 'Pack items for the trip' can contain '3 shirts', '5 pairs of underwear', 'Sunglasses', and 'Toothbrush'. Keep the main task as the parent and put the detailed items in its children array. Subtasks are parts of a task, not chronological dependencies. Keep simple tasks as leaves; do not force a breakdown or invent quantities if the user's context calls for clarification.";
#[allow(dead_code)]
pub const PLANNING_GUIDANCE_ZH: &str = "先写一份任务清单，再尝试给每一条任务（如果可以的话）拆分出更详细的子任务。例如，把“整理旅行需要携带的物品”进一步拆分为“衬衫3件”“内裤5件”“太阳镜”“牙刷”等。保留原任务作为父任务，将详细条目放入它的 children 数组。子任务表示任务包含的内容，不表示执行先后。简单任务不必强行拆分；示例数量不是固定要求，需要更多信息时根据用户需求澄清。";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub mode: String,
    pub list_id: Option<String>,
    pub title: Option<String>,
    pub color: Option<String>,
    pub todos: Vec<InputTodo>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputTodo {
    id: String,
    title: String,
    completed: Option<bool>,
    parent_id: Option<String>,
    #[serde(default)]
    children: Vec<InputTodo>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub command: String,
    pub action: Option<Action>,
    pub revision: Option<String>,
}

pub fn revision(workspace: &Workspace) -> String {
    hex::encode(Sha256::digest(serde_json::to_vec(workspace).unwrap()))
}

fn title(value: &str, max: usize) -> Result<String, String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() || value.chars().count() > max { return Err(format!("Title must contain 1–{max} characters")); }
    Ok(value)
}

fn flatten(inputs: &[InputTodo], parent: Option<&str>, output: &mut Vec<InputTodo>) -> Result<(), String> {
    for input in inputs {
        if output.len() >= 300 { return Err("At most 300 tasks including subtasks per list".into()); }
        if let Some(parent) = parent {
            if input.parent_id.as_deref().is_some_and(|id| id != parent) { return Err("parentId conflicts with nested children".into()); }
        }
        let mut flat = input.clone();
        flat.children.clear();
        flat.parent_id = parent.map(str::to_string).or(input.parent_id.clone());
        output.push(flat);
        flatten(&input.children, Some(&input.id), output)?;
    }
    Ok(())
}

// A directly reusable nested view for Agents and small models.
pub fn nested_todos(board: &Board, parent: Option<&str>) -> Vec<serde_json::Value> {
    board.todos.iter().filter(|todo| todo.parent_id.as_deref() == parent).map(|todo| {
        serde_json::json!({"id":todo.id, "title":todo.title, "completed":todo.completed, "children":nested_todos(board, Some(&todo.id))})
    }).collect()
}

// Both entry points validate the complete target graph before touching data.
pub fn apply(workspace: &mut Workspace, action: &Action) -> Result<(), String> {
    if !["create", "update"].contains(&action.mode.as_str()) { return Err("Invalid action mode".into()); }
    let mut inputs = Vec::new();
    flatten(&action.todos, None, &mut inputs)?;
    if action.color.as_deref().is_some_and(|c| !COLORS.contains(&c)) { return Err("Invalid note color".into()); }
    let existing = if action.mode == "update" {
        let id = action.list_id.as_deref().ok_or("Updates require listId")?;
        Some(workspace.lists.iter().find(|l| l.id == id && !l.archived).ok_or("List not found or archived")?)
    } else { None };
    let list_title = match &action.title {
        Some(t) => title(t, 80)?,
        None => existing.map(|l| l.title.clone()).ok_or("New lists require a title")?,
    };
    let mut ids = HashMap::new();
    for todo in &inputs {
        if todo.id.is_empty() || todo.id.len() > 128 || ids.contains_key(&todo.id) { return Err("Task IDs must be non-empty and unique".into()); }
        let old = existing.and_then(|l| l.board.todos.iter().find(|t| t.id == todo.id));
        ids.insert(todo.id.clone(), old.map(|t| t.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
    }
    for todo in &inputs {
        let mut seen = HashSet::new();
        let mut current = Some(todo.id.as_str());
        while let Some(id) = current {
            if !seen.insert(id) { return Err("Subtasks cannot contain cycles or self-parenting".into()); }
            current = inputs.iter().find(|t| t.id == id).ok_or("Unknown parentId")?.parent_id.as_deref();
        }
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as i64;
    let mut todos = Vec::new();
    for input in &inputs {
        let old = existing.and_then(|l| l.board.todos.iter().find(|t| t.id == input.id));
        todos.push(Todo {
            id: ids[&input.id].clone(), title: title(&input.title, 200)?,
            completed: input.completed.unwrap_or(old.is_some_and(|t| t.completed)),
            created_at: old.map(|t| t.created_at).unwrap_or(now),
            parent_id: input.parent_id.as_ref().map(|id| ids[id].clone()),
            updated_at: old.map(|t| t.updated_at).unwrap_or(0),
            order: old.map(|t| t.order).unwrap_or(0),
        });
    }
    let mut board = Board { todos };
    board.reconcile();
    let list = if let Some(existing) = existing {
        TodoList { id: existing.id.clone(), title: list_title, board, archived: false, color: action.color.clone().or(existing.color.clone()), updated_at: existing.updated_at, order: existing.order }
    } else {
        let color = COLORS.iter().min_by_key(|c| workspace.lists.iter().filter(|l| !l.archived && l.color.as_deref() == Some(**c)).count()).unwrap();
        TodoList { id: uuid::Uuid::new_v4().to_string(), title: list_title, board, archived: false, color: Some(action.color.clone().unwrap_or_else(|| color.to_string())), updated_at: 0, order: 0 }
    };
    workspace.active_list_id = list.id.clone();
    if let Some(index) = workspace.lists.iter().position(|l| l.id == list.id) { workspace.lists[index] = list; }
    else { workspace.lists.push(list); }
    Ok(())
}

fn prepare(workspace: &Workspace, request: &Request, history: &crate::history::History) -> Result<Workspace, String> {
    let mut target = workspace.clone();
    match request.command.as_str() {
        "apply" => {
            let action = request.action.as_ref().ok_or("Action required")?;
            if action.mode == "update" && request.revision.is_none() { return Err("Updates require revision from list".into()); }
            if request.revision.as_ref().is_some_and(|r| r != &revision(workspace)) { return Err("Conflict: tasks changed; read the list again and retry".into()); }
            apply(&mut target, action)?;
        }
        "undo" => {
            target = history.target(workspace)?;
        }
        _ => return Err("Unknown command".into()),
    }
    Ok(target)
}

pub fn execute<R: Runtime>(app: &AppHandle<R>, request: Request) -> Result<serde_json::Value, String> {
    let state = app.state::<VaultRuntime>();
    let mut vault_state = state.0.lock().map_err(|e| e.to_string())?;
    let path = crate::data_file(app)?;
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let encrypted = vault::is_encrypted(&bytes)?;
    let plaintext = if encrypted { vault::open(vault_state.key.as_ref().ok_or("Vault is locked")?, &bytes)? } else { bytes };
    let mut workspace: Workspace = serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;
    workspace.normalize();
    let runtime = app.state::<crate::history::HistoryRuntime>();
    let mut history = runtime.0.lock().map_err(|e| e.to_string())?;
    if request.command == "list" {
        let task_lists: Vec<_> = workspace.lists.iter().map(|list| serde_json::json!({"id":list.id,"title":list.title,"archived":list.archived,"todos":nested_todos(&list.board, None)})).collect();
        let status = history.status(&workspace);
        return Ok(serde_json::json!({ "protocolVersion":2, "command":"list", "taskLists":task_lists, "revision": revision(&workspace), "workspace": workspace, "canUndo": status.can_undo, "undoCount":status.undo_count }));
    }
    let previous = workspace.clone();
    workspace = prepare(&workspace, &request, &history)?;
    if request.command != "undo" {
        crate::sync_merge::stamp_changes(Some(&previous), &mut workspace, crate::sync_merge::now_ms());
    }
    let data = serde_json::to_vec(&workspace).map_err(|e| e.to_string())?;
    let data = if encrypted { vault::seal(vault_state.key.as_ref().ok_or("Vault is locked")?, &data)? } else { data };
    vault::atomic_write(&path, &data)?;
    if request.command == "undo" { history.did_undo(&workspace); }
    else if crate::with_ui(app, |ui| ui.phase == crate::UiPhase::Visible && ui.ready)? { history.record(&previous, &workspace); }
    crate::with_ui(app, |ui| {
        if let Some(session) = ui.session.as_mut() {
            session["editors"] = serde_json::json!([]);
            session["listId"] = serde_json::json!(workspace.active_list_id);
            session["scrollTop"] = serde_json::json!(0);
        }
    })?;
    vault_state.sealed_session = None;
    let status = history.status(&workspace);
    drop(history);
    drop(vault_state);
    crate::sync_lan::notify_local_change(app);
    Ok(serde_json::json!({ "command":request.command, "revision": revision(&workspace), "workspace": workspace, "canUndo": status.can_undo, "undoCount":status.undo_count }))
}

/// Headless execution directly against `todos.json` when Android's `AppFunctionService`
/// is invoked by Gemini before the Tauri UI runtime has been started.
pub fn execute_on_file(path: &std::path::Path, request: Request) -> Result<serde_json::Value, String> {
    let mut workspace = if path.exists() {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if vault::is_encrypted(&bytes)? {
            return Err("Vault is locked; open OneByOne and unlock your tasks first".into());
        }
        let mut ws: Workspace = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        ws.normalize();
        ws
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        Workspace {
            lists: vec![TodoList {
                id: id.clone(),
                title: "My todos".into(),
                board: Board::default(),
                archived: false,
                color: Some("yellow".into()),
                updated_at: crate::sync_merge::now_ms(),
                order: 1000,
            }],
            active_list_id: id,
            deleted_todos: Default::default(),
            deleted_lists: Default::default(),
        }
    };

    if request.command == "list" {
        let task_lists: Vec<_> = workspace
            .lists
            .iter()
            .map(|list| {
                serde_json::json!({
                    "id": list.id,
                    "title": list.title,
                    "archived": list.archived,
                    "todos": nested_todos(&list.board, None)
                })
            })
            .collect();
        return Ok(serde_json::json!({
            "protocolVersion": 2,
            "command": "list",
            "taskLists": task_lists,
            "revision": revision(&workspace),
            "workspace": workspace,
            "canUndo": false,
            "undoCount": 0
        }));
    }

    if request.command == "undo" {
        return Err("Nothing to undo in background mode; open OneByOne to use undo history".into());
    }

    let previous = workspace.clone();
    let empty_history = crate::history::History::default();
    workspace = prepare(&workspace, &request, &empty_history)?;
    crate::sync_merge::stamp_changes(Some(&previous), &mut workspace, crate::sync_merge::now_ms());
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_vec(&workspace).map_err(|e| e.to_string())?;
    vault::atomic_write(path, &data)?;
    Ok(serde_json::json!({
        "command": request.command,
        "revision": revision(&workspace),
        "workspace": workspace,
        "canUndo": false,
        "undoCount": 0
    }))
}

#[tauri::command]
pub fn agent_execute<R: Runtime>(app: AppHandle<R>, request: Request) -> Result<serde_json::Value, String> { execute(&app, request) }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Workspace {
        serde_json::from_value(json!({"activeListId":"list", "lists":[{"id":"list","title":"Work","color":"blue","board":{"todos":[{"id":"old","title":"Ship","completed":true,"createdAt":123,"parentId":null}]}}]})).unwrap()
    }
    fn action(value: serde_json::Value) -> Action { serde_json::from_value(value).unwrap() }

    #[test]
    fn creates_list_with_mapped_parents_without_touching_other_lists() {
        let mut workspace = fixture();
        let old = workspace.lists[0].clone();
        apply(&mut workspace, &action(json!({"mode":"create","title":"旅行","todos":[{"id":"a","title":"衬衫3件","parentId":"b"},{"id":"b","title":"整理行李"}]}))).unwrap();
        assert_eq!(workspace.lists[0], old);
        let added = &workspace.lists[1];
        assert_eq!(workspace.active_list_id, added.id);
        assert_ne!(added.board.todos[0].id, "a");
        assert_eq!(added.board.todos[0].parent_id.as_ref(), Some(&added.board.todos[1].id));
        assert!(added.board.todos.iter().all(|t| !t.completed));
    }

    #[test]
    fn preserves_existing_identity_and_reopens_parents_with_unfinished_subtasks() {
        let mut workspace = fixture();
        apply(&mut workspace, &action(json!({"mode":"update","listId":"list","todos":[{"id":"new","title":"Test","parentId":"old"},{"id":"old","title":"Publish"}]}))).unwrap();
        let old = &workspace.lists[0].board.todos[1];
        assert_eq!(old.id, "old");
        assert_eq!(old.created_at, 123);
        assert!(!old.completed);
        assert_eq!(workspace.lists[0].color.as_deref(), Some("blue"));
    }

    #[test]
    fn omitted_completion_is_preserved_and_removed_tasks_are_removed() {
        let mut workspace = fixture();
        apply(&mut workspace, &action(json!({"mode":"update","listId":"list","todos":[{"id":"old","title":"Ship"}]}))).unwrap();
        assert!(workspace.lists[0].board.todos[0].completed);
        apply(&mut workspace, &action(json!({"mode":"update","listId":"list","todos":[]}))).unwrap();
        assert!(workspace.lists[0].board.todos.is_empty());
    }

    #[test]
    fn malformed_graphs_are_rejected_atomically() {
        for todos in [
            json!([{"id":"a","title":"A","parentId":"a"}]),
            json!([{"id":"a","title":"A","parentId":"missing"}]),
            json!([{"id":"a","title":"A","parentId":"b"},{"id":"b","title":"B","parentId":"a"}]),
            json!([{"id":"a","title":"A"},{"id":"a","title":"Duplicate"}]),
            json!([{"id":"a","title":"A","children":[{"id":"a","title":"Duplicate"}]}]),
            json!([{"id":"a","title":"A","children":[{"id":"b","title":"B","parentId":"other"}]}]),
            json!([{"id":"a","title":"   "}]),
            json!([{"id":"a","title":"x".repeat(201)}]),
        ] {
            let mut workspace = fixture();
            let original = workspace.clone();
            assert!(apply(&mut workspace, &action(json!({"mode":"update","listId":"list","todos":todos}))).is_err());
            assert_eq!(workspace, original);
        }
    }

    #[test]
    fn revision_checks_prevent_overwriting_later_edits() {
        let workspace = fixture();
        let mut request = Request { command: "apply".into(), revision: Some(revision(&workspace)), action: Some(action(json!({"mode":"update","listId":"list","todos":[]}))) };
        let history = crate::history::History::default();
        assert!(prepare(&workspace, &request, &history).is_ok());
        let mut edited = workspace.clone();
        edited.lists[0].board.todos[0].title = "Manually changed".into();
        assert!(prepare(&edited, &request, &history).unwrap_err().starts_with("Conflict:"));
        request.revision = None;
        assert!(prepare(&workspace, &request, &history).is_err());
    }

    #[test]
    fn undo_restores_exact_snapshot_but_never_discards_subsequent_edits() {
        let before = fixture();
        let mut after = before.clone();
        apply(&mut after, &action(json!({"mode":"create","title":"New","todos":[]}))).unwrap();
        let mut history = crate::history::History::default();
        history.record(&before, &after);
        let request = Request { command: "undo".into(), revision: None, action: None };
        assert_eq!(prepare(&after, &request, &history).unwrap(), before);
        after.lists[0].title = "Later edit".into();
        assert!(prepare(&after, &request, &history).is_err());
        assert!(prepare(&before, &request, &crate::history::History::default()).is_err());
    }

    #[test]
    fn nested_packing_checklist_roundtrips_with_deeper_subtasks_and_completion() {
        let mut workspace = fixture();
        let input = action(json!({"mode":"create","title":"旅行","todos":[{
            "id":"pack","title":"整理旅行需要携带的物品","children":[
                {"id":"shirts","title":"衬衫3件","completed":true},
                {"id":"underwear","title":"内裤5件","completed":true},
                {"id":"glasses","title":"太阳镜","completed":true},
                {"id":"bath","title":"洗漱用品","children":[{"id":"brush","title":"牙刷","completed":true}]}
            ]
        }]}));
        apply(&mut workspace, &input).unwrap();
        let board = &workspace.lists[1].board;
        assert_eq!(board.todos.len(), 6);
        assert!(board.todos.iter().all(|todo| todo.completed));
        let nested = nested_todos(board, None);
        assert_eq!(nested.len(), 1);
        assert_eq!(nested[0]["title"], "整理旅行需要携带的物品");
        assert_eq!(nested[0]["children"][3]["children"][0]["title"], "牙刷");
        let update = action(json!({"mode":"update","listId":workspace.lists[1].id,"todos":nested}));
        let before = workspace.clone();
        apply(&mut workspace, &update).unwrap();
        assert_eq!(workspace, before);
    }

    #[test]
    fn total_task_limit_includes_nested_children() {
        let children: Vec<_> = (0..300).map(|i| json!({"id":format!("child-{i}"),"title":"Item"})).collect();
        let mut workspace = fixture();
        let original = workspace.clone();
        assert!(apply(&mut workspace, &action(json!({"mode":"create","title":"Too many","todos":[{"id":"parent","title":"Group","children":children}]}))).is_err());
        assert_eq!(workspace, original);
    }

    #[test]
    fn legacy_storage_migrates_to_parent_ids_and_nested_completion() {
        let mut workspace: Workspace = serde_json::from_value(json!({"activeListId":"list","lists":[{"id":"list","title":"Travel","board":{"todos":[
            {"id":"pack","title":"Pack","completed":false,"createdAt":1,"nextId":null},
            {"id":"shirts","title":"Shirts","completed":true,"createdAt":2,"nextId":"pack"}
        ]}}]})).unwrap();
        workspace.normalize();
        assert_eq!(workspace.lists[0].board.todos[1].parent_id.as_deref(), Some("pack"));
        assert!(workspace.lists[0].board.todos[0].completed);
        let saved = serde_json::to_value(&workspace).unwrap();
        assert_eq!(saved["lists"][0]["board"]["todos"][1]["parentId"], "pack");
        assert!(saved["lists"][0]["board"]["todos"][1].get("nextId").is_none());
        assert_eq!(workspace.lists[0].board.todos[1].created_at, 2);
        // The old protocol is accepted only for storage, never for new actions.
        assert!(serde_json::from_value::<Action>(json!({"mode":"create","title":"Old","todos":[{"id":"x","title":"X","nextId":null}]})).is_err());
    }
}
