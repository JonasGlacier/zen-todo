import { invoke, isTauri } from "@tauri-apps/api/core";
import { canLink, clearCompleted, groupComplete, groupReady, linkGroups, reconcile, removeGroups, toggleTodo } from "./board";
import type { Board, Group, Todo } from "./board";
import "./styles.css";

const app = document.querySelector<HTMLElement>("#app")!;
const browserKey = "zen-todo-board";
let board: Board = { groups: [], todos: [] };
let pinned = true;
let busy = false;
let message = "";
let composer: { groupId: string; mode: "task" | "previous" | "next" } | null = null;
let menuId: string | null = null;
let draggedId: string | null = null;

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]!);
const name = (id: string) => board.groups.find((group) => group.id === id)?.title ?? "未命名组";

function newGroup(title: string): Group {
  const group = { id: crypto.randomUUID(), title, prerequisiteIds: [] };
  board.groups.push(group);
  return group;
}

function newTodo(title: string, groupId: string) {
  board.todos.push({ id: crypto.randomUUID(), title, groupId, completed: false, createdAt: Date.now() });
}

async function persist() {
  if (isTauri()) await invoke("save_board", { board });
  else localStorage.setItem(browserKey, JSON.stringify(board));
}

// Serialize mutations; on a failed save restore the last persisted state.
async function change(mutate: () => void, focus?: string) {
  if (busy) return;
  busy = true;
  const previous = structuredClone(board);
  try {
    message = "";
    mutate();
    reconcile(board);
    const reset = previous.todos.filter((todo) => todo.completed && board.todos.some((current) =>
      current.id === todo.id && !current.completed && !groupReady(board, current.groupId))).length;
    if (reset) message = `已撤销 ${reset} 项后续待办的完成状态`;
    await persist();
  } catch (error) {
    board = previous;
    message = "保存失败，请重试。";
    console.error(error);
  } finally {
    busy = false;
    render();
    if (focus) document.getElementById(focus)?.focus();
  }
}

function todoTemplate(todo: Todo, ready: boolean) {
  return `<div class="todo ${todo.completed ? "is-completed" : ""}" data-todo="${todo.id}">
    <span class="drag-handle" draggable="true" data-drag="${todo.id}" title="拖动调整顺序" aria-hidden="true">⠿</span>
    <button class="check ${todo.completed ? "checked" : ""}" data-action="toggle" data-id="${todo.id}"
      ${!ready ? "disabled" : ""} aria-pressed="${todo.completed}" aria-label="${todo.completed ? "撤销完成" : "完成"}：${escapeHtml(todo.title)}"
      title="${ready ? "" : "请先完成所有上一步"}">${todo.completed ? "✓" : ""}</button>
    <span class="todo-title">${escapeHtml(todo.title)}</span>
    <button class="delete" data-action="delete-task" data-id="${todo.id}" title="删除待办" aria-label="删除 ${escapeHtml(todo.title)}">×</button>
  </div>`;
}

function composerTemplate(group: Group) {
  if (composer?.groupId !== group.id) return "";
  const mode = composer.mode;
  const direction = mode === "previous" ? "上一步" : "下一步";
  const candidates = mode === "task" ? [] : board.groups.filter((candidate) =>
    mode === "previous" ? canLink(board, candidate.id, group.id) : canLink(board, group.id, candidate.id));
  return `<form class="inline-form" id="step-form" data-group="${group.id}" data-mode="${mode}">
    <div class="composer-heading">${mode === "task" ? "添加待办" : `添加${direction}`}<button type="button" data-action="close-composer" aria-label="取消">×</button></div>
    <div class="input-line"><input id="step-input" aria-label="${mode === "task" ? "待办名称" : `${direction}组名`}" placeholder="${mode === "task" ? "要做什么？" : "输入新组名…"}" autocomplete="off" required maxlength="200"/><button type="submit">${mode === "task" ? "添加" : "新建"}</button></div>
    ${mode === "task" ? "" : `<p class="hint">${mode === "previous" ? "新组全部完成后，才能做本组。" : "本组全部完成后，才能做新组。"}</p>
    ${candidates.length ? `<div class="existing"><span>或关联已有组</span>${candidates.map((candidate) => `<button type="button" data-action="link-${mode}" data-id="${candidate.id}" data-group="${group.id}">${escapeHtml(candidate.title)}<span>＋</span></button>`).join("")}</div>` : ""}`}
  </form>`;
}

