import { test } from "node:test";
import assert from "node:assert/strict";
import { TextHistory, WorkspaceHistory } from "../src/history.ts";
import { addList, addTodo, createWorkspace, deleteList, toggleTodo } from "../src/board.ts";

test("workspace history retains the last 20 edits, ignores navigation and supports repeated undo", () => {
  const history = new WorkspaceHistory();
  let current = createWorkspace("0");
  addList(current, "Other");
  for (let i = 1; i <= 25; i++) {
    const next = structuredClone(current);
    next.lists[0].title = String(i);
    history.record(current, next);
    current = next;
  }
  const navigated = structuredClone(current);
  navigated.activeListId = navigated.lists[1].id;
  history.record(current, navigated);
  current = navigated;
  assert.equal(history.status(current).undoCount, 20);
  for (let i = 24; i >= 5; i--) {
    const target = history.target(current);
    assert.equal(target.lists[0].title, String(i));
    history.didUndo(target);
    current = target;
  }
  assert.equal(history.target(current), null);
});

test("one undo restores parent/child completion and a deleted list with original IDs", () => {
  const history = new WorkspaceHistory();
  const before = createWorkspace("Travel");
  const parent = addTodo(before.lists[0].board, "Pack");
  addTodo(before.lists[0].board, "Shirts", parent.id);
  addTodo(before.lists[0].board, "Brush", parent.id);
  const checked = structuredClone(before);
  toggleTodo(checked.lists[0].board, parent.id);
  history.record(before, checked);
  const deleted = structuredClone(checked);
  deleteList(deleted, deleted.activeListId);
  history.record(checked, deleted);
  const restored = history.target(deleted);
  assert.deepEqual(restored, checked);
  history.didUndo(restored);
  assert.deepEqual(history.target(restored), before);
});

test("failed persistence leaves the undo target available, successful new edits branch correctly, clear drops all snapshots", () => {
  const history = new WorkspaceHistory();
  const before = createWorkspace("Before");
  const after = structuredClone(before);
  after.lists[0].title = "After";
  history.record(before, after);
  const target = history.target(after);
  target.lists[0].title = "Mutating a candidate must not mutate stored history";
  assert.deepEqual(history.target(after), before);
  assert.equal(history.status(after).undoCount, 1);
  history.didUndo(before);
  const another = structuredClone(before);
  another.lists[0].title = "Another edit";
  history.record(before, another);
  assert.deepEqual(history.target(another), before);
  history.clear();
  assert.deepEqual(history.status(another), { canUndo: false, undoCount: 0 });
});

const state = (value, start = value.length, end = start) => ({ value, start, end });

test("text undo groups adjacent typing but separates pastes and restores selections", () => {
  const history = new TextHistory(state(""));
  history.beforeInput(state(""));
  history.input(state("a"), "insertText", 100);
  history.beforeInput(state("a"));
  history.input(state("ab"), "insertText", 200);
  history.beforeInput(state("ab", 0, 2));
  history.input(state("Pasted"), "insertFromPaste", 300);
  assert.deepEqual(history.undo("Pasted"), state("ab", 0, 2));
  assert.deepEqual(history.undo("ab"), state(""));
  assert.equal(history.undo(""), null);
});

test("typing after a pause or caret move starts a new text undo group", () => {
  const history = new TextHistory(state("a"));
  history.beforeInput(state("a"));
  history.input(state("ab"), "insertText", 100);
  history.beforeInput(state("ab"));
  history.input(state("abc"), "insertText", 2000);
  history.beforeInput(state("abc", 0));
  history.input(state("Xabc", 1), "insertText", 2100);
  assert.deepEqual(history.undo("Xabc"), state("abc", 0));
  assert.deepEqual(history.undo("abc"), state("ab"));
  assert.deepEqual(history.undo("ab"), state("a"));
});

test("local text undo handles input without beforeinput and never replays stale programmatic values", () => {
  const history = new TextHistory(state("Before"));
  history.input(state("After"), "insertText", 100);
  assert.deepEqual(history.undo("After"), state("Before"));
  history.input(state("New"), "insertText", 200);
  assert.equal(history.undo("Programmatically replaced"), null);
});
