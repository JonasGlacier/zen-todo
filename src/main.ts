import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
};

const app = document.querySelector<HTMLElement>("#app")!;
let todos: Todo[] = [];
let pinned = true;
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
  await invoke("save_todos", { todos });
}

function render() {
  const active = todos.filter((todo) => !todo.completed).length;
  const completed = todos.filter((todo) => todo.completed).length;

  app.innerHTML = `
    <section class="shell">
      <div class="window-drag-region" aria-label="拖动窗口"></div>
      <header class="controls">
        <span class="status">${active === 0 ? "已清空" : `${active} 项待完成`}</span>
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
    button.addEventListener("click", () => handleTodoAction(button.dataset.action!, button.dataset.id!));
  });
  document.querySelectorAll<HTMLElement>(".todo").forEach((todo) => {
    todo.addEventListener("pointerdown", startTodoDrag);
    todo.addEventListener("pointermove", moveTodoDrag);
    todo.addEventListener("pointerup", endTodoDrag);
    todo.addEventListener("pointercancel", cancelTodoDrag);
  });
}

function todoTemplate(todo: Todo) {
  return `<article class="todo ${todo.completed ? "is-completed" : ""}" data-id="${todo.id}">
    <button class="check ${todo.completed ? "checked" : ""}" data-action="toggle" data-id="${todo.id}" aria-label="${todo.completed ? "标记未完成" : "标记完成"}">${todo.completed ? "✓" : ""}</button>
    <span class="todo-title">${escapeHtml(todo.title)}</span>
    <button class="delete" data-action="delete" data-id="${todo.id}" aria-label="删除任务">×</button>
  </article>`;
}

function startTodoDrag(event: PointerEvent) {
  if (event.button !== 0 || (event.target as Element).closest("button")) return;
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
  todos.unshift({ id: crypto.randomUUID(), title, completed: false, createdAt: Date.now() });
  await persist();
  render();
  document.querySelector<HTMLInputElement>("#todo-input")?.focus();
}

async function handleTodoAction(action: string, id: string) {
  if (action === "toggle") {
    const todo = todos.find((item) => item.id === id);
    if (todo) todo.completed = !todo.completed;
  } else if (action === "delete") {
    todos = todos.filter((item) => item.id !== id);
  }
  await persist();
  render();
}

async function clearCompleted() {
  todos = todos.filter((todo) => !todo.completed);
  await persist();
  render();
}

async function togglePin() {
  pinned = !pinned;
  await invoke("set_always_on_top", { value: pinned });
  render();
}

async function start() {
  todos = await invoke<Todo[]>("load_todos");
  render();
}

start().catch((error) => {
  console.error(error);
  app.innerHTML = `<section class="shell error"><strong>无法读取任务</strong><p>请重启应用后再试。</p></section>`;
});
