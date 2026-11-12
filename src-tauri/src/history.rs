use crate::Workspace;
use serde::Serialize;
use std::{collections::VecDeque, sync::Mutex};

const LIMIT: usize = 20;

#[derive(Default)]
pub struct History {
    past: VecDeque<Workspace>,
    latest: Option<Workspace>,
}

#[derive(Default)]
pub struct HistoryRuntime(pub Mutex<History>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status { pub can_undo: bool, pub undo_count: usize }

impl History {
    pub fn clear(&mut self) { self.past.clear(); self.latest = None; }

    pub fn status(&self, current: &Workspace) -> Status {
        let count = if self.latest.as_ref().is_some_and(|latest| latest.lists == current.lists) { self.past.len() } else { 0 };
        Status { can_undo: count > 0, undo_count: count }
    }

    // Call only after the new board is durably saved. Navigation is not an edit.
    pub fn record(&mut self, before: &Workspace, after: &Workspace) {
        if before.lists == after.lists { return; }
        if self.latest.as_ref().is_some_and(|latest| latest.lists != before.lists) { self.clear(); }
        self.past.push_back(before.clone());
        if self.past.len() > LIMIT { self.past.pop_front(); }
        self.latest = Some(after.clone());
    }

    // Looking up a target does not consume it: failed writes can be retried.
    pub fn target(&self, current: &Workspace) -> Result<Workspace, String> {
        if !self.status(current).can_undo { return Err("Nothing to undo".into()); }
        Ok(self.past.back().unwrap().clone())
    }

    pub fn did_undo(&mut self, target: &Workspace) {
        self.past.pop_back();
        self.latest = if self.past.is_empty() { None } else { Some(target.clone()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn workspace(title: &str) -> Workspace {
        serde_json::from_value(json!({"activeListId":"a","lists":[{"id":"a","title":title,"board":{"todos":[]}},{"id":"b","title":"Other","board":{"todos":[]}}]})).unwrap()
    }

    #[test]
    fn retains_exactly_twenty_successful_operations_in_reverse_order() {
        let mut history = History::default();
        let mut current = workspace("0");
        for i in 1..=25 {
            let next = workspace(&i.to_string());
            history.record(&current, &next);
            current = next;
        }
        assert_eq!(history.status(&current).undo_count, 20);
        for i in (5..25).rev() {
            let target = history.target(&current).unwrap();
            assert_eq!(target.lists[0].title, i.to_string());
            history.did_undo(&target);
            current = target;
        }
        assert!(!history.status(&current).can_undo);
    }

    #[test]
    fn navigation_does_not_record_or_invalidate_history_and_lookup_does_not_consume() {
        let before = workspace("Before");
        let mut after = workspace("After");
        let mut history = History::default();
        history.record(&before, &after);
        let mut navigated = after.clone();
        navigated.active_list_id = "b".into();
        history.record(&after, &navigated);
        assert_eq!(history.status(&navigated).undo_count, 1);
        // A failed persistence attempt never calls did_undo.
        assert_eq!(history.target(&navigated).unwrap(), before);
        assert_eq!(history.target(&navigated).unwrap(), before);
        after.lists[0].title = "Untracked external edit".into();
        assert!(history.target(&after).is_err());
    }

    #[test]
    fn manual_agent_and_new_edits_after_undo_share_one_history_and_clear_releases_it() {
        let mut history = History::default();
        let initial = workspace("Initial");
        let manual = workspace("Manual");
        let agent = workspace("Agent");
        history.record(&initial, &manual);
        history.record(&manual, &agent);
        let target = history.target(&agent).unwrap();
        assert_eq!(target, manual);
        history.did_undo(&target);
        let edited_again = workspace("Another edit");
        history.record(&target, &edited_again);
        let target = history.target(&edited_again).unwrap();
        history.did_undo(&target);
        assert_eq!(history.target(&target).unwrap(), initial);
        history.clear();
        assert!(history.target(&target).is_err());
        assert!(history.latest.is_none());
        assert!(history.past.is_empty());
    }
}
