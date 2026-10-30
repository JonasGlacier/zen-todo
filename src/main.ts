import { invoke, isTauri } from "@tauri-apps/api/core";
import { canLink, clearCompleted, groupComplete, groupReady, linkGroups, reconcile, removeGroups, toggleTodo } from "./board";
import type { Board, Group, Todo } from "./board";
import "./styles.css";

const app = document.querySelector<HTMLElement>("#app")!;
const browserKey = "zen-todo-board";
let board: Board = { groups: [], todos: [] };
let pinned = true;
let pendingChange = Promise.resolve();
let message = "";
let composer: { groupId: string; mode: "task" | "previous" | "next" } | null = null;
let draggedId: string | null = null;

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]!);
const name = (id: string) => board.groups.find((group) => group.id === id)?.title || "未命名组";

const icons = {
  task: '<path d="M8 5h11M8 12h11M8 19h6M3 5h.01M3 12h.01M3 19h.01M19 16v6M16 19h6"/>',
  previous: '<path d="m8 7 4-4 4 4M12 3v12M5 15v6h14v-6"/>',
  next: '<path d="m8 17 4 4 4-4M12 21V9M5 9V3h14v6"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  organize: '<path d="M4 5h9M4 12h13M4 19h9M18 2l1.2 3.8L23 7l-3.8 1.2L18 12l-1.2-3.8L13 7l3.8-1.2L18 2Z"/>',
};
const icon = (key: keyof typeof icons) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key]}</svg>`;

function newGroup(title = ""): Group {
  const group = { id: crypto.randomUUID(), title, prerequisiteIds: [], collapsed: false };
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

// Queue edits and clicks so a slow disk save never discards the next action.
function change(mutate: () => void, focus?: string, renderAfter = true): Promise<void> {
  const operation = pendingChange.then(async () => {
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
      if (renderAfter) render();
      else {
        const notice = document.querySelector<HTMLElement>(".notice")!;
        notice.textContent = message;
        notice.classList.toggle("visible", Boolean(message));
      }
      if (focus) document.getElementById(focus)?.focus();
    }
  });
  pendingChange = operation.catch(console.error);
  return operation;
}

function todoTemplate(todo: Todo, ready: boolean) {
  return `<div class="todo ${todo.completed ? "is-completed" : ""}" data-todo="${todo.id}">
    <span class="drag-handle" draggable="true" data-drag="${todo.id}" title="拖动调整顺序" aria-hidden="true">⠿</span>
    <button class="check ${todo.completed ? "checked" : ""}" data-action="toggle" data-id="${todo.id}"
      ${!ready ? "disabled" : ""} aria-pressed="${todo.completed}" aria-label="${todo.completed ? "撤销完成" : "完成"}：${escapeHtml(todo.title)}"
      title="${ready ? "" : "请先完成所有上一步"}">${todo.completed ? "✓" : ""}</button>
    <textarea class="todo-title" data-edit-todo="${todo.id}" aria-label="编辑待办：${escapeHtml(todo.title)}" rows="1" maxlength="200" spellcheck="false">${escapeHtml(todo.title)}</textarea>
    <button class="delete" data-action="delete-task" data-id="${todo.id}" title="删除待办" aria-label="删除 ${escapeHtml(todo.title)}">×</button>
  </div>`;
}

function composerTemplate(group: Group) {
  if (composer?.groupId !== group.id) return "";
  const mode = composer.mode;
  const direction = mode === "previous" ? "上一步" : "下一步";
  const candidates = mode === "task" ? [] : board.groups.filter((candidate) =>
    mode === "previous" ? canLink(board, candidate.id, group.id) : canLink(board, group.id, candidate.id));
  return `<${mode === "task" ? 'form id="step-form"' : "div"} class="inline-form" data-group="${group.id}" data-mode="${mode}">
    <div class="composer-heading">${mode === "task" ? "添加待办" : `添加${direction}`}<button type="button" data-action="close-composer" aria-label="取消">×</button></div>
    ${mode === "task" ? '<div class="input-line"><input id="step-input" aria-label="待办名称" placeholder="要做什么？" autocomplete="off" required maxlength="200"/><button type="submit">添加</button></div>' : `<button class="create-step" data-action="create-${mode}" data-id="${group.id}">＋ 新建分组</button>`}
    ${mode === "task" ? "" : `<p class="hint">${mode === "previous" ? "新组全部完成后，才能做本组。" : "本组全部完成后，才能做新组。"}</p>
    ${candidates.length ? `<div class="existing"><span>或关联已有组</span>${candidates.map((candidate) => `<button type="button" data-action="link-${mode}" data-id="${candidate.id}" data-group="${group.id}"><span data-group-label="${candidate.id}">${escapeHtml(name(candidate.id))}</span><span>＋</span></button>`).join("")}</div>` : ""}
    ${group.prerequisiteIds.length ? `<div class="existing"><span>已关联的上一步</span>${group.prerequisiteIds.map((id) => `<button type="button" data-action="unlink" data-id="${id}" data-group="${group.id}" title="只解除关联，不删除任务"><span data-group-label="${id}">${escapeHtml(name(id))}</span><span>×</span></button>`).join("")}</div>` : ""}`}
  </${mode === "task" ? "form" : "div"}>`;
}

function groupTemplate(group: Group, owner: Map<string, string>, depth = 0): string {
  const ready = groupReady(board, group.id);
  const complete = groupComplete(board, group.id);
  const collapsed = group.collapsed ?? false;
  const tasks = board.todos.filter((todo) => todo.groupId === group.id);
  const done = tasks.filter((todo) => todo.completed).length;
  const predecessors = group.prerequisiteIds.map((id) => {
    const previous = board.groups.find((item) => item.id === id);
    if (!previous) return "";
    if (owner.get(id) === group.id) return groupTemplate(previous, owner, depth + 1);
    return `<button class="shared-step ${groupComplete(board, id) ? "is-done" : ""}" data-action="jump" data-id="${id}" title="定位共享的上一步">${groupComplete(board, id) ? "✓" : "↗"} <span data-group-label="${id}">${escapeHtml(name(id))}</span><span class="shared-caption">共享上一步</span></button>`;
  }).join("");
  return `<section class="step ${complete ? "step-complete" : ""} ${depth > 5 ? "deep-step" : ""}" id="group-${group.id}" aria-label="${escapeHtml(name(group.id))}">
    ${predecessors ? `<div class="previous-steps">${predecessors}</div>` : ""}
    <div class="group-body ${!ready ? "is-blocked" : ""}">
      <header class="group-header">
        <button class="fold-button ${collapsed ? "" : "is-expanded"}" id="fold-${group.id}" data-action="fold" data-id="${group.id}" title="${collapsed ? "展开分组" : "折叠分组"}" aria-label="${collapsed ? "展开" : "折叠"}${escapeHtml(name(group.id))}" aria-expanded="${!collapsed}" aria-controls="content-${group.id}">${icon("chevron")}</button>
        <input class="group-name" value="${escapeHtml(group.title)}" placeholder="组名（可选）" aria-label="组名（可选）" data-rename="${group.id}" maxlength="80" />
        <span class="group-count" title="${complete ? "本组已完成" : "本组完成进度"}">${done}/${tasks.length}</span>
        <div class="group-tools" role="group" aria-label="分组操作">
          <button data-action="task" data-id="${group.id}" title="添加待办" aria-label="添加待办">${icon("task")}</button>
          <button data-action="previous" data-id="${group.id}" title="添加上一步" aria-label="添加上一步">${icon("previous")}</button>
          <button data-action="next" data-id="${group.id}" title="添加下一步" aria-label="添加下一步">${icon("next")}</button>
          <button class="danger" data-action="delete-group" data-id="${group.id}" title="删除本组" aria-label="删除本组">${icon("delete")}</button>
        </div>
      </header>
      <div class="group-content" id="content-${group.id}" ${collapsed ? "hidden" : ""}>
        <div class="tasks">${tasks.map((todo) => todoTemplate(todo, ready)).join("")}</div>
        ${composer?.groupId === group.id ? composerTemplate(group) : tasks.length ? "" : `<button class="add-task" data-action="task" data-id="${group.id}">＋ 添加第一条待办</button>`}
      </div>
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
      <div class="window-actions"><button class="icon-button" id="organize-button" title="一键整理" aria-label="一键整理">${icon("organize")}</button><button class="icon-button ${pinned ? "is-active" : ""}" id="pin-button" title="${pinned ? "取消置顶" : "置顶窗口"}" aria-label="${pinned ? "取消置顶" : "置顶窗口"}">⌃</button><button class="icon-button" id="hide-button" title="隐藏到托盘" aria-label="隐藏到托盘">−</button></div>
    </header>
    <div class="list" id="todo-list">${roots.length ? roots.map((group) => groupTemplate(group, owner)).join("") : `<div class="empty"><span>☷</span><strong>从一组待办开始</strong><p>同组一起做，前后分步骤。</p></div>`}
      <button class="new-group-button" id="new-group-button"><span aria-hidden="true">＋</span> 新建分组</button>
    </div>
    <footer class="footer"><span>${board.groups.length} 组 · ${pending.length} 项待完成</span>${completed ? `<button id="clear-completed">清除已完成 · ${completed}</button>` : "<span>保持专注</span>"}</footer>
    <div class="notice ${message ? "visible" : ""}" role="status">${escapeHtml(message)}</div>
  </section>`;
  bindEvents();
  document.querySelectorAll<HTMLTextAreaElement>("[data-edit-todo]").forEach(resizeTodo);
  document.querySelector(".list")!.scrollTop = listScroll;
}

function resizeTodo(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

function openComposer(groupId: string, mode: "task" | "previous" | "next") {
  void change(() => {
    board.groups.find((group) => group.id === groupId)!.collapsed = false;
    composer = { groupId, mode };
  }).then(() => {
    document.querySelector<HTMLElement>("#step-input, .inline-form .create-step")?.focus();
    document.querySelector(".inline-form")?.scrollIntoView({ block: "nearest" });
  });
}

function handleAction(button: HTMLButtonElement) {
  const { action, id = "", group: groupId = "" } = button.dataset;
  if (action === "close-composer") { composer = null; render(); return; }
  if (action === "task" || action === "previous" || action === "next") { openComposer(id, action); return; }
  if (action === "jump") {
    void change(() => { board.groups.find((group) => group.id === id)!.collapsed = false; }).then(() => {
      const target = document.getElementById(`group-${id}`);
      target?.querySelector(":scope > .group-body")?.scrollIntoView({ behavior: "smooth", block: "center" });
      document.getElementById(`fold-${id}`)?.focus({ preventScroll: true });
      requestAnimationFrame(() => target?.classList.add("highlight"));
    });
    return;
  }
  void change(() => {
    if (action === "fold") {
      const group = board.groups.find((group) => group.id === id)!;
      group.collapsed = !group.collapsed;
      if (group.collapsed && composer?.groupId === id) composer = null;
    } else if (action === "create-previous" || action === "create-next") {
      const group = newGroup();
      linkGroups(board, action === "create-previous" ? group.id : id, action === "create-previous" ? id : group.id);
      composer = { groupId: group.id, mode: "task" };
    } else if (action === "toggle") {
      const reset = toggleTodo(board, id);
      if (reset) message = `已撤销 ${reset} 项后续待办的完成状态`;
    } else if (action === "delete-task") {
      board.todos = board.todos.filter((todo) => todo.id !== id);
    } else if (action === "delete-group") {
      removeGroups(board, new Set([id]));
      if (composer?.groupId === id) composer = null;
    } else if (action === "unlink") {
      const group = board.groups.find((item) => item.id === groupId)!;
      group.prerequisiteIds = group.prerequisiteIds.filter((previous) => previous !== id);
    } else if (action === "link-previous" || action === "link-next") {
      linkGroups(board, action === "link-previous" ? id : groupId, action === "link-previous" ? groupId : id);
      composer = null;
    }
  }, action === "fold" ? `fold-${id}` : action === "create-previous" || action === "create-next" ? "step-input" : undefined).then(() => {
    if (action === "create-previous" || action === "create-next") document.querySelector(".inline-form")?.scrollIntoView({ block: "nearest" });
  });
}

function bindEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button));
  });
  document.querySelector("#new-group-button")!.addEventListener("click", () => {
    void change(() => {
      const group = newGroup();
      composer = { groupId: group.id, mode: "task" };
    }, "step-input").then(() => document.querySelector(".inline-form")?.scrollIntoView({ block: "nearest" }));
  });
  document.querySelector<HTMLFormElement>("#step-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = document.querySelector<HTMLInputElement>("#step-input")!.value.trim();
    if (!title || !composer) return;
    const { groupId } = composer;
    void change(() => {
      newTodo(title, groupId);
    }, "step-input").then(() => document.querySelector(".inline-form")?.scrollIntoView({ block: "nearest" }));
  });
  document.querySelectorAll<HTMLInputElement>("[data-rename]").forEach((input) => {
    input.addEventListener("blur", () => {
      const id = input.dataset.rename!;
      const title = input.value.trim();
      if (title === board.groups.find((group) => group.id === id)?.title) return;
      void change(() => { board.groups.find((group) => group.id === id)!.title = title; }, undefined, false).then(() => {
        if (document.activeElement !== input) input.value = board.groups.find((group) => group.id === id)?.title ?? "";
        document.getElementById(`group-${id}`)?.setAttribute("aria-label", name(id));
        document.querySelectorAll<HTMLElement>("[data-group-label]").forEach((label) => { label.textContent = name(label.dataset.groupLabel!); });
      });
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") {
        event.stopPropagation();
        input.value = board.groups.find((group) => group.id === input.dataset.rename)?.title ?? "";
        input.blur();
      }
    });
  });
  document.querySelectorAll<HTMLTextAreaElement>("[data-edit-todo]").forEach((input) => {
    input.addEventListener("input", () => resizeTodo(input));
    input.addEventListener("blur", () => {
      const id = input.dataset.editTodo!;
      const todo = board.todos.find((item) => item.id === id);
      if (!todo) return;
      const title = input.value.replace(/[\r\n]+/g, " ").trim();
      if (!title || title === todo.title) { input.value = todo.title; resizeTodo(input); return; }
      // Keep the DOM intact so saving on blur doesn't swallow the next click.
      void change(() => { board.todos.find((item) => item.id === id)!.title = title; }, undefined, false).then(() => {
        const saved = board.todos.find((item) => item.id === id);
        if (!saved) return;
        if (document.activeElement !== input) input.value = saved.title;
        input.setAttribute("aria-label", `编辑待办：${saved.title}`);
        const row = input.closest(".todo")!;
        row.querySelector(".check")?.setAttribute("aria-label", `${saved.completed ? "撤销完成" : "完成"}：${saved.title}`);
        row.querySelector(".delete")?.setAttribute("aria-label", `删除 ${saved.title}`);
        resizeTodo(input);
      });
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      if (event.key === "Escape") {
        event.stopPropagation();
        input.value = board.todos.find((todo) => todo.id === input.dataset.editTodo)?.title ?? "";
        input.blur();
      }
    });
  });
  document.querySelector("#clear-completed")?.addEventListener("click", () => {
    void change(() => { clearCompleted(board); composer = null; });
  });
  document.querySelector("#organize-button")!.addEventListener("click", () => {
    void change(() => {
      for (const group of board.groups) {
        group.collapsed = groupComplete(board, group.id) || !groupReady(board, group.id);
      }
      if (composer && board.groups.find((group) => group.id === composer!.groupId)?.collapsed) composer = null;
    }, "organize-button");
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
  if (event.isComposing) return;
  if (event.key === "Escape") { composer = null; render(); }
});

window.addEventListener("resize", () => document.querySelectorAll<HTMLTextAreaElement>("[data-edit-todo]").forEach(resizeTodo));

async function start() {
  board = isTauri() ? await invoke<Board>("load_board") : JSON.parse(localStorage.getItem(browserKey) ?? '{"groups":[],"todos":[]}');
  reconcile(board);
  render();
}

start().catch((error) => {
  console.error(error);
  app.innerHTML = `<section class="shell error"><strong>无法读取待办</strong><p>请检查数据文件后重启应用。</p></section>`;
});
