use crate::{Board, Todo, TodoList, Workspace};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

const TOMBSTONE_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TITLES: [&str; 4] = ["我的待办", "My todos", "新列表", "New list"];

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(1)
}

/// Content digest independent of per-device `active_list_id`, used by LAN peers
/// to detect when two devices have already converged.
pub fn sync_revision(workspace: &Workspace) -> String {
    let payload = serde_json::json!({
        "lists": &workspace.lists,
        "deletedLists": &workspace.deleted_lists,
        "deletedTodos": &workspace.deleted_todos,
        "causal": &workspace.causal,
    });
    hex::encode(Sha256::digest(serde_json::to_vec(&payload).unwrap_or_default()))
}

/// Automatically computes per-item `updated_at`, `order`, and deletion tombstones
/// by diffing `current` against `previous` before saving to disk.
pub fn stamp_changes(previous: Option<&Workspace>, current: &mut Workspace, now: i64) {
    let mut deleted_lists = previous.map(|p| p.deleted_lists.clone()).unwrap_or_default();
    let mut deleted_todos = previous.map(|p| p.deleted_todos.clone()).unwrap_or_default();

    let current_list_ids: HashSet<&str> = current.lists.iter().map(|l| l.id.as_str()).collect();
    let current_todo_ids: HashSet<&str> = current
        .lists
        .iter()
        .flat_map(|l| l.board.todos.iter().map(|t| t.id.as_str()))
        .collect();

    let mut prev_lists: HashMap<&str, (usize, &TodoList)> = HashMap::new();
    let mut prev_todos: HashMap<&str, (usize, &Todo)> = HashMap::new();

    if let Some(prev) = previous {
        for (l_idx, list) in prev.lists.iter().enumerate() {
            if !current_list_ids.contains(list.id.as_str()) {
                let ts = now.max(list.updated_at + 1);
                deleted_lists.insert(list.id.clone(), ts);
                for todo in &list.board.todos {
                    if !current_todo_ids.contains(todo.id.as_str()) {
                        deleted_todos.insert(todo.id.clone(), now.max(todo.updated_at + 1));
                    }
                }
            } else {
                prev_lists.insert(list.id.as_str(), (l_idx, list));
                for (t_idx, todo) in list.board.todos.iter().enumerate() {
                    if !current_todo_ids.contains(todo.id.as_str()) {
                        deleted_todos.insert(todo.id.clone(), now.max(todo.updated_at + 1));
                    } else {
                        prev_todos.insert(todo.id.as_str(), (t_idx, todo));
                    }
                }
            }
        }
    }

    // Remove resurrections and prune expired tombstones (>30 days old).
    let cutoff = now.saturating_sub(TOMBSTONE_TTL_MS);
    deleted_lists.retain(|id, ts| !current_list_ids.contains(id.as_str()) && *ts >= cutoff);
    deleted_todos.retain(|id, ts| !current_todo_ids.contains(id.as_str()) && *ts >= cutoff);

    for (l_idx, list) in current.lists.iter_mut().enumerate() {
        let desired_list_order = ((l_idx as i64) + 1) * 1000;
        if let Some(&(old_idx, old_list)) = prev_lists.get(list.id.as_str()) {
            let meta_changed = list.title != old_list.title
                || list.archived != old_list.archived
                || list.color != old_list.color
                || l_idx != old_idx;
            if meta_changed {
                list.updated_at = now.max(old_list.updated_at + 1);
                list.order = desired_list_order;
            } else {
                list.updated_at = if old_list.updated_at > 0 { old_list.updated_at } else { now };
                list.order = if old_list.order > 0 { old_list.order } else { desired_list_order };
            }
        } else {
            if list.updated_at <= 0 {
                list.updated_at = now;
            }
            if list.order <= 0 {
                list.order = desired_list_order;
            }
        }

        for (t_idx, todo) in list.board.todos.iter_mut().enumerate() {
            let desired_todo_order = ((t_idx as i64) + 1) * 1000;
            if let Some(&(old_t_idx, old_todo)) = prev_todos.get(todo.id.as_str()) {
                let changed = todo.title != old_todo.title
                    || todo.completed != old_todo.completed
                    || todo.parent_id != old_todo.parent_id
                    || t_idx != old_t_idx;
                if changed {
                    todo.updated_at = now.max(old_todo.updated_at + 1);
                    todo.order = desired_todo_order;
                } else {
                    todo.updated_at = if old_todo.updated_at > 0 {
                        old_todo.updated_at
                    } else {
                        todo.created_at.max(1)
                    };
                    todo.order = if old_todo.order > 0 { old_todo.order } else { desired_todo_order };
                }
            } else {
                if todo.updated_at <= 0 {
                    todo.updated_at = now.max(todo.created_at).max(1);
                }
                if todo.order <= 0 {
                    todo.order = desired_todo_order;
                }
            }
        }
    }

    current.deleted_lists = deleted_lists;
    current.deleted_todos = deleted_todos;
}