function groupTemplate(group: Group, owner: Map<string, string>, depth = 0): string {
  const ready = groupReady(board, group.id);
  const complete = groupComplete(board, group.id);
  const tasks = board.todos.filter((todo) => todo.groupId === group.id);
  const done = tasks.filter((todo) => todo.completed).length;
  const waiting = group.prerequisiteIds.filter((id) => !groupComplete(board, id) || !groupReady(board, id));
  const predecessors = group.prerequisiteIds.map((id) => {
    const previous = board.groups.find((item) => item.id === id);
    if (!previous) return "";
    if (owner.get(id) === group.id) return groupTemplate(previous, owner, depth + 1);
    return `<button class="shared-step ${groupComplete(board, id) ? "is-done" : ""}" data-action="jump" data-id="${id}" title="定位共享的上一步">${groupComplete(board, id) ? "✓" : "↗"} ${escapeHtml(previous.title)}<span>共享上一步</span></button>`;
  }).join("");
  return `<section class="step ${complete ? "step-complete" : ""} ${depth > 5 ? "deep-step" : ""}" id="group-${group.id}" aria-label="${escapeHtml(group.title)}">
    ${predecessors ? `<div class="previous-steps">${predecessors}</div>` : ""}
    <div class="group-body ${!ready ? "is-blocked" : ""}">
      <header class="group-header">
        <input class="group-name" value="${escapeHtml(group.title)}" aria-label="组名" data-rename="${group.id}" maxlength="80" />
        <span class="group-count" title="${complete ? "本组已完成" : "本组完成进度"}">${done}/${tasks.length}</span>
        <button class="group-add-button" data-action="task" data-id="${group.id}" title="添加待办" aria-label="向${escapeHtml(group.title)}添加待办">＋</button>
        <button class="group-menu-button ${menuId === group.id ? "selected" : ""}" data-action="menu" data-id="${group.id}" aria-label="${escapeHtml(group.title)}的操作" aria-expanded="${menuId === group.id}">⋯</button>
      </header>
      ${menuId === group.id ? `<div class="group-tools">
        <button data-action="task" data-id="${group.id}">＋ 待办</button><button data-action="previous" data-id="${group.id}">＋ 上一步</button><button data-action="next" data-id="${group.id}">＋ 下一步</button>
        ${group.prerequisiteIds.map((id) => `<button class="unlink" data-action="unlink" data-id="${id}" data-group="${group.id}" title="只解除关联，不删除任务">解除上一步：${escapeHtml(name(id))} ×</button>`).join("")}
        <button class="danger" data-action="delete-group" data-id="${group.id}">删除本组</button>
      </div>` : ""}
      ${!ready ? `<div class="waiting" title="等待：${escapeHtml(waiting.map(name).join("、"))}">等待 ${waiting.length} 个上一步完成</div>` : ""}
      <div class="tasks">${tasks.map((todo) => todoTemplate(todo, ready)).join("")}</div>
      ${composer?.groupId === group.id ? composerTemplate(group) : tasks.length ? "" : `<button class="add-task" data-action="task" data-id="${group.id}">＋ 添加第一条待办</button>`}
    </div>
  </section>`;
}

