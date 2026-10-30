import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
      <header class="topbar" data-tauri-drag-region>
        <div class="brand">
          <span class="brand-mark">✓</span>
          <div>
            <h1>Zen Todo</h1>
            <p>${active === 0 ? "今天可以轻松一点" : `${active} 项待完成`}</p>
          </div>
        </div>
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
  document.querySelector<HTMLElement>(".topbar")!.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    void getCurrentWindow().startDragging();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleTodoAction(button.dataset.action!, button.dataset.id!));
  });
}

function todoTemplate(todo: Todo) {
  return `<article class="todo ${todo.completed ? "is-completed" : ""}">
    <button class="check ${todo.completed ? "checked" : ""}" data-action="toggle" data-id="${todo.id}" aria-label="${todo.completed ? "标记未完成" : "标记完成"}">${todo.completed ? "✓" : ""}</button>
    <span class="todo-title">${escapeHtml(todo.title)}</span>
    <button class="delete" data-action="delete" data-id="${todo.id}" aria-label="删除任务">×</button>
  </article>`;
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