fn is_untouched_placeholder(ws: &Workspace) -> bool {
    !crate::causal::has_retained_data(ws)
        && ws.deleted_lists.is_empty()
        && ws.deleted_todos.is_empty()
        && ws.lists.len() == 1
        && !ws.lists[0].archived
        && ws.lists[0].board.todos.is_empty()
        && DEFAULT_TITLES.contains(&ws.lists[0].title.as_str())
}

fn has_meaningful_data(ws: &Workspace) -> bool {
    crate::causal::has_retained_data(ws)
        || !ws.deleted_lists.is_empty()
        || !ws.deleted_todos.is_empty()
        || ws.lists.len() > 1
        || ws.lists.iter().any(|l| {
            l.archived || !l.board.todos.is_empty() || !DEFAULT_TITLES.contains(&l.title.as_str())
        })
}

fn effective_todo_ts(todo: &Todo) -> i64 {
    if todo.updated_at > 0 {
        todo.updated_at
    } else {
        todo.created_at.max(1)
    }
}

fn effective_list_ts(list: &TodoList) -> i64 {
    let max_todo = list
        .board
        .todos
        .iter()
        .map(effective_todo_ts)
        .max()
        .unwrap_or(0);
    list.updated_at.max(max_todo).max(1)
}

fn pick_todo<'a>(a: &'a Todo, b: &'a Todo) -> &'a Todo {
    let key_a = (
        effective_todo_ts(a),
        a.completed,
        a.order,
        &a.title,
        &a.parent_id,
    );
    let key_b = (
        effective_todo_ts(b),
        b.completed,
        b.order,
        &b.title,
        &b.parent_id,
    );
    if key_a >= key_b { a } else { b }
}

fn pick_list_meta<'a>(a: &'a TodoList, b: &'a TodoList) -> &'a TodoList {
    let key_a = (
        a.updated_at.max(1),
        a.archived,
        a.order,
        &a.title,
        &a.color,
    );
    let key_b = (
        b.updated_at.max(1),
        b.archived,
        b.order,
        &b.title,
        &b.color,
    );
    if key_a >= key_b { a } else { b }
}

fn merge_todos(
    local_todos: &[Todo],
    remote_todos: &[Todo],
    deleted_todos: &mut BTreeMap<String, i64>,
) -> Board {
    let mut map_a: HashMap<&str, (usize, &Todo)> = HashMap::new();
    let mut map_b: HashMap<&str, (usize, &Todo)> = HashMap::new();
    let mut all_ids: Vec<&str> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();

    for (idx, t) in local_todos.iter().enumerate() {
        map_a.insert(t.id.as_str(), (idx, t));
        if seen.insert(t.id.as_str()) {
            all_ids.push(t.id.as_str());
        }
    }
    for (idx, t) in remote_todos.iter().enumerate() {
        map_b.insert(t.id.as_str(), (idx, t));
        if seen.insert(t.id.as_str()) {
            all_ids.push(t.id.as_str());
        }
    }

    let mut merged: Vec<Todo> = Vec::new();
    for id in all_ids {
        let chosen = match (map_a.get(id), map_b.get(id)) {
            (Some(&(idx_a, a)), Some(&(idx_b, b))) => {
                let mut w = pick_todo(a, b).clone();
                if w.order <= 0 {
                    w.order = ((idx_a.min(idx_b) as i64) + 1) * 1000;
                }
                if w.updated_at <= 0 {
                    w.updated_at = effective_todo_ts(&w);
                }
                w
            }
            (Some(&(idx_a, a)), None) => {
                let mut w = a.clone();
                if w.order <= 0 {
                    w.order = ((idx_a as i64) + 1) * 1000;
                }
                if w.updated_at <= 0 {
                    w.updated_at = effective_todo_ts(&w);
                }
                w
            }
            (None, Some(&(idx_b, b))) => {
                let mut w = b.clone();
                if w.order <= 0 {
                    w.order = ((idx_b as i64) + 1) * 1000;
                }
                if w.updated_at <= 0 {
                    w.updated_at = effective_todo_ts(&w);
                }
                w
            }
            (None, None) => unreachable!(),
        };

        if let Some(&del_ts) = deleted_todos.get(id) {
            if del_ts >= effective_todo_ts(&chosen) {
                continue;
            }
            deleted_todos.remove(id);
        }
        merged.push(chosen);
    }

    merged.sort_by(|a, b| {
        a.order
            .cmp(&b.order)
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });

    // Normalize order spacing deterministically so future merges remain clean.
    for (idx, todo) in merged.iter_mut().enumerate() {
        todo.order = ((idx as i64) + 1) * 1000;
    }

    let mut board = Board { todos: merged };
    board.normalize();
    board
}

