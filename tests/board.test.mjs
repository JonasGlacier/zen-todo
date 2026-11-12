import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTE_COLORS, addList, addSibling, addTodo, archiveList, ensureColors, nextColor, setListColor, canNest, canMove, countSubtasks, createList, createWorkspace, deleteList, indentTodo,
  nestTodo, moveTodo, normalize, orderedTodos, outdentTodo, reconcile, removeTodo, restoreList, toggleTodo,
} from "../src/board.ts";

// edges: [child, parent]; each task belongs to at most one parent.
function fixture(edges, extra = []) {
  const ids = [...new Set([...edges.flat(), ...extra])];
  const todos = ids.map((id) => ({ id, title: id, completed: false, createdAt: 0, parentId: null }));
  for (const [child, parent] of edges) todos.find((todo) => todo.id === child).parentId = parent;
  return { todos };
}
const get = (board, id) => board.todos.find((todo) => todo.id === id);
const done = (board, id) => get(board, id).completed;

test("completing every subtask automatically completes its parent", () => {
  const board = fixture([["A", "C"], ["B", "C"]]);
  toggleTodo(board, "A");
  assert.equal(done(board, "C"), false);
  toggleTodo(board, "B");
  assert.equal(done(board, "C"), true);
});

test("toggling a parent updates its whole subtree, not other roots", () => {
  const board = fixture([["A", "B"], ["B", "C"], ["X", "C"]], ["Z"]);
  toggleTodo(board, "C");
  assert.deepEqual(["A", "B", "C", "X", "Z"].map((id) => done(board, id)), [true, true, true, true, false]);
  toggleTodo(board, "C");
  assert.ok(board.todos.every((todo) => !todo.completed));
});

test("unchecking a subtask reopens ancestors while preserving sibling completion", () => {
  const board = fixture([["A", "B"], ["B", "C"], ["X", "C"]]);
  toggleTodo(board, "C");
  assert.equal(toggleTodo(board, "A"), 2);
  assert.deepEqual(["A", "B", "C", "X"].map((id) => done(board, id)), [false, false, false, true]);
});

test("nesting reparents a task", () => {
  const board = fixture([["A", "B"]], ["C"]);
  assert.equal(nestTodo(board, "A", "C"), true);
  assert.equal(get(board, "A").parentId, "C");
  assert.equal(nestTodo(board, "A", "C"), false);
});

test("self-links and cycles are rejected", () => {
  const board = fixture([["A", "B"], ["B", "C"]]);
  assert.equal(canNest(board, "A", "A"), false);
  assert.equal(canNest(board, "C", "A"), false);
  assert.equal(canNest(board, "C", "B"), false);
  assert.equal(canNest(board, "missing", "A"), false);
  assert.equal(canNest(board, "A", "C"), true);
});

test("nesting an unfinished task reopens its parent and ancestors", () => {
  const board = fixture([["A", "B"]], ["X"]);
  toggleTodo(board, "B");
  assert.equal(nestTodo(board, "X", "A"), true);
  assert.deepEqual(["A", "B"].map((id) => done(board, id)), [false, false]);
});

test("a new subtask reopens a completed parent", () => {
  const board = fixture([["A", "B"]]);
  toggleTodo(board, "B");
  const added = addTodo(board, "new", "B");
  assert.equal(added.parentId, "B");
  assert.equal(done(board, "B"), false);
});

test("addSibling shares the parent and follows the source", () => {
  const board = fixture([["A", "C"]], ["Z"]);
  board.todos.push({ id: "D", title: "", completed: false, createdAt: 0, parentId: null });
  const sibling = addSibling(board, "A");
  assert.equal(sibling.parentId, "C");
  assert.deepEqual(board.todos.map((todo) => todo.id).slice(0, 3), ["A", sibling.id, "C"]);
  assert.equal(addSibling(board, "missing"), undefined);
});

