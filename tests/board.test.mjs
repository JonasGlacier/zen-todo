import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTE_COLORS, addList, addSibling, addTodo, archiveList, ensureColors, nextColor, setListColor, canLink, canMove, countPrerequisites, createList, createWorkspace, deleteList, indentTodo,
  isBlocked, linkTodos, moveTodo, normalize, outdentTodo, reconcile, removeTodo, restoreList, toggleTodo,
} from "../src/board.ts";

// edges: [previous, next]; every task has at most one next step.
function fixture(edges, extra = []) {
  const ids = [...new Set([...edges.flat(), ...extra])];
  const todos = ids.map((id) => ({ id, title: id, completed: false, createdAt: 0, nextId: null }));
  for (const [previous, next] of edges) todos.find((todo) => todo.id === previous).nextId = next;
  return { todos };
}
const get = (board, id) => board.todos.find((todo) => todo.id === id);
const done = (board, id) => get(board, id).completed;

test("a task is blocked until all of its previous steps are complete", () => {
  const board = fixture([["A", "C"], ["B", "C"]]);
  assert.equal(isBlocked(board, get(board, "C")), true);
  toggleTodo(board, "C");
  assert.equal(done(board, "C"), false);
  toggleTodo(board, "A");
  assert.equal(isBlocked(board, get(board, "C")), true);
  toggleTodo(board, "B");
  assert.equal(isBlocked(board, get(board, "C")), false);
  toggleTodo(board, "C");
  assert.equal(done(board, "C"), true);
});

test("undoing a previous step resets completed later steps only along its branch", () => {
  const board = fixture([["A", "B"], ["B", "C"], ["X", "C"]]);
  for (const id of ["A", "B", "X", "C"]) toggleTodo(board, id);
  assert.equal(toggleTodo(board, "A"), 2);
  assert.deepEqual(["A", "B", "C", "X"].map((id) => done(board, id)), [false, false, false, true]);
});

test("a task keeps a single next step: linking again replaces it", () => {
  const board = fixture([["A", "B"]], ["C"]);
  assert.equal(linkTodos(board, "A", "C"), true);
  assert.equal(get(board, "A").nextId, "C");
  assert.equal(linkTodos(board, "A", "C"), false);
});

test("self-links and cycles are rejected", () => {
  const board = fixture([["A", "B"], ["B", "C"]]);
  assert.equal(canLink(board, "A", "A"), false);
  assert.equal(canLink(board, "C", "A"), false);
  assert.equal(canLink(board, "C", "B"), false);
  assert.equal(canLink(board, "missing", "A"), false);
  assert.equal(canLink(board, "A", "C"), true);
});

test("linking an unfinished task below a completed one reopens it and its successors", () => {
  const board = fixture([["A", "B"]], ["X"]);
  toggleTodo(board, "A");
  toggleTodo(board, "B");
  assert.equal(linkTodos(board, "X", "A"), true);
  assert.deepEqual(["A", "B"].map((id) => done(board, id)), [false, false]);
});

test("a new previous step reopens its completed next step", () => {
  const board = fixture([["A", "B"]]);
  toggleTodo(board, "A");
  toggleTodo(board, "B");
  const added = addTodo(board, "new", "B");
  assert.equal(added.nextId, "B");
  assert.equal(done(board, "B"), false);
});

test("addSibling shares the next step and follows the source", () => {
  const board = fixture([["A", "C"]], ["Z"]);
  board.todos.push({ id: "D", title: "", completed: false, createdAt: 0, nextId: null });
  const sibling = addSibling(board, "A");
  assert.equal(sibling.nextId, "C");
  assert.deepEqual(board.todos.map((todo) => todo.id).slice(0, 3), ["A", sibling.id, "C"]);
  assert.equal(addSibling(board, "missing"), undefined);
});

test("removing a task passes its previous steps on to its next step", () => {
  const board = fixture([["A", "B"], ["X", "B"], ["B", "C"]]);
  removeTodo(board, "B");
  assert.equal(get(board, "A").nextId, "C");
  assert.equal(get(board, "X").nextId, "C");
  removeTodo(board, "C");
  assert.equal(get(board, "A").nextId, null);
  assert.equal(board.todos.length, 2);
});

test("removing an unfinished previous step can unblock its next step", () => {
  const board = fixture([["A", "B"], ["X", "B"]]);
  toggleTodo(board, "A");
  removeTodo(board, "X");
  assert.equal(isBlocked(board, get(board, "B")), false);
});

test("indent nests under the following sibling and outdent moves up one level", () => {
  const board = fixture([["A", "R"], ["B", "R"]]);
  assert.equal(indentTodo(board, "A"), true);
  assert.equal(get(board, "A").nextId, "B");
  assert.equal(indentTodo(board, "B"), false);
  assert.equal(outdentTodo(board, "A"), true);
  assert.equal(get(board, "A").nextId, "R");
  assert.deepEqual(board.todos.map((todo) => todo.id), ["R", "A", "B"]);
  assert.equal(outdentTodo(board, "R"), false);
});

test("moving relative to a target changes order and parent, but never into its own subtree", () => {
  const board = fixture([["A", "B"], ["B", "C"]], ["X"]);
  assert.equal(moveTodo(board, "X", "A", "before"), true);
  assert.equal(get(board, "X").nextId, "B");
  assert.equal(board.todos[0].id, "X");
  assert.equal(moveTodo(board, "X", "C", "after"), true);
  assert.equal(get(board, "X").nextId, null);
  assert.equal(board.todos.at(-1).id, "X");
  assert.equal(canMove(board, "C", "A", "into"), false);
  assert.equal(canMove(board, "C", "A", "before"), false);
  assert.equal(moveTodo(board, "A", "X", "into"), true);
  assert.equal(get(board, "A").nextId, "X");
  assert.equal(countPrerequisites(board, "X"), 1);
});

test("normalize repairs missing, self and cyclic references", () => {
  const board = fixture([["A", "B"]]);
  get(board, "B").nextId = "A";
  board.todos.push({ id: "S", title: "", completed: true, createdAt: 0, nextId: "S" });
  board.todos.push({ id: "M", title: "", completed: false, createdAt: 0, nextId: "gone" });
  board.todos.push({ id: "U", title: "", completed: false, createdAt: 0 });
  normalize(board);
  assert.equal(get(board, "S").nextId, null);
  assert.equal(get(board, "M").nextId, null);
  assert.equal(get(board, "U").nextId, null);
  assert.equal(board.todos.filter((todo) => ["A", "B"].includes(todo.id) && todo.nextId).length, 1);
});

test("reconcile reopens invalid completed tasks in any storage order", () => {
  const board = fixture([["A", "B"], ["B", "C"]]);
  board.todos.forEach((todo) => { todo.completed = todo.id !== "A"; });
  assert.equal(reconcile(board), 2);
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
  old.board.todos.push({ id: "t", title: "t", completed: false, createdAt: 0, nextId: null });
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