/// Deterministic, commutative LWW state merge between `local` and `remote`.
/// Preserves `local.active_list_id` when still open, while converging all list
/// and task contents identically on both peers.
pub fn merge_workspaces(local: &Workspace, remote: &Workspace) -> Workspace {
    // Handle fresh-install placeholder adoption cleanly.
    if is_untouched_placeholder(local) && has_meaningful_data(remote) {
        let mut adopted = remote.clone();
        crate::causal::observe_clock(&mut adopted, local);
        adopted.normalize();
        ensure_open_list(&mut adopted, &remote.active_list_id);
        return adopted;
    }
    if is_untouched_placeholder(remote) && has_meaningful_data(local) {
        let mut kept = local.clone();
        crate::causal::observe_clock(&mut kept, remote);
        kept.normalize();
        ensure_open_list(&mut kept, &local.active_list_id);
        return kept;
    }

    if !local.causal.is_empty() || !remote.causal.is_empty() {
        let mut local = local.clone();
        let mut remote = remote.clone();
        crate::causal::initialize(&mut local);
        crate::causal::initialize(&mut remote);
        return crate::causal::materialize(crate::causal::merge(&local.causal, &remote.causal), &local.active_list_id);
    }

    let mut deleted_lists = local.deleted_lists.clone();
    for (k, &v) in &remote.deleted_lists {
        deleted_lists
            .entry(k.clone())
            .and_modify(|cur| *cur = (*cur).max(v))
            .or_insert(v);
    }

    let mut deleted_todos = local.deleted_todos.clone();
    for (k, &v) in &remote.deleted_todos {
        deleted_todos
            .entry(k.clone())
            .and_modify(|cur| *cur = (*cur).max(v))
            .or_insert(v);
    }

    let mut map_a: HashMap<&str, (usize, &TodoList)> = HashMap::new();
    let mut map_b: HashMap<&str, (usize, &TodoList)> = HashMap::new();
    let mut all_list_ids: Vec<&str> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();

    for (idx, l) in local.lists.iter().enumerate() {
        map_a.insert(l.id.as_str(), (idx, l));
        if seen.insert(l.id.as_str()) {
            all_list_ids.push(l.id.as_str());
        }
    }
    for (idx, l) in remote.lists.iter().enumerate() {
        map_b.insert(l.id.as_str(), (idx, l));
        if seen.insert(l.id.as_str()) {
            all_list_ids.push(l.id.as_str());
        }
    }

    let mut merged_lists: Vec<TodoList> = Vec::new();
    for id in all_list_ids {
        let candidate = match (map_a.get(id), map_b.get(id)) {
            (Some(&(idx_a, a)), Some(&(idx_b, b))) => {
                let meta = pick_list_meta(a, b);
                let board = merge_todos(&a.board.todos, &b.board.todos, &mut deleted_todos);
                TodoList {
                    id: meta.id.clone(),
                    title: meta.title.clone(),
                    board,
                    archived: meta.archived,
                    color: meta.color.clone().or_else(|| a.color.clone()).or_else(|| b.color.clone()),
                    updated_at: a.updated_at.max(b.updated_at).max(1),
                    order: if meta.order > 0 {
                        meta.order
                    } else {
                        ((idx_a.min(idx_b) as i64) + 1) * 1000
                    },
                }
            }
            (Some(&(idx_a, a)), None) => {
                let board = merge_todos(&a.board.todos, &[], &mut deleted_todos);
                TodoList {
                    id: a.id.clone(),
                    title: a.title.clone(),
                    board,
                    archived: a.archived,
                    color: a.color.clone(),
                    updated_at: effective_list_ts(a),
                    order: if a.order > 0 { a.order } else { ((idx_a as i64) + 1) * 1000 },
                }
            }
            (None, Some(&(idx_b, b))) => {
                let board = merge_todos(&[], &b.board.todos, &mut deleted_todos);
                TodoList {
                    id: b.id.clone(),
                    title: b.title.clone(),
                    board,
                    archived: b.archived,
                    color: b.color.clone(),
                    updated_at: effective_list_ts(b),
                    order: if b.order > 0 { b.order } else { ((idx_b as i64) + 1) * 1000 },
                }
            }
            (None, None) => unreachable!(),
        };

        let list_ts = effective_list_ts(&candidate);
        if let Some(&del_ts) = deleted_lists.get(id) {
            if del_ts >= list_ts {
                continue;
            }
            deleted_lists.remove(id);
        }
        merged_lists.push(candidate);
    }

    merged_lists.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    for (idx, list) in merged_lists.iter_mut().enumerate() {
        list.order = ((idx as i64) + 1) * 1000;
    }

    let mut result = Workspace {
        causal: Default::default(),
        lists: merged_lists,
        active_list_id: local.active_list_id.clone(),
        deleted_todos,
        deleted_lists,
    };
    ensure_open_list(&mut result, &local.active_list_id);
    result
}

