use crate::Workspace;
use serde::Serialize;
use std::{collections::VecDeque, sync::Mutex};

const LIMIT: usize = 20;

#[derive(Default)]
pub struct History {
    past: VecDeque<(Workspace, Workspace)>,
}

#[derive(Default)]
pub struct HistoryRuntime(pub Mutex<History>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub can_undo: bool, pub undo_count: usize }

impl History {
    pub fn clear(&mut self) { self.past.clear(); }

    pub fn status(&self, _current: &Workspace) -> Status {
        let count = self.past.len();
        Status { can_undo: count > 0, undo_count: count }
    }

    // Call only after the new board is durably saved. Navigation is not an edit.
    pub fn record(&mut self, before: &Workspace, after: &Workspace) {
        if crate::causal::fields(before) == crate::causal::fields(after) { return; }
        let mut before = before.clone();
        let mut after = after.clone();
        crate::causal::initialize(&mut before);
        crate::causal::initialize(&mut after);
        self.past.push_back((before, after));
        if self.past.len() > LIMIT { self.past.pop_front(); }
    }

    // Looking up a target does not consume it: failed writes can be retried.
    pub fn target(&self, current: &Workspace) -> Result<Workspace, String> {
        if !self.status(current).can_undo { return Err("Nothing to undo".into()); }
        let (before, after) = self.past.back().unwrap();
        let mut desired = before.clone();
        desired.active_list_id = current.active_list_id.clone();
        let target = crate::causal::commit(after, &desired, current, "undo-preview")?;
        Ok(target)
    }

    pub fn did_undo(&mut self, target: &Workspace) {
        if let Some((before, after)) = self.past.pop_back() {
            for (_, expected) in &mut self.past {
                crate::causal::rebase_undo(expected, &before, &after, target);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workspace(title: &str) -> Workspace {
        serde_json::from_value(json!({"activeListId":"a","lists":[{"id":"a","title":title,"board":{"todos":[]}},{"id":"b","title":"Other","board":{"todos":[]}}]})).unwrap()
    }

    fn edit(before: &Workspace, title: &str) -> Workspace {
        let mut desired = before.clone();
        desired.lists[0].title = title.into();
        crate::causal::commit(before, &desired, before, "pc").unwrap()
    }

    fn undo(history: &mut History, current: &Workspace) -> Workspace {
        let desired = history.target(current).unwrap();
        let saved = crate::causal::commit(current, &desired, current, "pc").unwrap();
        history.did_undo(&saved);
        saved
    }

    #[test]
    fn retains_exactly_twenty_successful_operations_in_reverse_order() {
        let mut history = History::default();
        let mut current = workspace("0");
        for i in 1..=25 {
            let next = edit(&current, &i.to_string());
            history.record(&current, &next);
            current = next;
        }
        assert_eq!(history.status(&current).undo_count, 20);
        for i in (5..25).rev() {
            let target = undo(&mut history, &current);
            assert_eq!(target.lists[0].title, i.to_string());
            current = target;
        }
        assert!(!history.status(&current).can_undo);
    }

    #[test]
    fn navigation_does_not_record_or_invalidate_history_and_lookup_does_not_consume() {
        let before = workspace("Before");
        let after = edit(&before, "After");
        let mut history = History::default();
        history.record(&before, &after);
        let mut navigated = after.clone();
        navigated.active_list_id = "b".into();
        history.record(&after, &navigated);
        assert_eq!(history.status(&navigated).undo_count, 1);
        // A failed persistence attempt never calls did_undo.
        assert_eq!(crate::causal::fields(&history.target(&navigated).unwrap()), crate::causal::fields(&before));
        assert_eq!(history.target(&navigated).unwrap().active_list_id, "b");
        let external = edit(&after, "Untracked external edit");
        assert!(history.target(&external).is_err());
    }

    #[test]
    fn manual_agent_and_new_edits_after_undo_share_one_history_and_clear_releases_it() {
        let mut history = History::default();
        let initial = workspace("Initial");
        let manual = edit(&initial, "Manual");
        let agent = edit(&manual, "Agent");
        history.record(&initial, &manual);
        history.record(&manual, &agent);
        let target = undo(&mut history, &agent);
        assert_eq!(crate::causal::fields(&target), crate::causal::fields(&manual));
        let edited_again = edit(&target, "Another edit");
        history.record(&target, &edited_again);
        let target = undo(&mut history, &edited_again);
        assert_eq!(crate::causal::fields(&history.target(&target).unwrap()), crate::causal::fields(&initial));
        history.clear();
        assert!(history.target(&target).is_err());
        assert!(history.past.is_empty());
    }
}
