import { test } from "node:test";
import assert from "node:assert/strict";
import { editorsAfterSync } from "../src/session.ts";

const workspace = (titles, name = "清单") => ({
  activeListId: "list-1",
  lists: [{ id: "list-1", title: name, board: {
    todos: titles.map((title, index) => ({ id: `t${index}`, title })),
  } }],
});
const editor = (selector, value, focused = false) => ({
  selector, value, focused, start: 0, end: 0,
});

test("sync replaces blank and stale displayed titles while new tasks render from the model", () => {
  const before = workspace(["", "旧标题", "已完成输入"]);
  const after = workspace(["完整任务", "最新标题", "已完成输入", "新任务"], "新清单名称");
  const editors = [editor("#todo-t0", ""), editor("#todo-t1", "旧标题"),
    editor("#todo-t2", "已完成输入"), editor("#list-name", "清单")];
  const restored = editorsAfterSync(editors, before, after);
  assert.deepEqual(restored.map((item) => item.value), ["完整任务", "最新标题", "已完成输入", "新清单名称"]);
  assert.equal(restored.some((item) => item.selector === "#todo-t3"), false);
  // Repeated sync cannot bring the old blank display back.
  assert.deepEqual(editorsAfterSync(restored, after, after), restored);
  assert.equal(editors[0].value, "");
  assert.equal(after.lists[0].board.todos[0].title, "完整任务");
});

test("focus alone does not preserve stale text, but real local drafts and selections survive", () => {
  const before = workspace(["", "原文", "待删除文字"]);
  const after = workspace(["远端内容", "远端修改", "远端另一修改"], "远端清单");
  const draft = { ...editor("#todo-t1", "本地未提交草稿", true), start: 2, end: 4 };
  const cleared = editor("#todo-t2", "");
  const listDraft = editor("#list-name", "本地清单草稿");
  const restored = editorsAfterSync([
    editor("#todo-t0", "", true), draft, cleared, listDraft,
  ], before, after);
  assert.equal(restored[0].value, "远端内容");
  assert.equal(restored[0].focused, true);
  assert.deepEqual(restored.slice(1), [draft, cleared, listDraft]);
});

test("normalized saved input is clean and must not mask remote updates", () => {
  const before = workspace(["任务 内容"]);
  const after = workspace(["更新内容"], "更新清单");
  const restored = editorsAfterSync([
    editor("#todo-t0", " 任务\n内容 "), editor("#list-name", " 清单 "),
  ], before, after);
  assert.deepEqual(restored.map((item) => item.value), ["更新内容", "更新清单"]);
});

test("removed tasks and a changed active list cannot receive old editor values", () => {
  const before = workspace(["原文"]);
  const editors = [editor("#todo-t0", "草稿", true), editor("#list-name", "清单")];
  assert.deepEqual(editorsAfterSync(editors, before, workspace([])), [editors[1]]);
  const after = workspace(["其他任务"], "其他清单");
  after.lists[0].id = after.activeListId = "list-2";
  assert.deepEqual(editorsAfterSync(editors, before, after), []);
});