pub(crate) fn ensure_open_list(workspace: &mut Workspace, preferred_active_id: &str) {
    if workspace.lists.is_empty() {
        let id = "default-list".to_string();
        workspace.lists.push(TodoList {
            id: id.clone(),
            title: "My todos".to_string(),
            board: Board::default(),
            archived: false,
            color: Some("yellow".to_string()),
            updated_at: 1,
            order: 1000,
        });
        workspace.active_list_id = id;
        return;
    }
    if !workspace.lists.iter().any(|l| !l.archived) {
        // Deterministically reopen the most recently updated list so both peers match.
        let reopen_idx = workspace
            .lists
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.updated_at.cmp(&b.updated_at).then_with(|| a.id.cmp(&b.id)))
            .map(|(i, _)| i)
            .unwrap_or(0);
        workspace.lists[reopen_idx].archived = false;
    }
    if workspace
        .lists
        .iter()
        .any(|l| l.id == preferred_active_id && !l.archived)
    {
        workspace.active_list_id = preferred_active_id.to_string();
    } else if let Some(first_open) = workspace.lists.iter().find(|l| !l.archived) {
        workspace.active_list_id = first_open.id.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_ws() -> Workspace {
        let mut ws: Workspace = serde_json::from_value(json!({
            "activeListId": "list-1",
            "lists": [{
                "id": "list-1",
                "title": "Trip",
                "color": "blue",
                "board": {
                    "todos": [
                        {"id": "p1", "title": "Pack", "completed": false, "createdAt": 100, "parentId": null},
                        {"id": "c1", "title": "Shirts", "completed": false, "createdAt": 101, "parentId": "p1"},
                        {"id": "c2", "title": "Brush", "completed": false, "createdAt": 102, "parentId": "p1"}
                    ]
                }
            }]
        }))
        .unwrap();
        stamp_changes(None, &mut ws, 1000);
        ws
    }

    #[test]
    fn concurrent_subtask_completions_merge_and_complete_parent_commutatively() {
        let base = sample_ws();

        // Desktop completes c1 at t=2000
        let mut desktop = base.clone();
        desktop.lists[0].board.todos[1].completed = true;
        desktop.normalize();
        stamp_changes(Some(&base), &mut desktop, 2000);

        // Mobile completes c2 and adds c3 (already completed) at t=2500
        let mut mobile = base.clone();
        mobile.lists[0].board.todos[2].completed = true;
        mobile.lists[0].board.todos.push(Todo {
            id: "c3".into(),
            title: "Sunglasses".into(),
            completed: true,
            created_at: 2500,
            parent_id: Some("p1".into()),
            updated_at: 0,
            order: 0,
        });
        mobile.normalize();
        stamp_changes(Some(&base), &mut mobile, 2500);

        let ab = merge_workspaces(&desktop, &mobile);
        let ba = merge_workspaces(&mobile, &desktop);
        assert_eq!(sync_revision(&ab), sync_revision(&ba));
        assert_eq!(ab.lists[0].board.todos.len(), 4);
        // All children (c1, c2, c3) are now completed, so p1 automatically completes!
        assert!(ab.lists[0].board.todos.iter().all(|t| t.completed));
    }

    #[test]
    fn tombstones_prevent_deleted_tasks_and_lists_from_resurrecting() {
        let base = sample_ws();

        // Desktop deletes c2 at t=3000
        let mut desktop = base.clone();
        desktop.lists[0].board.todos.retain(|t| t.id != "c2");
        stamp_changes(Some(&base), &mut desktop, 3000);
        assert!(desktop.deleted_todos.contains_key("c2"));

        // Mobile renames c1 at t=2500 (still has untouched c2 from t=1000)
        let mut mobile = base.clone();
        mobile.lists[0].board.todos[1].title = "3 Shirts".into();
        stamp_changes(Some(&base), &mut mobile, 2500);

        let merged = merge_workspaces(&mobile, &desktop);
        let ids: Vec<&str> = merged.lists[0].board.todos.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["p1", "c1"]);
        assert_eq!(merged.lists[0].board.todos[1].title, "3 Shirts");
    }

    #[test]
    fn conflicting_concurrent_reparenting_cycles_are_healed_deterministically() {
        let mut base: Workspace = serde_json::from_value(json!({
            "activeListId": "l1",
            "lists": [{
                "id": "l1",
                "title": "Work",
                "board": {
                    "todos": [
                        {"id": "a", "title": "Task A", "completed": false, "createdAt": 10, "parentId": null},
                        {"id": "b", "title": "Task B", "completed": false, "createdAt": 20, "parentId": null}
                    ]
                }
            }]
        }))
        .unwrap();
        stamp_changes(None, &mut base, 100);

        // Desktop nests A under B
        let mut desktop = base.clone();
        desktop.lists[0].board.todos[0].parent_id = Some("b".into());
        stamp_changes(Some(&base), &mut desktop, 200);

        // Mobile nests B under A
        let mut mobile = base.clone();
        mobile.lists[0].board.todos[1].parent_id = Some("a".into());
        stamp_changes(Some(&base), &mut mobile, 300);

        let ab = merge_workspaces(&desktop, &mobile);
        let ba = merge_workspaces(&mobile, &desktop);
        assert_eq!(sync_revision(&ab), sync_revision(&ba));
        // Cycle broken cleanly without panic or infinite loop
        let parent_count = ab.lists[0]
            .board
            .todos
            .iter()
            .filter(|t| t.parent_id.is_some())
            .count();
        assert!(parent_count <= 1);
    }

    #[test]
    fn fresh_mobile_placeholder_workspace_adopts_populated_desktop_workspace() {
        let desktop = sample_ws();
        let mobile: Workspace = serde_json::from_value(json!({
            "activeListId": "fresh-id",
            "lists": [{
                "id": "fresh-id",
                "title": "我的待办",
                "color": "yellow",
                "board": { "todos": [] }
            }]
        }))
        .unwrap();

        let merged_on_mobile = merge_workspaces(&mobile, &desktop);
        let merged_on_desktop = merge_workspaces(&desktop, &mobile);
        assert_eq!(merged_on_mobile.lists.len(), 1);
        assert_eq!(merged_on_mobile.lists[0].id, "list-1");
        assert_eq!(sync_revision(&merged_on_mobile), sync_revision(&merged_on_desktop));
    }
}
