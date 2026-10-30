import { test } from "node:test";
import assert from "node:assert/strict";
import { canLink, clearCompleted, groupComplete, groupReady, linkGroups, reconcile, removeGroups, toggleTodo } from "../src/board.ts";

function fixture(edges, counts = {}) {
  const ids = [...new Set(edges.flat())];
  const groups = ids.map((id) => ({ id, title: id, prerequisiteIds: [] }));
  for (const [previous, next] of edges) groups.find((group) => group.id === next).prerequisiteIds.push(previous);
  const todos = ids.flatMap((groupId) => Array.from({ length: counts[groupId] ?? 1 }, (_, index) => ({
    id: `${groupId}${index}`, groupId, title: `${groupId}${index}`, completed: false, createdAt: index,
  })));
  return { groups, todos };
}
const finish = (board, id) => board.todos.filter((todo) => todo.groupId === id).forEach((todo) => toggleTodo(board, todo.id));

test("diagram: A and D → B → C, E → F, C and F → G", () => {
  const board = fixture([["A", "B"], ["D", "B"], ["B", "C"], ["E", "F"], ["C", "G"], ["F", "G"]], { A: 4, B: 3, E: 3, G: 3 });
  assert.equal(groupReady(board, "A"), true);
  assert.equal(groupReady(board, "E"), true);
  toggleTodo(board, "B0");
  assert.equal(board.todos.find((todo) => todo.id === "B0").completed, false);
  finish(board, "A");
  assert.equal(groupReady(board, "B"), false);
  finish(board, "D");
  assert.equal(groupReady(board, "B"), true);
  finish(board, "B");
  finish(board, "C");
  assert.equal(groupReady(board, "G"), false);
  finish(board, "E");
  finish(board, "F");
  assert.equal(groupReady(board, "G"), true);
  toggleTodo(board, "G0");
  assert.equal(groupComplete(board, "G"), false);
});

test("many-to-many shared prerequisites unlock all dependent groups", () => {
  const board = fixture([["A", "C"], ["A", "D"], ["B", "C"], ["B", "D"]]);
  finish(board, "A");
  assert.equal(groupReady(board, "C"), false);
  assert.equal(groupReady(board, "D"), false);
  finish(board, "B");
  assert.equal(groupReady(board, "C"), true);
  assert.equal(groupReady(board, "D"), true);
});

test("undoing one prerequisite resets descendants but not the parallel branch", () => {
  const board = fixture([["A", "B"], ["B", "C"], ["X", "C"]]);
  for (const id of ["A", "B", "X", "C"]) finish(board, id);
  assert.equal(toggleTodo(board, "A0"), 2);
  assert.equal(groupComplete(board, "B"), false);
  assert.equal(groupComplete(board, "C"), false);
  assert.equal(groupComplete(board, "X"), true);
  finish(board, "A");
  assert.equal(groupReady(board, "B"), true);
  assert.equal(groupComplete(board, "B"), false);
});

test("self-links, duplicate links and indirect cycles are rejected", () => {
  const board = fixture([["A", "B"], ["B", "C"]]);
  assert.equal(canLink(board, "A", "A"), false);
  assert.equal(canLink(board, "A", "B"), false);
  assert.equal(canLink(board, "C", "A"), false);
  assert.equal(canLink(board, "missing", "A"), false);
  assert.equal(linkGroups(board, "C", "A"), false);
  assert.equal(linkGroups(board, "A", "C"), true);
});

test("adding an unmet prerequisite resets a completed group and its successors", () => {
  const board = fixture([["A", "B"], ["X", "Y"]]);
  finish(board, "A");
  finish(board, "B");
  assert.equal(linkGroups(board, "X", "A"), true);
  assert.equal(groupComplete(board, "A"), false);
  assert.equal(groupComplete(board, "B"), false);
});

test("new tasks and empty prerequisites block successors", () => {
  const board = fixture([["A", "B"], ["B", "C"]]);
  finish(board, "A");
  finish(board, "B");
  finish(board, "C");
  board.todos.push({ id: "A1", groupId: "A", title: "new", completed: false, createdAt: 0 });
  assert.equal(reconcile(board), 2);
  board.todos = board.todos.filter((todo) => todo.groupId !== "A");
  assert.equal(groupComplete(board, "A"), false);
  assert.equal(groupReady(board, "B"), false);
});

test("deleting a group removes only its tasks and edges", () => {
  const board = fixture([["A", "C"], ["B", "C"], ["C", "D"]]);
  removeGroups(board, new Set(["A"]));
  assert.deepEqual(board.groups.find((group) => group.id === "C").prerequisiteIds, ["B"]);
  assert.equal(board.todos.some((todo) => todo.groupId === "A"), false);
  assert.equal(board.todos.some((todo) => todo.groupId === "D"), true);
  assert.equal(groupReady(board, "C"), false);
  finish(board, "B");
  assert.equal(groupReady(board, "C"), true);
});

test("clearing completed steps removes their links without reblocking successors", () => {
  const board = fixture([["A", "B"], ["B", "C"]], { B: 2 });
  finish(board, "A");
  toggleTodo(board, "B0");
  clearCompleted(board);
  assert.deepEqual(board.groups.map((group) => group.id), ["B", "C"]);
  assert.deepEqual(board.groups[0].prerequisiteIds, []);
  assert.equal(groupReady(board, "B"), true);
  assert.equal(board.todos.some((todo) => todo.id === "B0"), false);
  assert.equal(groupReady(board, "C"), false);
});
