import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  addSibling, addTodo, archiveList, canMove, createList, createWorkspace, deleteList, indentTodo, isBlocked,
  moveTodo, normalize, outdentTodo, prerequisites, reconcile, removeTodo, restoreList, toggleTodo,
} from "./board";
import type { Board, DropPlace, Todo, Workspace } from "./board";
import { getLanguage, t, watchSettings } from "./i18n";
import { icon } from "./icons";
import { captureEditors, restoreEditors } from "./session";
import type { UiSession } from "./session";
import "./styles.css";

const app = document.querySelector<HTMLElement>("#app")!;
const browserKey = "zen-todo-board";
let workspace: Workspace = createWorkspace(t("myTodos"));
let board: Board = workspace.lists[0].board;
let pinned = true;
let pendingChange = Promise.resolve();
let message = "";
let draggedId: string | null = null;
let showArchive = false;
let settingsWindow: Window | null = null;
let openingSettings = false;
let suspending = false;
let initialized = false;
let saveFailures = 0;

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]!);
const activeList = () => workspace.lists.find((list) => list.id === workspace.activeListId)!;
const editorId = (id: string) => `todo-${id}`;
const titleOf = (input: HTMLTextAreaElement) => input.value.replace(/[\r\n]+/g, " ").trim();

async function persist() {
  if (isTauri()) await invoke("save_board", { board: workspace });
  else localStorage.setItem(browserKey, JSON.stringify(workspace));
}

// Queue edits and clicks so a slow disk save never discards the next action.
function change(mutate: () => void, focus?: string, renderAfter = true): Promise<void> {
  const operation = pendingChange.then(async () => {
    const previous = structuredClone(workspace);
    const previousBoard = structuredClone(board);
    try {
      message = "";
      mutate();
      reconcile(board);
      const reset = previousBoard.todos.filter((todo) => todo.completed && board.todos.some((current) =>
        current.id === todo.id && !current.completed && isBlocked(board, current))).length;
      if (reset) message = t("resetTasks", { count: reset });
      await persist();
    } catch (error) {
      saveFailures++;
      workspace = previous;
      board = activeList().board;
      message = t("saveFailed");
      console.error(error);
    } finally {
      if (renderAfter) render();
      else {
        const notice = document.querySelector<HTMLElement>(".notice")!;
        notice.textContent = message;
        notice.classList.toggle("visible", Boolean(message));
      }
      if (focus) {
        const target = document.getElementById(focus);
        target?.focus();
        target?.scrollIntoView({ block: "nearest" });
      }
    }
  });
  pendingChange = operation.catch(console.error);
  return operation;
}

function todoRow(todo: Todo): string {
  const blocked = isBlocked(board, todo);
  const label = escapeHtml(todo.title);
  return `<div class="todo ${todo.completed ? "is-completed" : ""} ${blocked ? "is-blocked" : ""}" data-todo="${todo.id}">
    <span class="drag-handle" draggable="true" data-drag="${todo.id}" title="${t("reorder")}" aria-hidden="true">${icon("grip")}</span>
    <button class="check ${todo.completed ? "checked" : ""}" data-action="toggle" data-id="${todo.id}"
      ${blocked ? "disabled" : ""} aria-pressed="${todo.completed}" aria-label="${escapeHtml(t("taskLabel", { action: t(todo.completed ? "undoComplete" : "complete"), title: todo.title }))}"
      title="${blocked ? t("prerequisitesFirst") : ""}">${todo.completed ? icon("check") : ""}</button>
    <textarea class="todo-title" id="${editorId(todo.id)}" data-edit-todo="${todo.id}" aria-label="${escapeHtml(t("editTodo", { title: todo.title }))}" placeholder="${t("todoPlaceholder")}" rows="1" maxlength="200" spellcheck="false">${label}</textarea>
    <button class="row-action" data-action="add-previous" data-id="${todo.id}" title="${t("addPrevious")}" aria-label="${escapeHtml(t("addPreviousNamed", { title: todo.title }))}">${icon("previous")}</button>
    <button class="delete" data-action="delete-task" data-id="${todo.id}" title="${t("deleteTodo")}" aria-label="${escapeHtml(t("deleteNamedTodo", { title: todo.title }))}">${icon("close")}</button>
  </div>`;
}