function render() {
  const listScroll = document.querySelector(".list")?.scrollTop ?? 0;
  const pending = board.todos.filter((todo) => !todo.completed);
  const available = pending.filter((todo) => groupReady(board, todo.groupId)).length;
  const completed = board.todos.length - pending.length;
  // Each prerequisite gets one full rendering; other successors point to it.
  const owner = new Map<string, string>();
  for (const group of board.groups) for (const id of group.prerequisiteIds) {
    if (!owner.has(id)) owner.set(id, group.id);
  }
  const roots = board.groups.filter((group) => !owner.has(group.id));
  app.innerHTML = `<section class="shell">
    <div class="window-drag-region" aria-label="拖动窗口"></div>
    <header class="controls"><div><strong>Zen Todo</strong><span class="status">${pending.length ? `${available} 项可做${pending.length > available ? ` · ${pending.length - available} 项等待` : ""}` : completed ? "全部完成" : "一步一步，慢慢来"}</span></div>
      <div class="window-actions"><button class="icon-button ${pinned ? "is-active" : ""}" id="pin-button" title="${pinned ? "取消置顶" : "置顶窗口"}" aria-label="${pinned ? "取消置顶" : "置顶窗口"}">⌃</button><button class="icon-button" id="hide-button" title="隐藏到托盘" aria-label="隐藏到托盘">−</button></div>
    </header>
    <div class="list" id="todo-list">${roots.length ? roots.map((group) => groupTemplate(group, owner)).join("") : `<div class="empty"><span>☷</span><strong>从一组待办开始</strong><p>同组一起做，前后分步骤。</p></div>`}
      <form class="new-group-form" id="new-group-form"><span>＋</span><input id="group-input" aria-label="新组名称" placeholder="新建一组待办…" autocomplete="off" required maxlength="80"/><button type="submit">添加</button></form>
    </div>
    <footer class="footer"><span>${board.groups.length} 组 · ${pending.length} 项待完成</span>${completed ? `<button id="clear-completed">清除已完成 · ${completed}</button>` : "<span>保持专注</span>"}</footer>
    <div class="notice ${message ? "visible" : ""}" role="status">${escapeHtml(message)}</div>
  </section>`;
  document.querySelector(".list")!.scrollTop = listScroll;
  bindEvents();
}

function openComposer(groupId: string, mode: "task" | "previous" | "next") {
  composer = { groupId, mode };
  menuId = null;
  render();
  document.querySelector<HTMLInputElement>("#step-input")?.focus();
  document.querySelector(".inline-form")?.scrollIntoView({ block: "nearest" });
}

