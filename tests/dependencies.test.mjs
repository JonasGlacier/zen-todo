import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/dependencies.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { canLink, isBlocked, reconcile, removeTodos } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

const task = (id, prerequisiteIds = [], completed = false) => ({ id, title: id, createdAt: 0, completed, prerequisiteIds });

test("multiple prerequisites must all be completed", () => {
  const todos = [task("a", [], true), task("b"), task("c", ["a", "b"])];
  assert.equal(isBlocked(todos[2], todos), true);
  todos[1].completed = true;
  assert.equal(isBlocked(todos[2], todos), false);
});

test("links support shared prerequisites and reject cycles and duplicates", () => {
  const todos = [task("a"), task("b", ["a"]), task("c", ["a", "b"]), task("d")];
  assert.equal(canLink("a", "d", todos), true);
  assert.equal(canLink("a", "c", todos), false);
  assert.equal(canLink("c", "a", todos), false);
  assert.equal(canLink("a", "a", todos), false);
});

test("reopening a prerequisite propagates through completed descendants", () => {
  const todos = [task("c", ["b"], true), task("b", ["a"], true), task("a")];
  reconcile(todos);
  assert.deepEqual(todos.map((todo) => todo.completed), [false, false, false]);
});

test("removing tasks removes only their links and recalculates blocking", () => {
  const todos = [task("a", [], true), task("b"), task("c", ["a", "b"])];
  const remaining = removeTodos(todos, new Set(["a"]));
  assert.deepEqual(remaining[1].prerequisiteIds, ["b"]);
  assert.equal(isBlocked(remaining[1], remaining), true);
  assert.equal(isBlocked(removeTodos(remaining, new Set(["b"]))[0], []), false);
});
