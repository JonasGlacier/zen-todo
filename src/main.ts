import { invoke } from "@tauri-apps/api/core";
import { canLink, isBlocked, reconcile, removeTodos, type Todo } from "./dependencies";
import "./styles.css";

const app = document.querySelector<HTMLElement>("#app")!;
let todos: Todo[] = [];
let pinned = true;
let expandedId: string | null = null;
let saveQueue = Promise.resolve();
let taskDrag: {
  id: string;
  source: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  target: HTMLElement | null;
  insertAfter: boolean;
} | null = null;

const escapeHtml = (value: string) =>
  value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);

async function persist() {
  const snapshot = structuredClone(todos);
  saveQueue = saveQueue.catch(() => {}).then(() => invoke("save_todos", { todos: snapshot }));
  await saveQueue;
}

function render() {
  const active = todos.filter((todo) => !todo.completed).length;
  const completed = todos.filter((todo) => todo.completed).length;
  const scrollTop = document.querySelector<HTMLElement>("#todo-list")?.scrollTop ?? 0;

  app.innerHTML = `
    <section class="shell">
      <div class="window-drag-region" aria-label="拖动窗口"></div>
      <header class="controls">
        <div class="brand"><span class="brand-mark">✳</span><span>ZEN TODO<small>把事情，一步步完成</small></span></div>
        <div class="window-actions">
          <button class="icon-button ${pinned ? "is-active" : ""}" id="pin-button" title="${pinned ? "取消置顶" : "置顶窗口"}" aria-label="置顶窗口">⌃</button>
          <button class="icon-button" id="hide-button" title="隐藏到托盘" aria-label="隐藏到托盘">−</button>
        </div>
      </header>

      <form class="add-form" id="add-form">
        <span class="plus">+</span>
        <input id="todo-input" autocomplete="off" placeholder="接下来要做什么？" aria-label="添加任务" />
        <button type="submit">添加</button>
      </form>

      <div class="list-heading"><span>我的待办</span><span>${active} 项进行中</span></div>
      <div class="list" id="todo-list">
        ${todos.length === 0 ? `<div class="empty"><span>✦</span><strong>还没有任务</strong><p>把脑中的事情放下来，专注当下。</p></div>` : todos.map(todoTemplate).join("")}
      </div>

      <footer class="footer">
        <span>${active} 项待完成</span>
        ${completed > 0 ? `<button id="clear-completed">清除已完成 · ${completed}</button>` : "<span>保持专注</span>"}
      </footer>
    </section>
  `;

  document.querySelector<HTMLFormElement>("#add-form")!.addEventListener("submit", addTodo);
  document.querySelector<HTMLButtonElement>("#pin-button")!.addEventListener("click", togglePin);
  document.querySelector<HTMLButtonElement>("#hide-button")!.addEventListener("click", () => invoke("hide_window"));
  document.querySelector<HTMLButtonElement>("#clear-completed")?.addEventListener("click", clearCompleted);
  document.querySelector<HTMLElement>(".window-drag-region")!.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    void invoke("start_dragging");
  });
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleTodoAction(button.dataset.action!, button.dataset.id!, button.dataset.relatedId));
  });
  document.querySelectorAll<HTMLFormElement>(".dependency-form").forEach((form) => {
    form.addEventListener("submit", addDependency);
  });
  document.querySelectorAll<HTMLSelectElement>(".dependency-select").forEach((select) => {
    select.addEventListener("change", () => linkExisting(select));
  });
  document.querySelectorAll<HTMLElement>(".todo").forEach((todo) => {
    todo.addEventListener("pointerdown", startTodoDrag);
    todo.addEventListener("pointermove", moveTodoDrag);
    todo.addEventListener("pointerup", endTodoDrag);
    todo.addEventListener("pointercancel", cancelTodoDrag);
  });
  document.querySelector<HTMLElement>("#todo-list")!.scrollTop = scrollTop;
}