// Previous steps are drawn indented above the task they lead to.
function nodeTemplate(todo: Todo): string {
  const previous = prerequisites(board, todo.id);
  return `<div class="node" id="node-${todo.id}">${previous.length ? `<div class="children">${previous.map(nodeTemplate).join("")}</div>` : ""}${todoRow(todo)}</div>`;
}

function archiveTemplate(): string {
  const archived = workspace.lists.filter((list) => list.archived);
  return `<div class="list archive-panel" id="todo-list">
    <div class="archive-heading">${t("archivedLists")}</div>
    ${archived.length ? archived.map((list) => {
      const done = list.board.todos.filter((todo) => todo.completed).length;
      return `<section class="archived-list"><div class="archived-header"><span class="archived-name">${escapeHtml(list.title)}</span><span class="archived-meta">${t("archivedProgress", { done, total: list.board.todos.length })}</span><button class="restore-button" data-action="restore" data-id="${list.id}" title="${escapeHtml(t("restoreNamed", { title: list.title }))}" aria-label="${escapeHtml(t("restoreNamed", { title: list.title }))}">${icon("restore")} ${t("restoreList")}</button></div>
        <ul class="archived-tasks">${list.board.todos.length ? list.board.todos.map((todo) => `<li class="${todo.completed ? "is-completed" : ""}">${escapeHtml(todo.title) || "&nbsp;"}</li>`).join("") : `<li class="muted">${t("emptyArchivedList")}</li>`}</ul><button class="delete-list-button" data-delete-list="${list.id}" title="${t("holdDeleteListHint")}" aria-label="${escapeHtml(t("holdDeleteNamedList", { title: list.title }))}">${t("holdDeleteList")}</button></section>`;
    }).join("") : `<p class="muted archive-empty">${t("archivedEmpty")}</p>`}
  </div>`;
}