function handleAction(button: HTMLButtonElement) {
  const { action, id = "", group: groupId = "" } = button.dataset;
  if (action === "menu") { menuId = menuId === id ? null : id; render(); return; }
  if (action === "close-composer") { composer = null; render(); return; }
  if (action === "task" || action === "previous" || action === "next") { openComposer(id, action); return; }
  if (action === "jump") {
    const target = document.getElementById(`group-${id}`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.classList.remove("highlight");
    requestAnimationFrame(() => target?.classList.add("highlight"));
    return;
  }
  void change(() => {
    if (action === "toggle") {
      const reset = toggleTodo(board, id);
      if (reset) message = `已撤销 ${reset} 项后续待办的完成状态`;
    } else if (action === "delete-task") {
      board.todos = board.todos.filter((todo) => todo.id !== id);
    } else if (action === "delete-group") {
      removeGroups(board, new Set([id]));
      if (composer?.groupId === id) composer = null;
      menuId = null;
    } else if (action === "unlink") {
      const group = board.groups.find((item) => item.id === groupId)!;
      group.prerequisiteIds = group.prerequisiteIds.filter((previous) => previous !== id);
    } else if (action === "link-previous" || action === "link-next") {
      linkGroups(board, action === "link-previous" ? id : groupId, action === "link-previous" ? groupId : id);
      composer = null;
    }
  });
}

function bindEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button));
  });
  document.querySelector<HTMLFormElement>("#new-group-form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>("#group-input")!;
    const title = input.value.trim();
    if (!title) return;
    void change(() => {
      const group = newGroup(title);
      composer = { groupId: group.id, mode: "task" };
    }, "step-input").then(() => document.querySelector(".inline-form")?.scrollIntoView({ block: "nearest" }));
  });
  document.querySelector<HTMLFormElement>("#step-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = document.querySelector<HTMLInputElement>("#step-input")!.value.trim();
    if (!title || !composer) return;
    const { groupId, mode } = composer;
    void change(() => {
      if (mode === "task") newTodo(title, groupId);
      else {
        const group = newGroup(title);
        linkGroups(board, mode === "previous" ? group.id : groupId, mode === "previous" ? groupId : group.id);
        composer = { groupId: group.id, mode: "task" };
      }
    }, "step-input").then(() => document.querySelector(".inline-form")?.scrollIntoView({ block: "nearest" }));
  });
  document.querySelectorAll<HTMLInputElement>("[data-rename]").forEach((input) => {
    input.addEventListener("change", () => {
      const title = input.value.trim();
      if (!title) { input.value = name(input.dataset.rename!); return; }
      void change(() => { board.groups.find((group) => group.id === input.dataset.rename)!.title = title; });
    });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") input.blur(); });
  });
  document.querySelector("#clear-completed")?.addEventListener("click", () => {
    void change(() => { clearCompleted(board); composer = null; menuId = null; });
  });
  document.querySelector("#pin-button")!.addEventListener("click", async () => {
    try {
      if (isTauri()) await invoke("set_always_on_top", { value: !pinned });
      pinned = !pinned;
      render();
    } catch { message = "无法更改置顶状态"; render(); }
  });
  document.querySelector("#hide-button")!.addEventListener("click", () => {
    if (isTauri()) void invoke("hide_window").catch(() => { message = "无法隐藏窗口"; render(); });
  });
  document.querySelector(".window-drag-region")!.addEventListener("pointerdown", (event) => {
    if ((event as PointerEvent).button === 0 && isTauri()) void invoke("start_dragging").catch(console.error);
  });
  document.querySelectorAll<HTMLElement>("[data-drag]").forEach((handle) => {
    handle.addEventListener("dragstart", (event) => {
      draggedId = handle.dataset.drag!;
      event.dataTransfer?.setData("text/plain", draggedId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      handle.closest(".todo")?.classList.add("is-dragging");
    });
    handle.addEventListener("dragend", () => { draggedId = null; document.querySelectorAll(".is-dragging, .drop-target").forEach((node) => node.classList.remove("is-dragging", "drop-target")); });
  });
  document.querySelectorAll<HTMLElement>("[data-todo]").forEach((row) => {
    row.addEventListener("dragover", (event) => {
      const source = board.todos.find((todo) => todo.id === draggedId);
      const target = board.todos.find((todo) => todo.id === row.dataset.todo);
      if (!source || source.id === target?.id || source.groupId !== target?.groupId) return;
      event.preventDefault();
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const source = board.todos.find((todo) => todo.id === draggedId);
      const target = board.todos.find((todo) => todo.id === row.dataset.todo);
      if (!source || !target || source.id === target.id || source.groupId !== target.groupId) return;
      const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
      void change(() => {
        board.todos.splice(board.todos.indexOf(source), 1);
        board.todos.splice(board.todos.indexOf(target) + (after ? 1 : 0), 0, source);
      });
    });
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { composer = null; menuId = null; render(); }
});

async function start() {
  board = isTauri() ? await invoke<Board>("load_board") : JSON.parse(localStorage.getItem(browserKey) ?? '{"groups":[],"todos":[]}');
  reconcile(board);
  render();
}

start().catch((error) => {
  console.error(error);
  app.innerHTML = `<section class="shell error"><strong>无法读取待办</strong><p>请检查数据文件后重启应用。</p></section>`;
});