function todoTemplate(todo: Todo) {
  const prerequisites = todos.filter((item) => todo.prerequisiteIds.includes(item.id));
  const next = todos.filter((item) => item.prerequisiteIds.includes(todo.id));
  const blocked = isBlocked(todo, todos);
  const expanded = expandedId === todo.id;
  const waiting = prerequisites.filter((item) => !item.completed);
  return `<article class="todo ${todo.completed ? "is-completed" : ""} ${blocked ? "is-blocked" : ""} ${expanded ? "is-expanded" : ""}" data-id="${escapeHtml(todo.id)}">
    <div class="todo-row">
      <button class="check ${todo.completed ? "checked" : ""}" data-action="toggle" data-id="${escapeHtml(todo.id)}" ${blocked ? "disabled" : ""} aria-label="${blocked ? "请先完成前置任务" : todo.completed ? "标记未完成" : "标记完成"}">${todo.completed ? "✓" : ""}</button>
      <div class="todo-content"><span class="todo-title">${escapeHtml(todo.title)}</span>
        <span class="todo-meta">${blocked ? `◌ 等待 ${waiting.length} 个前置任务` : todo.completed ? "已完成" : "可以开始"}${next.length ? ` · ${next.length} 个后续` : ""}</span></div>
      <button class="details-button" data-action="expand" data-id="${escapeHtml(todo.id)}" aria-label="${expanded ? "收起" : "管理"}任务步骤" aria-expanded="${expanded}">${expanded ? "⌃" : "⌄"}</button>
      <button class="delete" data-action="delete" data-id="${escapeHtml(todo.id)}" aria-label="删除任务">×</button>
    </div>
    ${expanded ? `<div class="dependencies">${dependencySection(todo, prerequisites, "before")}${dependencySection(todo, next, "after")}</div>` : ""}
  </article>`;
}