function render() {
  document.documentElement.lang = getLanguage();
  const listScroll = document.querySelector(".list")?.scrollTop ?? 0;
  const list = activeList();
  const visibleLists = workspace.lists.filter((item) => !item.archived);
  const archivedCount = workspace.lists.length - visibleLists.length;
  const pending = board.todos.filter((todo) => !todo.completed);
  const available = pending.filter((todo) => !isBlocked(board, todo)).length;
  const completed = board.todos.length - pending.length;
  const roots = board.todos.filter((todo) => todo.nextId === null);
  const content = showArchive ? archiveTemplate() : `<div class="list" id="todo-list" role="tabpanel">${roots.length ? roots.map(nodeTemplate).join("") : `<div class="empty"><span>${icon("empty")}</span><strong>${t("emptyTitle")}</strong><p>${t("emptyDescription")}</p></div>`}
      <button class="new-task-button" id="new-task-button">${icon("plus")} ${t("newTodo")}</button>
      <button class="archive-list-button" data-action="archive-list" title="${t("archiveListHint")}">${icon("archive")} ${t("archiveList")}</button>
      <button class="delete-list-button" data-delete-list="${list.id}" title="${t("holdDeleteListHint")}">${t("holdDeleteList")}</button>
    </div>`;
  app.innerHTML = `<section class="shell">
    <div class="window-drag-region" data-window-drag title="${t("dragWindow")}" aria-label="${t("dragWindow")}"><span></span></div>
    <header class="controls" data-window-drag><div class="heading"><input class="list-name" id="list-name" value="${escapeHtml(list.title)}" aria-label="${t("listName")}" title="${t("renameList")}" maxlength="80"/><span class="status">${pending.length ? `${t("readyCount", { count: available })}${pending.length > available ? ` · ${t("waitingCount", { count: pending.length - available })}` : ""}` : t(completed ? "allDone" : "takeYourTime")}</span></div>
      <div class="window-actions"><button class="icon-button" id="settings-button" title="${t("settings")}" aria-label="${t("settings")}">${icon("settings")}</button><button class="icon-button ${pinned ? "is-active" : ""}" id="pin-button" title="${t(pinned ? "unpin" : "pin")}" aria-label="${t(pinned ? "unpin" : "pin")}" aria-pressed="${pinned}">${icon(pinned ? "pin" : "pinOff")}</button><button class="icon-button" id="hide-button" title="${t("hide")}" aria-label="${t("hide")}">${icon("hide")}</button></div>
    </header>
    <div class="workspace">
    ${content}
    <div class="tabs-bar">
      <div class="tabs" role="tablist" aria-label="${t("todoLists")}">${visibleLists.map((item) => `<button class="tab ${!showArchive && item.id === workspace.activeListId ? "is-selected" : ""}" role="tab" aria-selected="${!showArchive && item.id === workspace.activeListId}" aria-controls="todo-list" data-list="${item.id}" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</button>`).join("")}</div>
      <button class="tab-action" id="new-list" title="${t("newList")}" aria-label="${t("newList")}">${icon("plus")}</button>
      <button class="tab-action ${showArchive ? "is-active" : ""}" id="archive-toggle" title="${t("archived")}${archivedCount ? ` · ${archivedCount}` : ""}" aria-label="${t("archived")}" aria-pressed="${showArchive}">${icon("archive")}</button>
    </div>
    </div>
    <footer class="footer"><span>${t("footer", { count: pending.length })}</span><span>${t("stayFocused")}</span></footer>
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

async function openSettings() {
  if (openingSettings) return;
  openingSettings = true;
  try {
    if (isTauri()) await invoke("open_settings", { language: getLanguage() });
    else if (settingsWindow && !settingsWindow.closed) settingsWindow.focus();
    else {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "settings");
      settingsWindow = window.open(url, "zen-todo-settings", "popup,width=640,height=480,resizable=yes,scrollbars=yes");
      if (!settingsWindow) throw new Error("Settings popup blocked");
    }
  } catch (error) {
    message = t("openSettingsFailed");
    const notice = document.querySelector<HTMLElement>(".notice")!;
    notice.textContent = message;
    notice.classList.add("visible");
    console.error(error);
  } finally { openingSettings = false; }
}

function refreshLanguage() {
  const operation = pendingChange.then(() => {
    // Another window can change language while an editor still has focus.
    // Preserve editor values and the caret across the interface refresh.
    const fields = captureEditors();
    message = "";
    render();
    restoreEditors(fields, resizeTodo);
  });
  pendingChange = operation.catch(console.error);
}

function restoreSession(session: UiSession | null) {
  if (session?.version !== 1) return;
  pinned = session.pinned;
}

function restoreSessionEditors(session: UiSession | null) {
  if (session?.version !== 1 || session.listId !== workspace.activeListId) return;
  restoreEditors(session.editors, resizeTodo);
  document.querySelector(".list")!.scrollTop = session.scrollTop;
}

async function suspendToTray() {
  if (!isTauri() || suspending) return;
  suspending = true;
  const failures = saveFailures;
  const session: UiSession | null = initialized ? {
    version: 1, listId: document.querySelector<HTMLElement>(".tab.is-selected")?.dataset.list ?? workspace.activeListId, pinned,
    scrollTop: document.querySelector(".list")?.scrollTop ?? 0,
    editors: captureEditors(),
  } : null;
  // Capture before blur: it commits existing edits. Never tear down a WebView
  // while a save is still pending.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  app.inert = true;
  try {
    await pendingChange;
    if (saveFailures !== failures) throw new Error("Pending save failed");
    if (session) session.pinned = pinned;
    if (initialized) await persist();
    await invoke("hide_window", { session });
  } catch (error) {
    suspending = false;
    app.inert = false;
    if (initialized) {
      restoreSession(session);
      render();
      restoreSessionEditors(session);
    }
    message = t("hideFailed");
    const notice = document.querySelector<HTMLElement>(".notice");
    if (notice) { notice.textContent = message; notice.classList.add("visible"); }
    console.error(error);
  }
}

function handleAction(button: HTMLButtonElement) {
  const { action, id = "" } = button.dataset;
  if (action === "add-previous") {
    const newId = crypto.randomUUID();
    void change(() => { addTodo(board, "", id, newId); }, editorId(newId));
    return;
  }
  if (action === "restore") {
    void change(() => {
      restoreList(workspace, id);
      board = activeList().board;
      showArchive = false;
    });
    return;
  }
  void change(() => {
    if (action === "toggle") {
      const reset = toggleTodo(board, id);
      if (reset) message = t("resetTasks", { count: reset });
    } else if (action === "delete-task") {
      removeTodo(board, id);
    } else if (action === "archive-list") {
      archiveList(workspace, workspace.activeListId, t("myTodos"));
      board = activeList().board;
      draggedId = null;
    }
  });
}

function focusSibling(input: HTMLTextAreaElement, offset: number) {
  const editors = Array.from(document.querySelectorAll<HTMLTextAreaElement>("[data-edit-todo]"));
  const target = editors[editors.indexOf(input) + offset];
  if (!target) return;
  target.focus();
  target.setSelectionRange(target.value.length, target.value.length);
}

// Keyboard editing: Enter adds a sibling, Tab/Shift+Tab nest or lift a task.
function handleTodoKey(input: HTMLTextAreaElement, event: KeyboardEvent) {
  if (event.isComposing) return;
  const id = input.dataset.editTodo!;
  const todo = board.todos.find((item) => item.id === id);
  if (!todo) return;
  const commit = () => { const title = titleOf(input); if (title) todo.title = title; };
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!titleOf(input)) return;
    const newId = crypto.randomUUID();
    void change(() => { commit(); addSibling(board, id, newId); }, editorId(newId));
  } else if (event.key === "Tab") {
    event.preventDefault();
    if (!titleOf(input)) return;
    void change(() => {
      commit();
      if (event.shiftKey) outdentTodo(board, id); else indentTodo(board, id);
    }, editorId(id));
  } else if (event.key === "Backspace" && !input.value && !todo.title) {
    event.preventDefault();
    focusSibling(input, -1);
    void change(() => { removeTodo(board, id); });
  } else if (event.key === "ArrowUp" && input.selectionStart === 0 && input.selectionEnd === 0) {
    event.preventDefault();
    focusSibling(input, -1);
  } else if (event.key === "ArrowDown" && input.selectionStart === input.value.length) {
    event.preventDefault();
    focusSibling(input, 1);
  } else if (event.key === "Escape") {
    event.stopPropagation();
    input.value = todo.title;
    input.blur();
  }
}

function dropPlace(row: HTMLElement, event: DragEvent): DropPlace {
  const { top, height } = row.getBoundingClientRect();
  const ratio = (event.clientY - top) / height;
  return ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "into";
}

function clearDropMarks() {
  document.querySelectorAll(".is-dragging, .drop-before, .drop-after, .drop-into").forEach((node) => node.classList.remove("is-dragging", "drop-before", "drop-after", "drop-into"));
}

function bindEvents() {
  document.querySelector("#settings-button")!.addEventListener("click", () => { void openSettings(); });
  document.querySelectorAll<HTMLButtonElement>("[data-list]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.list!;
      if (id === workspace.activeListId && !showArchive) return;
      void change(() => {
        const list = workspace.lists.find((item) => item.id === id);
        if (!list || list.archived) return;
        workspace.activeListId = id;
        board = list.board;
        showArchive = false;
        draggedId = null;
      });
    });
  });
  document.querySelector("#new-list")!.addEventListener("click", () => {
    void change(() => {
      const list = createList(t("newList"));
      workspace.lists.push(list);
      workspace.activeListId = list.id;
      board = list.board;
      showArchive = false;
      draggedId = null;
    });
  });
  document.querySelector("#archive-toggle")!.addEventListener("click", () => {
    void change(() => { showArchive = !showArchive; draggedId = null; });
  });
  const listName = document.querySelector<HTMLInputElement>("#list-name")!;
  const listId = workspace.activeListId;
  listName.addEventListener("blur", () => {
    const list = workspace.lists.find((item) => item.id === listId);
    if (!list) return;
    const title = listName.value.trim();
    if (!title || title === list.title) { listName.value = list.title; return; }
    void change(() => {
      const target = workspace.lists.find((item) => item.id === listId);
      if (target) target.title = title;
    }, undefined, false).then(() => {
      const saved = workspace.lists.find((item) => item.id === listId);
      if (!saved) return;
      listName.value = saved.title;
      const tab = document.querySelector<HTMLElement>(`[data-list="${listId}"]`);
      if (tab) { tab.textContent = saved.title; tab.title = saved.title; }
    });
  });
  listName.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); listName.blur(); }
    if (event.key === "Escape") {
      event.stopPropagation();
      listName.value = workspace.lists.find((item) => item.id === listId)?.title ?? "";
      listName.blur();
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.addEventListener("click", (event) => { event.preventDefault(); handleAction(button); });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-delete-list]").forEach((button) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { clearTimeout(timer); timer = undefined; button.classList.remove("is-holding"); };
    const start = () => {
      if (timer) return;
      button.classList.add("is-holding");
      timer = setTimeout(() => {
        timer = undefined;
        button.classList.remove("is-holding");
        if (!button.isConnected) return;
        const id = button.dataset.deleteList!;
        void change(() => {
          deleteList(workspace, id, t("myTodos"));
          board = activeList().board;
          draggedId = null;
        });
      }, 1500);
    };
    button.addEventListener("pointerdown", (event) => { if (event.button === 0) start(); });
    for (const event of ["pointerup", "pointerleave", "pointercancel", "blur"] as const) button.addEventListener(event, cancel);
    button.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") { event.preventDefault(); start(); }
    });
    button.addEventListener("keyup", (event) => {
      if (event.key === " " || event.key === "Enter") { event.preventDefault(); cancel(); }
    });
  });
  document.querySelector("#new-task-button")?.addEventListener("click", () => {
    const newId = crypto.randomUUID();
    void change(() => { addTodo(board, "", null, newId); }, editorId(newId));
  });
  document.querySelectorAll<HTMLTextAreaElement>("[data-edit-todo]").forEach((input) => {
    input.addEventListener("input", () => resizeTodo(input));
    input.addEventListener("blur", () => {
      const id = input.dataset.editTodo!;
      const todo = board.todos.find((item) => item.id === id);
      if (!todo) return;
      const title = titleOf(input);
      // A brand-new task that was left empty is discarded.
      if (!title && !todo.title) { void change(() => { removeTodo(board, id); }); return; }
      if (!title || title === todo.title) { input.value = todo.title; resizeTodo(input); return; }
      // Keep the DOM intact so saving on blur doesn't swallow the next click.
      void change(() => { board.todos.find((item) => item.id === id)!.title = title; }, undefined, false).then(() => {
        const saved = board.todos.find((item) => item.id === id);
        if (!saved) return;
        if (document.activeElement !== input) input.value = saved.title;
        input.setAttribute("aria-label", t("editTodo", { title: saved.title }));
        const row = input.closest(".todo")!;
        row.querySelector(".check")?.setAttribute("aria-label", t("taskLabel", { action: t(saved.completed ? "undoComplete" : "complete"), title: saved.title }));
        row.querySelector(".delete")?.setAttribute("aria-label", t("deleteNamedTodo", { title: saved.title }));
        row.querySelector(".row-action")?.setAttribute("aria-label", t("addPreviousNamed", { title: saved.title }));
        resizeTodo(input);
      });
    });
    input.addEventListener("keydown", (event) => handleTodoKey(input, event));
  });
  document.querySelector("#pin-button")!.addEventListener("click", () => {
    const operation = pendingChange.then(async () => {
      try {
        if (isTauri()) await invoke("set_always_on_top", { value: !pinned });
        pinned = !pinned;
        render();
      } catch { message = t("pinFailed"); render(); }
    });
    pendingChange = operation.catch(console.error);
  });
  document.querySelector("#hide-button")!.addEventListener("click", () => {
    void suspendToTray();
  });
  document.querySelectorAll<HTMLElement>("[data-window-drag]").forEach((region) => {
    region.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest("button, input, textarea, select, a, [contenteditable]")) return;
      event.preventDefault();
      if (isTauri()) void invoke("start_dragging").catch(() => { message = t("dragFailed"); render(); });
    });
  });
  document.querySelectorAll<HTMLElement>("[data-drag]").forEach((handle) => {
    handle.addEventListener("dragstart", (event) => {
      draggedId = handle.dataset.drag!;
      event.dataTransfer?.setData("text/plain", draggedId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      const row = handle.closest<HTMLElement>(".todo");
      row?.classList.add("is-dragging");
      if (row) event.dataTransfer?.setDragImage(row, 0, 0);
    });
    handle.addEventListener("dragend", () => { draggedId = null; clearDropMarks(); });
  });
  document.querySelectorAll<HTMLElement>("[data-todo]").forEach((row) => {
    row.addEventListener("dragover", (event) => {
      if (!draggedId) return;
      const place = dropPlace(row, event);
      row.classList.remove("drop-before", "drop-after", "drop-into");
      if (!canMove(board, draggedId, row.dataset.todo!, place)) return;
      event.preventDefault();
      row.classList.add(`drop-${place}`);
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after", "drop-into"));
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const source = draggedId;
      const place = dropPlace(row, event);
      draggedId = null;
      if (!source) return;
      void change(() => { moveTodo(board, source, row.dataset.todo!, place); });
    });
  });
}

window.addEventListener("resize", () => document.querySelectorAll<HTMLTextAreaElement>("[data-edit-todo]").forEach(resizeTodo));

async function unlockIfNeeded() {
  const status = await invoke<{ locked: boolean }>("vault_status");
  if (!status.locked) return;
  app.innerHTML = `<section class="shell unlock"><div class="unlock-drag" data-window-drag></div><button id="unlock-hide" class="unlock-hide" aria-label="${t("hide")}">−</button><form id="unlock-form"><h1>${t("unlockTitle")}</h1><p>${t("unlockHint")}</p><input id="unlock-password" type="password" autocomplete="current-password" aria-label="${t("password")}" required/><button type="submit">${t("unlock")}</button><p id="unlock-error" role="alert"></p></form></section>`;
  document.querySelector(".unlock-drag")!.addEventListener("pointerdown", () => { void invoke("start_dragging").catch(console.error); });
  document.querySelector("#unlock-hide")!.addEventListener("click", () => { void suspendToTray(); });
  await invoke("main_ready");
  document.querySelector<HTMLInputElement>("#unlock-password")!.focus();
  await new Promise<void>((resolve) => {
    const form = document.querySelector<HTMLFormElement>("#unlock-form")!;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.querySelector<HTMLInputElement>("#unlock-password")!;
      const button = form.querySelector<HTMLButtonElement>("button")!;
      button.disabled = true;
      try { await invoke("unlock_vault", { password: input.value }); input.value = ""; resolve(); }
      catch (error) { console.error(error); input.value = ""; document.querySelector("#unlock-error")!.textContent = t("unlockFailed"); input.focus(); }
      finally { button.disabled = false; }
    });
  });
}

async function start() {
  if (isTauri()) {
    const stopHideListener = await listen("tray-hide-requested", () => { void suspendToTray(); });
    window.addEventListener("pagehide", stopHideListener, { once: true });
  }
  if (isTauri()) await unlockIfNeeded();
  const stored = isTauri() ? await invoke<Workspace | null>("load_board") : JSON.parse(localStorage.getItem(browserKey) ?? "null") as Workspace | null;
  const session = isTauri() ? await invoke<UiSession | null>("load_session") : null;
  workspace = stored ?? createWorkspace(t("myTodos"));
  if (!workspace.lists.length) throw new Error("Invalid workspace");
  for (const list of workspace.lists) normalize(list.board);
  if (!workspace.lists.some((list) => !list.archived)) workspace.lists.push(createList(t("myTodos")));
  if (!workspace.lists.some((list) => list.id === workspace.activeListId && !list.archived)) {
    workspace.activeListId = workspace.lists.find((list) => !list.archived)!.id;
  }
  board = activeList().board;
  if (isTauri() && !stored) await persist();
  restoreSession(session);
  const dispose = await watchSettings(refreshLanguage);
  window.addEventListener("pagehide", dispose, { once: true });
  if (isTauri()) await invoke("set_language", { language: getLanguage() }).catch(() => { message = t("settingsFailed"); });
  render();
  restoreSessionEditors(session);
  initialized = true;
  if (isTauri()) await invoke("main_ready");
}

start().catch((error) => {
  console.error(error);
  document.documentElement.lang = getLanguage();
  app.innerHTML = `<section class="shell error"><strong>${t("loadFailed")}</strong><p>${t("loadFailedHint")}</p></section>`;
  if (isTauri()) void invoke("main_ready").catch(console.error);
});