test("deleting a parent preserves and promotes its subtasks in place", () => {
  const board = fixture([["A", "B"], ["X", "B"], ["B", "C"]]);
  removeTodo(board, "B");
  assert.equal(get(board, "A").parentId, "C");
  assert.equal(get(board, "X").parentId, "C");
  assert.deepEqual(orderedTodos(board).map((todo) => todo.id), ["C", "A", "X"]);
  removeTodo(board, "C");
  assert.equal(get(board, "A").parentId, null);
  assert.equal(board.todos.length, 2);
});

test("removing the last unfinished subtask completes its parent", () => {
  const board = fixture([["A", "B"], ["X", "B"]]);
  toggleTodo(board, "A");
  removeTodo(board, "X");
  assert.equal(done(board, "B"), true);
});

test("Tab nests under the preceding sibling; outdent follows the former parent", () => {
  const board = fixture([["A", "R"], ["B", "R"]]);
  assert.equal(indentTodo(board, "A"), false);
  assert.equal(indentTodo(board, "B"), true);
  assert.equal(get(board, "B").parentId, "A");
  assert.equal(outdentTodo(board, "B"), true);
  assert.equal(get(board, "B").parentId, "R");
  assert.deepEqual(orderedTodos(board).map((todo) => todo.id), ["R", "A", "B"]);
  assert.equal(outdentTodo(board, "R"), false);
});

test("moving relative to a target changes order and parent, but never into its own subtree", () => {
  const board = fixture([["A", "B"], ["B", "C"]], ["X"]);
  assert.equal(moveTodo(board, "X", "A", "before"), true);
  assert.equal(get(board, "X").parentId, "B");
  assert.equal(board.todos[0].id, "X");
  assert.equal(moveTodo(board, "X", "C", "after"), true);
  assert.equal(get(board, "X").parentId, null);
  assert.equal(board.todos.at(-1).id, "X");
  assert.equal(canMove(board, "C", "A", "into"), false);
  assert.equal(canMove(board, "C", "A", "before"), false);
  assert.equal(moveTodo(board, "A", "X", "into"), true);
  assert.equal(get(board, "A").parentId, "X");
  assert.equal(countSubtasks(board, "X"), 1);
});

test("normalize repairs missing, self and cyclic references", () => {
  const board = fixture([["A", "B"]]);
  get(board, "B").parentId = "A";
  board.todos.push({ id: "S", title: "", completed: true, createdAt: 0, parentId: "S" });
  board.todos.push({ id: "M", title: "", completed: false, createdAt: 0, parentId: "gone" });
  board.todos.push({ id: "U", title: "", completed: false, createdAt: 0 });
  normalize(board);
  assert.equal(get(board, "S").parentId, null);
  assert.equal(get(board, "M").parentId, null);
  assert.equal(get(board, "U").parentId, null);
  assert.equal(board.todos.filter((todo) => ["A", "B"].includes(todo.id) && todo.parentId).length, 1);
});

test("reconcile derives parent completion in any storage order", () => {
  const board = fixture([["A", "B"], ["B", "C"]]);
  board.todos.forEach((todo) => { todo.completed = todo.id !== "A"; });
  assert.equal(reconcile(board), 2);
  get(board, "A").completed = true;
  reconcile(board);
  assert.ok(board.todos.every((todo) => todo.completed));
});

test("legacy saved relationships migrate once without losing task identity or nesting", () => {
  const board = { todos: [
    { id: "parent", title: "Pack", completed: false, createdAt: 123, nextId: null },
    { id: "child", title: "Shirts", completed: true, createdAt: 456, nextId: "parent" },
    { id: "modern", title: "Root", completed: false, createdAt: 789, parentId: null, nextId: "parent" },
  ] };
  assert.equal(normalize(board), true);
  assert.equal(get(board, "child").parentId, "parent");
  assert.equal(get(board, "modern").parentId, null);
  assert.equal(get(board, "child").createdAt, 456);
  assert.ok(board.todos.every((todo) => !("nextId" in todo)));
  assert.deepEqual(orderedTodos(board).map((todo) => todo.title), ["Pack", "Shirts", "Root"]);
  assert.equal(done(board, "parent"), true);
  assert.equal(normalize(board), false);
});