function dependencySection(todo: Todo, related: Todo[], direction: "before" | "after") {
  const before = direction === "before";
  const candidates = todos.filter((item) => before ? canLink(item.id, todo.id, todos) : canLink(todo.id, item.id, todos));
  const id = escapeHtml(todo.id);
  return `<section class="dependency-section">
    <div class="dependency-heading"><span>${before ? "上一步" : "下一步"}</span><span>${before ? "全部完成后解锁" : "完成后解锁"}</span></div>
    <div class="dependency-items">${related.length ? related.map((item) => `<div class="dependency-item"><span class="dependency-dot ${item.completed ? "done" : ""}"></span><span title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span><button data-action="unlink-${direction}" data-id="${id}" data-related-id="${escapeHtml(item.id)}" aria-label="移除与 ${escapeHtml(item.title)} 的关联">×</button></div>`).join("") : `<span class="dependency-empty">${before ? "没有前置任务" : "没有后续任务"}</span>`}</div>
    <select class="dependency-select" data-id="${id}" data-direction="${direction}" aria-label="关联已有${before ? "上一步" : "下一步"}"><option value="">＋ 关联已有任务</option>${candidates.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title)}</option>`).join("")}</select>
    <form class="dependency-form" data-id="${id}" data-direction="${direction}"><input aria-label="新建${before ? "上一步" : "下一步"}" placeholder="新建${before ? "上一步" : "下一步"}…" maxlength="200"><button type="submit">添加</button></form>
  </section>`;
}

function startTodoDrag(event: PointerEvent) {
  if (event.button !== 0 || (event.target as Element).closest("button, input, select, .dependencies")) return;
  const todo = event.currentTarget as HTMLElement;
  taskDrag = {
    id: todo.dataset.id!,
    source: todo,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    target: null,
    insertAfter: false,
  };
  todo.setPointerCapture(event.pointerId);
}

function moveTodoDrag(event: PointerEvent) {
  if (!taskDrag || event.pointerId !== taskDrag.pointerId) return;
  const distance = Math.hypot(event.clientX - taskDrag.startX, event.clientY - taskDrag.startY);
  if (!taskDrag.active && distance < 5) return;
  if (!taskDrag.active) {
    taskDrag.active = true;
    taskDrag.source.classList.add("is-dragging");
  }

  event.preventDefault();
  const candidate = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".todo");
  if (taskDrag.target && taskDrag.target !== candidate) {
    taskDrag.target.classList.remove("is-drag-over");
    delete taskDrag.target.dataset.dropPosition;
  }
  if (!candidate || candidate === taskDrag.source) {
    taskDrag.target = null;
    return;
  }

  const bounds = candidate.getBoundingClientRect();
  taskDrag.target = candidate;
  taskDrag.insertAfter = event.clientY > bounds.top + bounds.height / 2;
  candidate.dataset.dropPosition = taskDrag.insertAfter ? "after" : "before";
  candidate.classList.add("is-drag-over");
}

async function endTodoDrag(event: PointerEvent) {
  if (!taskDrag || event.pointerId !== taskDrag.pointerId || event.currentTarget !== taskDrag.source) return;
  const drag = taskDrag;
  clearTodoDrag();
  if (!drag.active || !drag.target) return;

  const sourceIndex = todos.findIndex((todo) => todo.id === drag.id);
  const targetIndex = todos.findIndex((todo) => todo.id === drag.target!.dataset.id);
  if (sourceIndex < 0 || targetIndex < 0) return;

  const [movedTodo] = todos.splice(sourceIndex, 1);
  let insertIndex = targetIndex;
  if (sourceIndex < targetIndex) insertIndex -= 1;
  if (drag.insertAfter) insertIndex += 1;
  todos.splice(insertIndex, 0, movedTodo);
  await persist();
  render();
}

function cancelTodoDrag(event: PointerEvent) {
  if (!taskDrag || event.pointerId !== taskDrag.pointerId) return;
  clearTodoDrag();
}

function clearTodoDrag() {
  taskDrag = null;
  document.querySelectorAll(".is-dragging, .is-drag-over").forEach((todo) => {
    todo.classList.remove("is-dragging", "is-drag-over");
    delete (todo as HTMLElement).dataset.dropPosition;
  });
}

async function addTodo(event: SubmitEvent) {
  event.preventDefault();
  const input = document.querySelector<HTMLInputElement>("#todo-input")!;
  const title = input.value.trim();
  if (!title) return;
  todos.unshift({ id: crypto.randomUUID(), title, completed: false, createdAt: Date.now(), prerequisiteIds: [] });
  await persist();
  render();
  document.querySelector<HTMLInputElement>("#todo-input")?.focus();
}

async function handleTodoAction(action: string, id: string, relatedId?: string) {
  const todo = todos.find((item) => item.id === id);
  if (!todo) return;
  if (action === "expand") {
    expandedId = expandedId === id ? null : id;
    render();
    return;
  }
  if (action === "toggle") {
    if (!todo.completed && isBlocked(todo, todos)) return;
    todo.completed = !todo.completed;
    reconcile(todos);
  } else if (action === "delete") {
    todos = removeTodos(todos, new Set([id]));
    if (expandedId === id) expandedId = null;
  } else if (action === "unlink-before" && relatedId) {
    todo.prerequisiteIds = todo.prerequisiteIds.filter((item) => item !== relatedId);
  } else if (action === "unlink-after" && relatedId) {
    const next = todos.find((item) => item.id === relatedId);
    if (next) next.prerequisiteIds = next.prerequisiteIds.filter((item) => item !== id);
  } else return;
  await persist();
  render();
}

async function linkExisting(select: HTMLSelectElement) {
  const id = select.dataset.id!;
  const relatedId = select.value;
  const before = select.dataset.direction === "before";
  const prerequisiteId = before ? relatedId : id;
  const dependentId = before ? id : relatedId;
  if (!canLink(prerequisiteId, dependentId, todos)) return;
  todos.find((todo) => todo.id === dependentId)!.prerequisiteIds.push(prerequisiteId);
  reconcile(todos);
  await persist();
  render();
}

async function addDependency(event: SubmitEvent) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = form.querySelector<HTMLInputElement>("input")!;
  const title = input.value.trim();
  const parent = todos.find((todo) => todo.id === form.dataset.id);
  if (!title || !parent) return;
  const before = form.dataset.direction === "before";
  const newTodo: Todo = { id: crypto.randomUUID(), title, completed: false, createdAt: Date.now(), prerequisiteIds: before ? [] : [parent.id] };
  if (before) parent.prerequisiteIds.push(newTodo.id);
  const index = todos.indexOf(parent);
  todos.splice(before ? index : index + 1, 0, newTodo);
  reconcile(todos);
  await persist();
  render();
  document.querySelector<HTMLInputElement>(`.dependency-form[data-direction="${before ? "before" : "after"}"] input`)?.focus();
}

async function clearCompleted() {
  todos = removeTodos(todos, new Set(todos.filter((todo) => todo.completed).map((todo) => todo.id)));
  if (!todos.some((todo) => todo.id === expandedId)) expandedId = null;
  await persist();
  render();
}

async function togglePin() {
  pinned = !pinned;
  await invoke("set_always_on_top", { value: pinned });
  render();
}

async function start() {
  todos = (await invoke<Todo[]>("load_todos")).map((todo) => ({ ...todo, prerequisiteIds: todo.prerequisiteIds ?? [] }));
  reconcile(todos);
  render();
}

start().catch((error) => {
  console.error(error);
  app.innerHTML = `<section class="shell error"><strong>无法读取任务</strong><p>请重启应用后再试。</p></section>`;
});
