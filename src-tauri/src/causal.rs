//! Field registers with dotted version vectors. Wall clocks are display metadata only.
//! Concurrent alternatives remain in the register; materialization picks a stable
//! winner. An intentional subsequent edit observes and resolves those alternatives.
use crate::Workspace;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub type Fields = BTreeMap<String, Value>;
type Clock = BTreeMap<String, u64>;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Dot { pub device: String, pub sequence: u64 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Write { pub dot: Dot, pub context: Clock, pub value: Value }

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct State {
    pub clock: Clock,
    pub fields: BTreeMap<String, Vec<Write>>,
}

impl State { pub fn is_empty(&self) -> bool { self.fields.is_empty() } }

pub fn has_retained_data(ws: &Workspace) -> bool {
    ws.causal.fields.iter().any(|(k, writes)| {
        let [kind, _, field] = parts(k);
        kind == "todo" || (field == "exists" && winner(writes) == Some(&json!(false)))
    })
}

fn key(kind: &str, id: &str, field: &str) -> String {
    serde_json::to_string(&[kind, id, field]).unwrap()
}
fn parts(key: &str) -> [String; 3] { serde_json::from_str(key).expect("internal field key") }

pub fn fields(ws: &Workspace) -> Fields {
    let mut result = Fields::new();
    for (index, list) in ws.lists.iter().enumerate() {
        let mut value = serde_json::to_value(list).unwrap();
        let obj = value.as_object_mut().unwrap();
        obj.remove("board"); obj.remove("updatedAt"); obj.remove("id");
        obj.insert("order".into(), json!(index));
        obj.insert("exists".into(), json!(true));
        // Optional fields must be explicit so clearing one is a real operation.
        obj.insert("color".into(), json!(list.color));
        for (name, value) in obj { result.insert(key("list", &list.id, name), value.clone()); }
        for (index, todo) in list.board.todos.iter().enumerate() {
            let mut value = serde_json::to_value(todo).unwrap();
            let obj = value.as_object_mut().unwrap();
            obj.remove("updatedAt"); obj.remove("id");
            obj.insert("order".into(), json!(index));
            obj.insert("exists".into(), json!(true));
            obj.insert("listId".into(), json!(list.id));
            for (name, value) in obj { result.insert(key("todo", &todo.id, name), value.clone()); }
        }
    }
    result
}

pub fn changes(before: &Fields, after: &Fields) -> Fields {
    let mut result: Fields = after.iter().filter(|(k, v)| before.get(*k) != Some(*v))
        .map(|(k, v)| (k.clone(), v.clone())).collect();
    for k in before.keys() {
        if parts(k)[2] == "exists" && !after.contains_key(k) { result.insert(k.clone(), json!(false)); }
    }
    result
}

pub fn initialize(ws: &mut Workspace) {
    if !ws.causal.is_empty() { return; }
    let mut values = fields(ws);
    for id in ws.deleted_lists.keys() { values.insert(key("list", id, "exists"), json!(false)); }
    for id in ws.deleted_todos.keys() { values.insert(key("todo", id, "exists"), json!(false)); }
    use sha2::{Digest, Sha256};
    // One deterministic migration operation, not one vector-clock actor per field.
    let device = format!("legacy:{}", hex::encode(Sha256::digest(serde_json::to_vec(&values).unwrap())));
    for (k, value) in values {
        let [kind, id, _] = parts(&k);
        // Timestamps are used only to import ordering from the old format.
        // Every subsequent local operation is ordered by causal context.
        let timestamp = if kind == "list" {
            ws.deleted_lists.get(&id).copied().or_else(|| ws.lists.iter().find(|l| l.id == id).map(|l| l.updated_at))
        } else {
            ws.deleted_todos.get(&id).copied().or_else(|| ws.lists.iter().flat_map(|l| &l.board.todos)
                .find(|t| t.id == id).map(|t| if t.updated_at > 0 { t.updated_at } else { t.created_at }))
        }.unwrap_or(1).max(1) as u64;
        let dot = Dot { device: device.clone(), sequence: timestamp };
        ws.causal.clock.entry(device.clone()).and_modify(|s| *s = (*s).max(timestamp)).or_insert(timestamp);
        ws.causal.fields.insert(k, vec![Write { dot, context: Clock::new(), value }]);
    }
}

fn observed(clock: &Clock, dot: &Dot) -> bool {
    clock.get(&dot.device).copied().unwrap_or(0) >= dot.sequence
}

pub fn merge(a: &State, b: &State) -> State {
    let mut result = a.clone();
    for (device, seq) in &b.clock { result.clock.entry(device.clone()).and_modify(|s| *s = (*s).max(*seq)).or_insert(*seq); }
    for (k, writes) in &b.fields {
        let all = result.fields.entry(k.clone()).or_default();
        for write in writes { if !all.iter().any(|w| w.dot == write.dot) { all.push(write.clone()); } }
        let snapshot = all.clone();
        all.retain(|w| !snapshot.iter().any(|other| other.dot != w.dot && observed(&other.context, &w.dot)));
        all.sort_by(|a, b| a.dot.cmp(&b.dot));
    }
    result
}

pub fn observe_clock(target: &mut Workspace, other: &Workspace) {
    if target.causal.is_empty() && other.causal.is_empty() { return; }
    initialize(target);
    let mut other = other.clone(); initialize(&mut other);
    for (device, seq) in other.causal.clock {
        target.causal.clock.entry(device).and_modify(|s| *s = (*s).max(seq)).or_insert(seq);
    }
}

pub fn winner(writes: &[Write]) -> Option<&Value> {
    writes.iter().max_by(|a, b| {
        let a_legacy = a.dot.device.starts_with("legacy:");
        let b_legacy = b.dot.device.starts_with("legacy:");
        if a_legacy && b_legacy {
            a.dot.sequence.cmp(&b.dot.sequence).then((a.value == json!(false)).cmp(&(b.value == json!(false)))).then(a.dot.cmp(&b.dot))
        } else {
            // Real operations outrank migration seeds. Concurrent delete wins;
            // an explicit restore observes and removes the old delete version.
            (!a_legacy).cmp(&!b_legacy).then((a.value == json!(false)).cmp(&(b.value == json!(false)))).then(a.dot.cmp(&b.dot))
        }
    }).map(|w| &w.value)
}

pub fn validate(ws: &Workspace) -> Result<(), String> {
    for (key, writes) in &ws.causal.fields {
        let [kind, id, field]: [String; 3] = serde_json::from_str(key).map_err(|_| "Invalid causal field key")?;
        if !matches!(kind.as_str(), "list" | "todo") || id.is_empty() || field.is_empty() || writes.is_empty() {
            return Err("Invalid causal register".into());
        }
        for w in writes {
            if w.dot.device.is_empty() || w.dot.sequence == 0 || !observed(&ws.causal.clock, &w.dot) || observed(&w.context, &w.dot) {
                return Err("Invalid causal operation version".into());
            }
        }
    }
    Ok(())
}

fn write(state: &mut State, delta: Fields, device: &str) {
    if delta.is_empty() { return; }
    let context = state.clock.clone();
    let sequence = context.get(device).copied().unwrap_or(0).checked_add(1).expect("operation sequence exhausted");
    state.clock.insert(device.into(), sequence);
    for (k, value) in delta {
        state.fields.insert(k, vec![Write { dot: Dot { device: device.into(), sequence }, context: context.clone(), value }]);
    }
}

pub fn materialize(state: State, active: &str) -> Workspace {
    let mut entities: BTreeMap<(String, String), serde_json::Map<String, Value>> = BTreeMap::new();
    for (k, writes) in &state.fields {
        let [kind, id, field] = parts(k);
        if let Some(value) = winner(writes) { entities.entry((kind, id)).or_default().insert(field, value.clone()); }
    }
    let mut lists = Vec::new();
    let mut todos = Vec::new();
    for ((kind, id), mut obj) in entities {
        if obj.remove("exists") != Some(json!(true)) { continue; }
        obj.insert("id".into(), json!(id));
        if kind == "list" {
            obj.insert("board".into(), json!({"todos": []}));
            if let Ok(list) = serde_json::from_value::<crate::TodoList>(Value::Object(obj)) { lists.push(list); }
        } else {
            let list_id = obj.remove("listId").and_then(|v| v.as_str().map(str::to_owned));
            if let (Some(list_id), Ok(todo)) = (list_id, serde_json::from_value::<crate::Todo>(Value::Object(obj))) { todos.push((list_id, todo)); }
        }
    }
    lists.sort_by(|a, b| a.order.cmp(&b.order).then(a.id.cmp(&b.id)));
    for list in &mut lists {
        list.board.todos = todos.iter().filter(|(id, _)| id == &list.id).map(|(_, t)| t.clone()).collect();
        list.board.todos.sort_by(|a, b| a.order.cmp(&b.order).then(a.id.cmp(&b.id)));
    }
    let mut ws = Workspace { lists, active_list_id: active.into(), deleted_lists: Default::default(), deleted_todos: Default::default(), causal: state };
    ws.normalize();
    crate::sync_merge::ensure_open_list(&mut ws, active);
    ws
}

/// Apply only the caller's changes, checking field versions against its base.
/// This also implements selective undo: base=original result, desired=original input.
pub fn commit(base: &Workspace, desired: &Workspace, latest: &Workspace, device: &str) -> Result<Workspace, String> {
    let mut base = base.clone(); initialize(&mut base);
    let mut latest = latest.clone(); initialize(&mut latest);
    let base_fields = fields(&base);
    let desired_fields = fields(desired);
    let mut delta = changes(&base_fields, &desired_fields);
    // A deterministic fallback list may be projected when all lists were
    // deleted concurrently. Its first local save must create its registers.
    for (k, value) in &desired_fields {
        if base.causal.fields.get(k) == latest.causal.fields.get(k) && (!latest.causal.fields.contains_key(k) || (parts(k)[2] == "exists"
            && winner(latest.causal.fields.get(k).map(Vec::as_slice).unwrap_or(&[])) != Some(value))) {
            delta.insert(k.clone(), value.clone());
        }
    }
    let mut guards: BTreeSet<String> = delta.keys().cloned().collect();
    for k in delta.keys() {
        let [kind, id, field] = parts(k);
        guards.insert(key(&kind, &id, "exists"));
        if field == "exists" {
            // Deleting/restoring an entity must not hide somebody else's edits.
            guards.extend(latest.causal.fields.keys().filter(|k| { let p = parts(k); p[0] == kind && p[1] == id }).cloned());
            // A later child/task added to this container must not be hidden or
            // reparented as a side effect of undoing the container's creation.
            for (child_key, writes) in &latest.causal.fields {
                let p = parts(child_key);
                let relation = if kind == "list" { "listId" } else { "parentId" };
                if p[0] == "todo" && p[2] == relation && winner(writes) == Some(&json!(id)) {
                    guards.insert(child_key.clone());
                    guards.insert(key("todo", &p[1], "exists"));
                }
            }
        }
        if kind == "todo" {
            if let Some(list_id) = desired_fields.get(&key("todo", &id, "listId")).and_then(Value::as_str) {
                guards.insert(key("list", list_id, "exists"));
            }
        }
    }
    for k in guards {
        if base.causal.fields.get(&k) != latest.causal.fields.get(&k) {
            return Err("Conflict: affected data changed on another operation; undo/edit was not applied".into());
        }
    }
    write(&mut latest.causal, delta, device);
    Ok(materialize(latest.causal, &desired.active_list_id))
}

/// Undoing a local operation creates new versions. Rebase earlier undo entries
/// only for fields actually touched by that undo, never for remote writes.
pub fn rebase_undo(expected: &mut Workspace, undone_before: &Workspace, undone_after: &Workspace, restored: &Workspace) {
    let mut touched = changes(&fields(undone_before), &fields(undone_after));
    touched.extend(changes(&fields(undone_after), &fields(undone_before)));
    let expected_values = fields(expected);
    let restored_values = fields(restored);
    for k in touched.keys() {
        if expected_values.get(k) == restored_values.get(k) {
            if let Some(writes) = restored.causal.fields.get(k) { expected.causal.fields.insert(k.clone(), writes.clone()); }
        }
    }
}

/// Device identity is local, never imported with a workspace. Sequence numbers
/// live in the atomically saved workspace clock, alongside their field writes.
pub fn device_id(path: &std::path::Path) -> Result<String, String> {
    let path = path.with_file_name("replica-id.json");
    if path.exists() {
        return serde_json::from_slice::<String>(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string());
    }
    let id = uuid::Uuid::new_v4().to_string();
    crate::vault::atomic_write(&path, &serde_json::to_vec(&id).unwrap())?;
    Ok(id)
}

pub fn backup_legacy(path: &std::path::Path, bytes: &[u8], ws: &Workspace) -> Result<(), String> {
    let backup = path.with_file_name("todos-before-causal-v2.json");
    if ws.causal.is_empty() && !backup.exists() { crate::vault::atomic_write(&backup, bytes)?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{history::History, sync_merge::{merge_workspaces, sync_revision}};

    fn base() -> Workspace {
        let mut ws: Workspace = serde_json::from_value(json!({"activeListId":"l", "lists":[
            {"id":"l","title":"Work","board":{"todos":[
                {"id":"a","title":"A","completed":false,"createdAt":9999999999999i64},
                {"id":"b","title":"B","completed":false,"createdAt":1}
            ]}}
        ]})).unwrap();
        initialize(&mut ws);
        ws
    }

    fn edit(ws: &Workspace, device: &str, f: impl FnOnce(&mut Workspace)) -> Workspace {
        let mut desired = ws.clone(); f(&mut desired);
        desired.normalize();
        commit(ws, &desired, ws, device).unwrap()
    }

    fn undo(history: &mut History, current: &Workspace, device: &str) -> Workspace {
        let target = history.target(current).unwrap();
        let saved = commit(current, &target, current, device).unwrap();
        history.did_undo(&saved);
        saved
    }

    #[test]
    fn restored_task_survives_delayed_repeated_delete_delivery_and_later_real_delete_wins() {
        let initial = base();
        let deleted = edit(&initial, "pc", |w| { w.lists[0].board.todos.remove(0); });
        let mut history = History::default(); history.record(&initial, &deleted);
        let restored = undo(&mut history, &deleted, "pc");
        assert_eq!(restored.lists[0].board.todos[0].title, "A");
        assert_eq!(restored.causal.clock["pc"], 2);
        let mut phone = merge_workspaces(&deleted, &restored);
        for _ in 0..5 { phone = merge_workspaces(&phone, &deleted); }
        assert_eq!(sync_revision(&phone), sync_revision(&restored));
        assert_eq!(sync_revision(&merge_workspaces(&deleted, &restored)), sync_revision(&merge_workspaces(&restored, &deleted)));
        let deleted_again = edit(&phone, "phone", |w| { w.lists[0].board.todos.remove(0); });
        let final_ws = merge_workspaces(&restored, &deleted_again);
        assert_eq!(final_ws.lists[0].board.todos.len(), 1);
        assert_eq!(final_ws.lists[0].board.todos[0].id, "b");
    }

    #[test]
    fn independent_fields_merge_and_local_undo_preserves_phone_changes_without_remote_history() {
        let initial = base();
        let pc = edit(&initial, "pc", |w| w.lists[0].board.todos[0].title = "PC title".into());
        let phone = edit(&initial, "phone", |w| w.lists[0].board.todos[0].completed = true);
        let mut history = History::default(); history.record(&initial, &pc);
        let merged = merge_workspaces(&pc, &phone);
        assert!(merged.lists[0].board.todos[0].completed);
        assert_eq!(merged.lists[0].board.todos[0].title, "PC title");
        assert_eq!(history.status(&merged).undo_count, 1);
        let undone = undo(&mut history, &merged, "pc");
        assert_eq!(undone.lists[0].board.todos[0].title, "A");
        assert!(undone.lists[0].board.todos[0].completed);
        assert!(!history.status(&undone).can_undo);
        assert!(!History::default().status(&merged).can_undo);
    }

    #[test]
    fn undo_rejects_later_same_field_even_when_value_returns_to_original_aba() {
        let initial = base();
        let pc = edit(&initial, "pc", |w| w.lists[0].board.todos[0].title = "PC".into());
        let mut history = History::default(); history.record(&initial, &pc);
        let phone = edit(&pc, "phone", |w| w.lists[0].board.todos[0].title = "Phone".into());
        let phone = edit(&phone, "phone", |w| w.lists[0].board.todos[0].title = "PC".into());
        assert!(history.target(&phone).unwrap_err().starts_with("Conflict:"));
        assert_eq!(history.status(&phone).undo_count, 1);
    }

    #[test]
    fn stale_ui_save_applies_only_its_delta_and_rejects_overlapping_changes() {
        let initial = base();
        let phone = edit(&initial, "phone", |w| w.lists[0].board.todos[1].title = "Phone B".into());
        let mut desired = initial.clone(); desired.lists[0].board.todos[0].title = "PC A".into();
        let saved = commit(&initial, &desired, &phone, "pc").unwrap();
        assert_eq!(saved.lists[0].board.todos[1].title, "Phone B");
        desired.lists[0].board.todos[1].title = "Overwrite".into();
        assert!(commit(&initial, &desired, &phone, "pc").is_err());
    }

    #[test]
    fn merge_is_associative_commutative_idempotent_and_preserves_concurrent_alternatives() {
        let initial = base();
        let a = edit(&initial, "a", |w| w.lists[0].board.todos[0].title = "one".into());
        let b = edit(&initial, "b", |w| w.lists[0].board.todos[0].title = "two".into());
        let c = edit(&a, "c", |w| w.lists[0].board.todos[0].title = "three".into());
        let ab = merge_workspaces(&a, &b);
        assert_eq!(ab.causal.fields[&key("todo", "a", "title")].len(), 2);
        assert_eq!(sync_revision(&ab), sync_revision(&merge_workspaces(&b, &a)));
        assert_eq!(sync_revision(&ab), sync_revision(&merge_workspaces(&ab, &ab)));
        let left = merge_workspaces(&ab, &c);
        let right = merge_workspaces(&a, &merge_workspaces(&b, &c));
        assert_eq!(sync_revision(&left), sync_revision(&right));
        let resolved = edit(&left, "pc", |w| w.lists[0].board.todos[0].title = "resolved".into());
        assert_eq!(resolved.causal.fields[&key("todo", "a", "title")].len(), 1);
        assert_eq!(sync_revision(&merge_workspaces(&resolved, &b)), sync_revision(&resolved));
    }

    #[test]
    fn serialization_restart_keeps_device_sequence_and_repeated_undo_versions() {
        let initial = base();
        let first = edit(&initial, "pc", |w| w.lists[0].board.todos[0].title = "first".into());
        let mut history = History::default(); history.record(&initial, &first);
        let second = edit(&first, "pc", |w| w.lists[0].board.todos[0].title = "second".into());
        history.record(&first, &second);
        let current: Workspace = serde_json::from_slice(&serde_json::to_vec(&second).unwrap()).unwrap();
        let current = undo(&mut history, &current, "pc");
        assert_eq!(current.lists[0].board.todos[0].title, "first");
        let current = undo(&mut history, &current, "pc");
        assert_eq!(current.lists[0].board.todos[0].title, "A");
        assert_eq!(current.causal.clock["pc"], 4);
    }

    #[test]
    fn undo_creation_cannot_delete_a_task_that_phone_has_edited() {
        let initial = base();
        let created = edit(&initial, "pc", |w| {
            let mut task = w.lists[0].board.todos[0].clone(); task.id = "new".into();
            w.lists[0].board.todos.push(task);
        });
        let mut history = History::default(); history.record(&initial, &created);
        let phone = edit(&created, "phone", |w| w.lists[0].board.todos[2].title = "Phone edited".into());
        assert!(history.target(&phone).is_err());
        let undone = undo(&mut history, &created, "pc");
        assert_eq!(merge_workspaces(&created, &undone).lists[0].board.todos.len(), 2);
    }

    #[test]
    fn undo_delete_then_undo_rename_rebases_restored_field_versions() {
        let initial = base();
        let renamed = edit(&initial, "pc", |w| w.lists[0].board.todos[0].title = "renamed".into());
        let deleted = edit(&renamed, "pc", |w| { w.lists[0].board.todos.remove(0); });
        let mut history = History::default();
        history.record(&initial, &renamed); history.record(&renamed, &deleted);
        let restored = undo(&mut history, &deleted, "pc");
        assert_eq!(restored.lists[0].board.todos[0].title, "renamed");
        let restored = undo(&mut history, &restored, "pc");
        assert_eq!(restored.lists[0].board.todos[0].title, "A");
        assert_eq!(sync_revision(&restored), sync_revision(&merge_workspaces(&restored, &deleted)));
    }

    #[test]
    fn undo_list_delete_restores_subtasks_and_does_not_depend_on_wall_clock() {
        let initial = edit(&base(), "pc", |w| {
            w.lists[0].board.todos[1].parent_id = Some("a".into());
            let mut other = w.lists[0].clone(); other.id = "other".into(); other.board.todos.clear();
            w.lists.push(other);
        });
        let deleted = edit(&initial, "pc", |w| { w.lists.remove(0); w.active_list_id = "other".into(); });
        let mut history = History::default(); history.record(&initial, &deleted);
        let restored = undo(&mut history, &deleted, "pc");
        assert_eq!(restored.lists[0].board.todos[1].parent_id.as_deref(), Some("a"));
        let mut ancient = deleted.clone();
        for list in &mut ancient.lists { list.updated_at = i64::MAX; }
        assert_eq!(sync_revision(&merge_workspaces(&restored, &ancient)), sync_revision(&restored));
    }

    #[test]
    fn undo_new_list_rejects_a_remote_task_added_inside_it() {
        let initial = base();
        let created = edit(&initial, "pc", |w| {
            let mut list = w.lists[0].clone(); list.id = "new-list".into(); list.board.todos.clear(); w.lists.push(list);
        });
        let mut history = History::default(); history.record(&initial, &created);
        let phone = edit(&created, "phone", |w| {
            let mut todo = w.lists[0].board.todos[0].clone(); todo.id = "remote-task".into(); w.lists[1].board.todos.push(todo);
        });
        assert!(history.target(&phone).is_err());
    }

    #[test]
    fn independently_deleted_task_is_not_silently_restored_by_local_undo() {
        let initial = base();
        let pc = edit(&initial, "pc", |w| { w.lists[0].board.todos.remove(0); });
        let phone = edit(&initial, "phone", |w| { w.lists[0].board.todos.remove(0); });
        let mut history = History::default(); history.record(&initial, &pc);
        assert!(history.target(&merge_workspaces(&pc, &phone)).is_err());
        let restored = undo(&mut history, &pc, "pc");
        let merged = merge_workspaces(&restored, &phone);
        assert!(merged.lists[0].board.todos.iter().all(|t| t.id != "a"));
    }

    #[test]
    fn migration_uses_legacy_versions_once_and_preserves_raw_backup() {
        let mut older = base(); older.causal = State::default();
        older.lists[0].board.todos[0].updated_at = 100;
        let mut newer = older.clone();
        newer.lists[0].board.todos[0].title = "latest legacy title".into();
        newer.lists[0].board.todos[0].updated_at = 200;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("todos.json");
        let bytes = serde_json::to_vec(&older).unwrap();
        backup_legacy(&path, &bytes, &older).unwrap();
        backup_legacy(&path, b"must not replace the backup", &newer).unwrap();
        assert_eq!(std::fs::read(dir.path().join("todos-before-causal-v2.json")).unwrap(), bytes);
        initialize(&mut older); initialize(&mut newer);
        assert_eq!(merge_workspaces(&older, &newer).lists[0].board.todos[0].title, "latest legacy title");
        let device = device_id(&path).unwrap();
        assert_eq!(device_id(&path).unwrap(), device);
    }

    #[test]
    fn placeholder_adoption_does_not_reuse_local_operation_ids() {
        let empty: Workspace = serde_json::from_value(json!({"activeListId":"", "lists":[]})).unwrap();
        let desired: Workspace = serde_json::from_value(json!({"activeListId":"fresh", "lists":[
            {"id":"fresh","title":"My todos","board":{"todos":[]}}
        ]})).unwrap();
        let fresh = commit(&empty, &desired, &empty, "pc").unwrap();
        let adopted = merge_workspaces(&fresh, &base());
        assert_eq!(adopted.lists.len(), 1);
        assert_eq!(adopted.causal.clock["pc"], 1);
        let edited = edit(&adopted, "pc", |w| w.lists[0].title = "renamed".into());
        assert_eq!(edited.causal.clock["pc"], 2);
    }

    #[test]
    fn empty_list_with_deletion_versions_is_not_a_fresh_placeholder() {
        let initial = edit(&base(), "pc", |w| w.lists[0].title = "My todos".into());
        let deleted = edit(&initial, "pc", |w| w.lists[0].board.todos.clear());
        assert!(merge_workspaces(&deleted, &initial).lists[0].board.todos.is_empty());
    }

    #[test]
    fn fallback_after_all_lists_deleted_can_be_edited_and_synchronized() {
        let deleted = edit(&base(), "pc", |w| w.lists.clear());
        assert_eq!(deleted.lists.len(), 1);
        let edited = edit(&deleted, "pc", |w| w.lists[0].title = "Recovered workspace".into());
        assert_eq!(edited.lists[0].title, "Recovered workspace");
        assert_eq!(sync_revision(&merge_workspaces(&deleted, &edited)), sync_revision(&edited));
    }
}