test("moving a parent carries its descendants and preserves nested display order", () => {
  const board = fixture([["child", "parent"], ["grandchild", "child"]], ["other"]);
  assert.equal(moveTodo(board, "parent", "other", "into"), true);
  assert.deepEqual(orderedTodos(board).map((todo) => todo.id), ["other", "parent", "child", "grandchild"]);
  assert.equal(canMove(board, "other", "grandchild", "after"), false);
});

test("archiving keeps the list, selects a remaining list and can be restored", () => {
  const workspace = createWorkspace();
  const first = workspace.lists[0];
  const second = createList("工作");
  workspace.lists.push(second);
  workspace.activeListId = second.id;
  archiveList(workspace, second.id);
  assert.equal(workspace.lists.length, 2);
  assert.equal(second.archived, true);
  assert.equal(workspace.activeListId, first.id);
  restoreList(workspace, second.id);
  assert.equal(second.archived, false);
  assert.equal(workspace.activeListId, second.id);
});

test("archiving the last active list creates and selects a fresh empty list", () => {
  const workspace = createWorkspace();
  const old = workspace.lists[0];
  old.board.todos.push({ id: "t", title: "t", completed: false, createdAt: 0, parentId: null });
  archiveList(workspace, old.id);
  assert.equal(workspace.lists.length, 2);
  assert.equal(old.archived, true);
  assert.equal(old.board.todos.length, 1);
  assert.notEqual(workspace.activeListId, old.id);
  assert.deepEqual(workspace.lists[1].board, { todos: [] });
});

test("deleting an active list selects an unarchived neighbor and keeps archived lists", () => {
  const workspace = createWorkspace();
  const first = workspace.lists[0];
  const archived = createList("archived");
  archived.archived = true;
  const last = createList("last");
  workspace.lists.push(archived, last);
  deleteList(workspace, first.id);
  assert.equal(workspace.activeListId, last.id);
  assert.deepEqual(workspace.lists.map((list) => list.id), [archived.id, last.id]);
  deleteList(workspace, archived.id);
  assert.equal(workspace.activeListId, last.id);
  assert.deepEqual(workspace.lists.map((list) => list.id), [last.id]);
});

test("deleting the last active list creates a new one while retaining archived lists", () => {
  const workspace = createWorkspace();
  const active = workspace.lists[0];
  const archived = createList("archived");
  archived.archived = true;
  workspace.lists.push(archived);
  deleteList(workspace, active.id);
  assert.equal(workspace.lists.length, 2);
  assert.equal(workspace.lists[0], archived);
  assert.notEqual(workspace.activeListId, active.id);
  assert.equal(workspace.lists.find((list) => list.id === workspace.activeListId).archived, false);
});

test("new lists take the least-used note colour, continuing after the last list", () => {
  const workspace = createWorkspace("a");
  assert.equal(workspace.lists[0].color, "yellow");
  const second = addList(workspace, "b");
  assert.equal(second.color, "orange");
  setListColor(workspace, second.id, "blue");
  assert.equal(nextColor(workspace), "green");
  for (let index = 0; index < 10; index++) addList(workspace, "x");
  const counts = NOTE_COLORS.map((color) => workspace.lists.filter((list) => list.color === color).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
});

test("lists without a valid colour are given one", () => {
  const workspace = createWorkspace("a");
  const old = { id: "old", title: "old", board: { todos: [] } };
  const bad = { id: "bad", title: "bad", board: { todos: [] }, color: "magenta" };
  workspace.lists.push(old, bad);
  assert.equal(ensureColors(workspace), true);
  assert.ok(NOTE_COLORS.includes(old.color) && NOTE_COLORS.includes(bad.color));
  assert.notEqual(old.color, "yellow");
  assert.equal(ensureColors(workspace), false);
  setListColor(workspace, "old", "nope");
  assert.ok(NOTE_COLORS.includes(old.color));
});
