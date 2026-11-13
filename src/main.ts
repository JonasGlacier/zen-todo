import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  NOTE_COLORS, addList, addSibling, addTodo, archiveList, canMove, createWorkspace, deleteList, ensureColors, indentTodo,
  isNoteColor, moveTodo, normalize, orderedTodos, outdentTodo, subtasks, reconcile, removeTodo, restoreList, setListColor, toggleTodo,
} from "./board";
import type { Board, DropPlace, NoteColor, Todo, TodoList, Workspace } from "./board";
import { getLanguage, getUiScale, t, watchSettings } from "./i18n";
import { icon } from "./icons";
import { createAiIsland } from "./ai-island";
import { captureEditors, editorsAfterSync, restoreEditors } from "./session";
import type { UiSession } from "./session";
import type { AgentResult, AiProposal } from "./ai";
import { TextHistory, WorkspaceHistory } from "./history";
import type { TextState } from "./history";
import "./styles.css";

const app = document.querySelector<HTMLElement>("#app")!;
const browserKey = "onebyone-board";
let platform: "desktop" | "android" | "ios" = /Android/i.test(navigator.userAgent) ? "android" : /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "ios" : "desktop";
let workspace: Workspace = createWorkspace(t("myTodos"));
let board: Board = workspace.lists[0].board;
let pinned = true;
let pendingChange = Promise.resolve();
let message = "";
let draggedId: string | null = null;
let focusedTodoId: string | null = null;
let showArchive = false;
let settingsWindow: Window | null = null;
let openingSettings = false;
let suspending = false;
let initialized = false;
let saveFailures = 0;
let aiOpen = false;
let aiPrompt = "";
let aiBusy = false;
let aiGeneration = 0;
let aiErrorMessage = "";
let aiIsland: ReturnType<typeof createAiIsland> | undefined;
let suppressEmptyCleanup = false;
const browserHistory = new WorkspaceHistory();
const textHistories = new WeakMap<HTMLInputElement | HTMLTextAreaElement, TextHistory>();
let remoteCount = 0;
let remoteVersion = 0;

const isMobile = () => platform === "android" || platform === "ios";
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]!);
const activeList = () => workspace.lists.find((list) => list.id === workspace.activeListId)!;
const editorId = (id: string) => `todo-${id}`;
const colorOf = (list: TodoList): NoteColor => isNoteColor(list.color) ? list.color : NOTE_COLORS[0];
const colorName = (color: NoteColor) => t(`color_${color}`);
const titleOf = (input: HTMLTextAreaElement) => input.value.replace(/[\r\n]+/g, " ").trim();

async function persist(recordHistory = false) {
  if (isTauri()) await invoke("save_board", { board: workspace, recordHistory });
  else {
    const previous = recordHistory ? JSON.parse(localStorage.getItem(browserKey) ?? "null") as Workspace | null : null;
    localStorage.setItem(browserKey, JSON.stringify(workspace));
    if (previous) browserHistory.record(previous, workspace);
  }
}

// Queue edits and clicks so a slow disk save never discards the next action.
function change(mutate: () => void, focus?: string, renderAfter = true): Promise<void> {
  const operation = pendingChange.then(async () => {
    const previous = structuredClone(workspace);
    try {
      message = "";
      mutate();
      reconcile(board);
      await persist(true);
    } catch (error) {
      saveFailures++;
      workspace = previous;
      board = activeList().board;
      message = t("saveFailed");
      console.error(error);
    } finally {
      if (renderAfter) render();
      else {
        refreshStatus();
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
  const children = subtasks(board, todo.id);
  const partial = !todo.completed && orderedTodos(board, todo.id).some((child) => child.completed);
  const label = escapeHtml(todo.title);
  return `<div class="todo ${todo.completed ? "is-completed" : ""}" data-todo="${todo.id}">
    <span class="drag-handle" data-drag="${todo.id}" title="${t("reorder")}" aria-hidden="true">${icon("grip")}</span>
    <button class="check ${todo.completed ? "checked" : ""} ${partial ? "is-partial" : ""}" data-action="toggle" data-id="${todo.id}"
      role="checkbox" aria-checked="${partial ? "mixed" : todo.completed}" aria-label="${escapeHtml(t("taskLabel", { action: t(todo.completed ? "undoComplete" : "complete"), title: todo.title }))}"
      title="${children.length ? t("toggleSubtasks") : ""}">${todo.completed ? icon("check") : partial ? icon("hide") : ""}</button>
    <textarea class="todo-title" id="${editorId(todo.id)}" data-edit-todo="${todo.id}" aria-label="${escapeHtml(t("editTodo", { title: todo.title }))}" placeholder="${t("todoPlaceholder")}" rows="1" maxlength="200" spellcheck="false">${label}</textarea>
    ${children.length ? `<span class="task-progress" aria-label="${t("subtaskProgress", { done: children.filter((child) => child.completed).length, total: children.length })}">${children.filter((child) => child.completed).length}/${children.length}</span>` : ""}
    <button class="row-action" data-action="add-subtask" data-id="${todo.id}" title="${t("addSubtask")}" aria-label="${escapeHtml(t("addSubtaskNamed", { title: todo.title }))}">${icon("subtask")}</button>
    <button class="delete" data-action="delete-task" data-id="${todo.id}" title="${t("deleteTodo")}" aria-label="${escapeHtml(t("deleteNamedTodo", { title: todo.title }))}">${icon("close")}</button>
  </div>`;
}

// Parents appear first, followed by their indented subtasks.
function nodeTemplate(todo: Todo): string {
  const children = subtasks(board, todo.id);
  return `<div class="node" id="node-${todo.id}">${todoRow(todo)}${children.length ? `<div class="children">${children.map(nodeTemplate).join("")}</div>` : ""}</div>`;
}

function archivedNodes(archivedBoard: Board, parentId: string | null = null): string {
  return archivedBoard.todos.filter((todo) => todo.parentId === parentId).map((todo) => {
    const children = archivedNodes(archivedBoard, todo.id);
    return `<li><span class="${todo.completed ? "is-completed" : ""}">${escapeHtml(todo.title) || "&nbsp;"}</span>${children ? `<ul>${children}</ul>` : ""}</li>`;
  }).join("");
}

function archiveTemplate(): string {
  const archived = workspace.lists.filter((list) => list.archived);
  const items = archived.map((list) => {
    const done = list.board.todos.filter((todo) => todo.completed).length;
    const name = escapeHtml(list.title);
    const tasks = list.board.todos.length
      ? archivedNodes(list.board)
      : `<li class="muted">${t("emptyArchivedList")}</li>`;
    return `<section class="archived-list" data-color="${colorOf(list)}">
      <div class="archived-header"><div class="archived-info"><span class="archived-name" title="${name}">${name}</span><span class="archived-meta">${t("archivedProgress", { done, total: list.board.todos.length })}</span></div>
        <button class="restore-button" data-action="restore" data-id="${list.id}" title="${escapeHtml(t("restoreNamed", { title: list.title }))}" aria-label="${escapeHtml(t("restoreNamed", { title: list.title }))}">${icon("restore")} ${t("restoreList")}</button>
        <button class="delete-list-button icon-hold" data-delete-list="${list.id}" title="${t("holdDeleteListHint")}" aria-label="${escapeHtml(t("holdDeleteNamedList", { title: list.title }))}">${icon("trash")}</button></div>
      <ul class="archived-tasks">${tasks}</ul>
    </section>`;
  }).join("");
  return `<div class="list archive-panel" id="todo-list">
    <div class="archive-heading"><button class="back-button" id="archive-back" title="${t("backToList")}" aria-label="${t("backToList")}">${icon("back")}</button><strong>${t("archivedLists")}</strong><span class="archived-meta">${archived.length}</span></div>
    ${archived.length ? `<p class="archive-hint">${t("archivedHint")}</p>${items}` : `<div class="empty"><span>${icon("archive")}</span><strong>${t("archivedEmpty")}</strong></div>`}
  </div>`;
}

function updateMobileToolbarVisibility() {
  const bar = document.querySelector<HTMLElement>("#mobile-edit-bar");
  if (!bar) return;
  const active = document.activeElement;
  focusedTodoId = active instanceof HTMLTextAreaElement && active.dataset.editTodo ? active.dataset.editTodo : null;
  bar.hidden = !focusedTodoId || showArchive;
  updateMobileToolbarPosition();
}

function updateMobileToolbarPosition() {
  const bar = document.querySelector<HTMLElement>("#mobile-edit-bar");
  if (!bar || bar.hidden) return;
  const view = window.visualViewport;
  const bottom = view ? view.offsetTop + view.height : window.innerHeight;
  const width = view?.width ?? window.innerWidth;
  const left = view?.offsetLeft ?? 0;
  // Coordinates from VisualViewport are rendered pixels; CSS zoom scales the
  // toolbar too. Anchor its bottom to the *visible* viewport, not the layout
  // viewport that can extend behind Android's IME in edge-to-edge mode.
  const zoom = getUiScale() / 100;
  bar.style.width = `${Math.min(360, (width - 24) / zoom)}px`;
  bar.style.left = `${(left + width / 2) / zoom}px`;
  bar.style.top = `${Math.max(0, bottom / zoom - bar.offsetHeight - 8)}px`;

  const active = document.activeElement;
  const list = document.querySelector<HTMLElement>(".list");
  if (active instanceof HTMLTextAreaElement && active.dataset.editTodo && list) {
    const overlap = active.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 8;
    if (overlap > 0) list.scrollTop += overlap / zoom;
  }
}

let toolbarPositionFrame = 0;
function scheduleMobileToolbarPosition() {
  cancelAnimationFrame(toolbarPositionFrame);
  toolbarPositionFrame = requestAnimationFrame(updateMobileToolbarPosition);
}
window.visualViewport?.addEventListener("resize", scheduleMobileToolbarPosition);
window.visualViewport?.addEventListener("scroll", scheduleMobileToolbarPosition);
window.addEventListener("resize", scheduleMobileToolbarPosition);

function render() {
  document.documentElement.lang = getLanguage();
  document.documentElement.dataset.platform = platform;
  const listScroll = document.querySelector(".list")?.scrollTop ?? 0;
  const list = activeList();
  const visibleLists = workspace.lists.filter((item) => !item.archived);
  const archivedCount = workspace.lists.length - visibleLists.length;
  const pending = board.todos.filter((todo) => !todo.completed);
  const completed = board.todos.length - pending.length;
  const roots = board.todos.filter((todo) => todo.parentId === null);
  const color = colorOf(list);
  const status = pending.length ? t("taskProgress", { done: completed, total: board.todos.length }) : t(completed ? "allDone" : "takeYourTime");
  const swatches = NOTE_COLORS.map((item) => `<button class="swatch ${item === color ? "is-selected" : ""}" data-color="${item}" data-set-color="${item}" aria-pressed="${item === color}" title="${colorName(item)}" aria-label="${colorName(item)}">${item === color ? icon("check") : ""}</button>`).join("");
  const emptyDesc = isMobile() ? t("emptyDescriptionMobile") : t("emptyDescription");
  const androidAi = platform === "android";
  const aiPanel = aiOpen && !androidAi ? `<form class="ai-panel" id="ai-panel">
    <label class="sr-only" for="ai-prompt">${t("ai")}</label>
    <textarea id="ai-prompt" rows="2" maxlength="2000" placeholder="${t("aiPlaceholder")}" ${aiBusy ? "readonly" : ""}>${escapeHtml(aiPrompt)}</textarea>
    <div class="ai-controls"><span role="status">${aiBusy ? t("aiThinking") : t("aiSettingsHint")}</span><button type="${aiBusy ? "button" : "submit"}" id="ai-run">${t(aiBusy ? "cancel" : "aiRun")}</button></div>
  </form>` : "";
  const content = showArchive ? archiveTemplate() : `<article class="note" data-color="${color}">
      <header class="note-header" data-window-drag><div class="heading"><input class="list-name" id="list-name" value="${escapeHtml(list.title)}" aria-label="${t("listName")}" title="${t("renameList")}" maxlength="80"/><span class="status">${status}</span></div>
        ${!androidAi ? `<button class="icon-button ${aiOpen ? "is-active" : ""}" id="ai-button" title="${t("aiOpen")}" aria-label="${t("aiOpen")}" aria-expanded="${aiOpen}" aria-controls="ai-panel">${icon("ai")}</button>` : ""}
        <div class="color-picker"><button class="icon-button" id="color-button" title="${t("noteColorNamed", { color: colorName(color) })}" aria-label="${t("noteColorNamed", { color: colorName(color) })}" aria-haspopup="true" aria-expanded="false" aria-controls="palette">${icon("palette")}</button>
          <div class="palette" id="palette" role="group" aria-label="${t("noteColor")}" hidden>${swatches}</div></div>
      </header>
      ${!androidAi ? aiPanel : ""}
      <div class="list" id="todo-list" role="tabpanel">${roots.length ? roots.map(nodeTemplate).join("") : `<div class="empty"><span>${icon("empty")}</span><strong>${t("emptyTitle")}</strong><p>${emptyDesc}</p></div>`}
        <button class="new-task-button" id="new-task-button">${icon("plus")} ${t("newTodo")}</button>
        <div class="list-actions"><button class="archive-list-button" data-action="archive-list" title="${t("archiveListHint")}">${icon("archive")} ${t("archiveList")}</button>
        <button class="delete-list-button" data-delete-list="${list.id}" title="${t("holdDeleteListHint")}">${t("holdDeleteList")}</button></div>
      </div>
    </article>`;
  app.innerHTML = `<section class="shell">
    <header class="titlebar">
      ${isMobile() ? `<span class="mobile-brand">OneByOne</span>` : `<div class="window-drag-region" data-window-drag title="${t("dragWindow")}" aria-label="${t("dragWindow")}"><span></span></div>`}
      <div class="window-actions">
        <button class="icon-button" id="undo-button" title="${t("undoShortcut")}" aria-label="${t("undo")}">${icon("undo")}</button>
        <button class="icon-button" id="settings-button" title="${t("settings")}" aria-label="${t("settings")}">${icon("settings")}</button>
        ${!isMobile() ? `<button class="icon-button ${pinned ? "is-active" : ""}" id="pin-button" title="${t(pinned ? "unpin" : "pin")}" aria-label="${t(pinned ? "unpin" : "pin")}" aria-pressed="${pinned}">${icon(pinned ? "pin" : "pinOff")}</button><button class="icon-button" id="hide-button" title="${t("hide")}" aria-label="${t("hide")}">${icon("hide")}</button>` : ""}
      </div>
    </header>
    <div class="workspace">
    ${content}
    <div class="tabs-bar">
      <div class="tabs" role="tablist" aria-label="${t("todoLists")}">${visibleLists.map((item) => `<button class="tab ${!showArchive && item.id === workspace.activeListId ? "is-selected" : ""}" role="tab" data-color="${colorOf(item)}" aria-selected="${!showArchive && item.id === workspace.activeListId}" aria-controls="todo-list" data-list="${item.id}" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</button>`).join("")}</div>
      <button class="tab-action" id="new-list" title="${t("newList")}" aria-label="${t("newList")}">${icon("plus")}</button>
      <button class="tab-action ${showArchive ? "is-active" : ""}" id="archive-toggle" title="${t("archived")}${archivedCount ? ` · ${archivedCount}` : ""}" aria-label="${t("archived")}" aria-pressed="${showArchive}">${icon("archive")}</button>
    </div>
    </div>
    <div class="mobile-edit-bar" id="mobile-edit-bar" hidden>
      <button type="button" data-mobile-edit="outdent" title="${t("outdentTask")}" aria-label="${t("outdentTask")}">${icon("outdent")}</button>
      <button type="button" data-mobile-edit="indent" title="${t("indentTask")}" aria-label="${t("indentTask")}">${icon("indent")}</button>
      <button type="button" data-mobile-edit="subtask" title="${t("addSubtask")}" aria-label="${t("addSubtask")}">${icon("subtask")}</button>
      <button type="button" data-mobile-edit="sibling" title="${t("addSiblingTask")}" aria-label="${t("addSiblingTask")}">${icon("sibling")}</button>
      <button type="button" class="mobile-edit-danger" data-mobile-edit="delete" title="${t("deleteTodo")}" aria-label="${t("deleteTodo")}">${icon("trash")}</button>
    </div>
    <footer class="footer"><span id="workspace-status" role="status" title="${escapeHtml(message)}">${escapeHtml(message || t("footer", { count: pending.length }))}</span><span>${t("stayFocused")}</span></footer>
  </section>`;
  bindEvents();
  document.querySelectorAll<HTMLTextAreaElement>("[data-edit-todo]").forEach(resizeTodo);
  document.querySelector(".list")!.scrollTop = listScroll;
  updateMobileToolbarVisibility();
  updateAiIsland();
}

function updateAiIsland() {
  if (platform !== "android") return;
  aiIsland ??= createAiIsland({
    toggle: toggleAi,
    input: (value) => { aiPrompt = value; },
    run: () => { void runAi(); },
    cancel: cancelAi,
  });
  aiIsland.update({ open: aiOpen, busy: aiBusy, prompt: aiPrompt, error: aiErrorMessage });
}

function refreshStatus() {
  const status = document.querySelector<HTMLElement>("#workspace-status");
  if (!status) return;
  status.textContent = message || t("footer", { count: board.todos.filter((todo) => !todo.completed).length });
  status.title = message;
}

function renderKeepingEditors() {
  const editors = captureEditors();
  render();
  restoreEditors(editors, resizeTodo);
  updateMobileToolbarVisibility();
}

function blurEditor() {
  if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) document.activeElement.blur();
}

function reloadFromSync() {
  if (!isTauri() || suspending) return;
  const operation = pendingChange.then(async () => {
    try {
      const stored = await invoke<Workspace | null>("load_board");
      if (!stored || !stored.lists.length) return;
      const previous = workspace;
      // Capture after the asynchronous load so typing during it is preserved.
      const editors = captureEditors();
      workspace = stored;
      for (const list of workspace.lists) normalize(list.board);
      if (!workspace.lists.some((list) => !list.archived)) addList(workspace, t("myTodos"));
      ensureColors(workspace);
      if (!workspace.lists.some((list) => list.id === workspace.activeListId && !list.archived)) {
        workspace.activeListId = workspace.lists.find((list) => !list.archived)!.id;
      }
      board = activeList().board;
      remoteVersion++;
      message = t("syncUpdatedBanner");
      const restoredEditors = editorsAfterSync(editors, previous, workspace);
      render();
      restoreEditors(restoredEditors, resizeTodo);
      updateMobileToolbarVisibility();
    } catch (error) {
      console.error(error);
    }
  });
  pendingChange = operation.catch(console.error);
}

// Remote writes use the manual save queue. Rust owns the shared action engine
// and the shared history. Tray mode deliberately retains no undo snapshots.
function remoteOperation(command: string, args: Record<string, unknown>, success: string): Promise<boolean> {
  const failures = saveFailures;
  const undoRequested = command === "agent_execute" && (args.request as { command?: string } | undefined)?.command === "undo";
  const focusedEditor = document.activeElement?.id;
  suppressEmptyCleanup = undoRequested;
  blurEditor();
  suppressEmptyCleanup = false;
  remoteCount++;
  app.inert = true;
  let succeeded = false;
  const operation = pendingChange.then(async () => {
    const before = workspace;
    try {
      if (command === "execute_cli_request") args.reject = suspending || failures !== saveFailures;
      else if (suspending || failures !== saveFailures) throw new Error(t("saveFailed"));
      let result: AgentResult;
      if (undoRequested && !isTauri()) {
        const target = browserHistory.target(workspace);
        if (!target) throw new Error("Nothing to undo");
        localStorage.setItem(browserKey, JSON.stringify(target));
        browserHistory.didUndo(target);
        result = { command: "undo", workspace: target, revision: "", ...browserHistory.status(target) };
      } else result = await invoke<AgentResult>(command, args);
      workspace = result.workspace;
      board = activeList().board;
      if (result.command !== "list") showArchive = false;
      if (result.command !== "list") remoteVersion++;
      draggedId = null;
      if (result.command !== "list") message = result.command === "undo" ? t("undoDone") : success;
      succeeded = true;
    } catch (error) {
      message = String(error).includes("Nothing to undo") ? t("nothingToUndo")
        : String(error).includes("Conflict:") ? t("aiConflict") : t(undoRequested ? "undoFailed" : "aiFailed", { error: String(error) });
    }
    remoteCount--;
    if (!suspending) {
      app.inert = remoteCount > 0;
      if (succeeded) {
        render();
        if (undoRequested && remoteCount === 0) focusAfterUndo(before, focusedEditor);
      } else renderKeepingEditors();
    }
  });
  pendingChange = operation.catch(console.error);
  return operation.then(() => succeeded);
}

function undoWorkspace() {
  return remoteOperation("agent_execute", { request: { command: "undo" } }, t("undoDone"));
}

function focusAfterUndo(before: Workspace, previousFocus?: string) {
  const list = activeList();
  const old = before.lists.find((item) => item.id === list.id);
  const restored = list.board.todos.find((todo) => !old?.board.todos.some((item) => item.id === todo.id));
  const edited = list.board.todos.find((todo) => old?.board.todos.some((item) => item.id === todo.id && item.title !== todo.title));
  const id = restored?.id ?? edited?.id;
  const target = id ? document.getElementById(editorId(id)) : old?.title !== list.title ? document.getElementById("list-name")
    : previousFocus ? document.getElementById(previousFocus) : null;
  (target ?? document.querySelector<HTMLElement>("[data-edit-todo], #list-name"))?.focus();
}

function toggleAi() {
  if (platform === "android") {
    if (aiBusy) cancelAi();
    aiOpen = !aiOpen;
    updateAiIsland();
    return;
  }
  blurEditor();
  const operation = pendingChange.then(() => {
    aiOpen = !aiOpen;
    showArchive = false;
    render();
    if (aiOpen) document.querySelector<HTMLTextAreaElement>("#ai-prompt")?.focus();
  });
  pendingChange = operation.catch(console.error);
}

function cancelAi() {
  aiGeneration++;
  aiBusy = false;
  message = t("aiCancelled");
  renderKeepingEditors();
}

async function runAi() {
  if (aiBusy || !aiPrompt.trim()) return;
  if (!isTauri()) { message = t("aiDesktopOnly"); aiErrorMessage = message; renderKeepingEditors(); return; }
  const failures = saveFailures;
  if (platform !== "android") blurEditor();
  aiBusy = true;
  aiErrorMessage = "";
  const generation = ++aiGeneration;
  const prompt = aiPrompt;
  renderKeepingEditors();
  try {
    await pendingChange;
    if (failures !== saveFailures) throw new Error(t("saveFailed"));
    const proposal = await invoke<AiProposal>("run_ai_prompt", { prompt });
    if (generation !== aiGeneration || suspending) return;
    const applied = await remoteOperation("agent_execute", { request: { command: "apply", ...proposal } }, t("aiUpdated"));
    if (applied) { aiOpen = false; aiPrompt = ""; }
    else aiErrorMessage = message;
  } catch (error) {
    if (generation === aiGeneration) { message = t("aiFailed", { error: String(error) }); aiErrorMessage = message; }
  } finally {
    if (generation === aiGeneration && !suspending) { aiBusy = false; renderKeepingEditors(); }
  }
}

function resizeTodo(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

async function openSettings() {
  if (openingSettings) return;
  openingSettings = true;
  try {
    blurEditor();
    await pendingChange;
    if (isTauri()) {
      const openedWindow = await invoke<boolean>("open_settings", { language: getLanguage() });
      if (!openedWindow) {
        const url = new URL(window.location.href);
        url.searchParams.set("view", "settings");
        window.location.assign(url.toString());
        return;
      }
    } else if (isMobile()) {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "settings");
      window.location.assign(url.toString());
      return;
    } else if (settingsWindow && !settingsWindow.closed) {
      settingsWindow.focus();
    } else {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "settings");
      settingsWindow = window.open(url, "onebyone-settings", "popup,width=640,height=480,resizable=yes,scrollbars=yes");
      if (!settingsWindow) throw new Error("Settings popup blocked");
    }
  } catch (error) {
    message = t("openSettingsFailed");
    refreshStatus();
    console.error(error);
  } finally { openingSettings = false; }
}

function refreshLanguage() {
  const operation = pendingChange.then(() => {
    const fields = captureEditors();
    message = "";
    render();
    restoreEditors(fields, resizeTodo);
    updateMobileToolbarVisibility();
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
  updateMobileToolbarVisibility();
}

async function suspendToTray() {
  if (!isTauri() || isMobile() || suspending) return;
  suspending = true;
  aiGeneration++;
  aiBusy = false;
  const failures = saveFailures;
  const capturedVersion = remoteVersion;
  const session: UiSession | null = initialized ? {
    version: 1, listId: document.querySelector<HTMLElement>(".tab.is-selected")?.dataset.list ?? workspace.activeListId, pinned,
    scrollTop: document.querySelector(".list")?.scrollTop ?? 0,
    editors: captureEditors(),
  } : null;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  app.inert = true;
  try {
    await pendingChange;
    if (saveFailures !== failures) throw new Error("Pending save failed");
    if (session && capturedVersion !== remoteVersion) { session.editors = []; session.listId = workspace.activeListId; }
    if (session) session.pinned = pinned;
    if (initialized) await persist();
    await invoke("hide_window", { session });
    browserHistory.clear();
  } catch (error) {
    suspending = false;
    app.inert = false;
    if (initialized) {
      restoreSession(session);
      render();
      restoreSessionEditors(session);
    }
    message = t("hideFailed");
    refreshStatus();
    console.error(error);
  }
}

function handleAction(button: HTMLButtonElement) {
  const { action, id = "" } = button.dataset;
  if (action === "add-subtask") {
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
      toggleTodo(board, id);
    } else if (action === "delete-task") {
      removeTodo(board, id);
    } else if (action === "archive-list") {
      archiveList(workspace, workspace.activeListId, t("myTodos"));
      board = activeList().board;
      draggedId = null;
    }
  });
}

function handleMobileEditAction(kind: string) {
  const active = document.activeElement;
  if (!(active instanceof HTMLTextAreaElement) || !active.dataset.editTodo) return;
  const id = active.dataset.editTodo;
  const todo = board.todos.find((item) => item.id === id);
  if (!todo) return;
  const title = titleOf(active);
  const commitCurrent = () => {
    if (title && title !== todo.title) {
      const target = board.todos.find((item) => item.id === id);
      if (target) target.title = title;
    }
    textHistories.delete(active);
  };
  if (kind === "indent") {
    if (!title && !todo.title) return;
    void change(() => { commitCurrent(); indentTodo(board, id); }, editorId(id));
  } else if (kind === "outdent") {
    if (!title && !todo.title) return;
    void change(() => { commitCurrent(); outdentTodo(board, id); }, editorId(id));
  } else if (kind === "subtask") {
    if (!title && !todo.title) return;
    const newId = crypto.randomUUID();
    void change(() => { commitCurrent(); addTodo(board, "", id, newId); }, editorId(newId));
  } else if (kind === "sibling") {
    if (!title && !todo.title) return;
    const newId = crypto.randomUUID();
    void change(() => { commitCurrent(); addSibling(board, id, newId); }, editorId(newId));
  } else if (kind === "delete") {
    focusSibling(active, -1);
    void change(() => { removeTodo(board, id); });
  }
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
  const commit = () => {
    const title = titleOf(input);
    if (title && title !== todo.title) {
      void change(() => { const target = board.todos.find((item) => item.id === id); if (target) target.title = title; }, undefined, false);
    }
    textHistories.delete(input);
  };
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (!titleOf(input)) return;
    commit();
    const newId = crypto.randomUUID();
    void change(() => { addSibling(board, id, newId); }, editorId(newId));
  } else if (event.key === "Tab") {
    event.preventDefault();
    if (!titleOf(input)) return;
    commit();
    void change(() => {
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

function dropPlaceByY(row: HTMLElement, clientY: number): DropPlace {
  const { top, height } = row.getBoundingClientRect();
  const ratio = (clientY - top) / Math.max(height, 1);
  return ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "into";
}

function clearDropMarks() {
  document.querySelectorAll(".is-dragging, .drop-before, .drop-after, .drop-into").forEach((node) => node.classList.remove("is-dragging", "drop-before", "drop-after", "drop-into"));
}

function bindPointerDrag() {
  document.querySelectorAll<HTMLElement>("[data-drag]").forEach((handle) => {
    let activePointerId: number | null = null;
    let startY = 0;
    let started = false;
    let targetTodoId: string | null = null;
    let targetPlace: DropPlace | null = null;

    const cleanup = () => {
      activePointerId = null;
      started = false;
      draggedId = null;
      targetTodoId = null;
      targetPlace = null;
      clearDropMarks();
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      event.preventDefault();
      event.stopPropagation();
      activePointerId = event.pointerId;
      startY = event.clientY;
      started = false;
      targetTodoId = null;
      targetPlace = null;
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
      if (activePointerId !== event.pointerId) return;
      if (!started) {
        if (Math.abs(event.clientY - startY) < 4) return;
        started = true;
        draggedId = handle.dataset.drag!;
        blurEditor();
        handle.closest<HTMLElement>(".todo")?.classList.add("is-dragging");
      }
      if (!draggedId) return;

      const listEl = document.querySelector<HTMLElement>(".list");
      if (listEl) {
        const rect = listEl.getBoundingClientRect();
        if (event.clientY < rect.top + 28) listEl.scrollTop -= 8;
        else if (event.clientY > rect.bottom - 28) listEl.scrollTop += 8;
      }

      document.querySelectorAll(".drop-before, .drop-after, .drop-into").forEach((el) => el.classList.remove("drop-before", "drop-after", "drop-into"));
      targetTodoId = null;
      targetPlace = null;

      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-todo]");
      if (!hit) return;
      const candidateId = hit.dataset.todo!;
      const place = dropPlaceByY(hit, event.clientY);
      if (!canMove(board, draggedId, candidateId, place)) return;
      hit.classList.add(`drop-${place}`);
      targetTodoId = candidateId;
      targetPlace = place;
    });

    handle.addEventListener("pointerup", (event) => {
      if (activePointerId !== event.pointerId) return;
      const source = draggedId;
      const dest = targetTodoId;
      const place = targetPlace;
      cleanup();
      if (source && dest && place) {
        void change(() => { moveTodo(board, source, dest, place); });
      }
    });

    handle.addEventListener("pointercancel", (event) => {
      if (activePointerId === event.pointerId) cleanup();
    });
  });
}

function setPalette(open: boolean) {
  const palette = document.querySelector<HTMLElement>("#palette");
  if (!palette) return;
  palette.hidden = !open;
  document.querySelector("#color-button")!.setAttribute("aria-expanded", String(open));
  if (open) palette.querySelector<HTMLElement>(".swatch.is-selected")?.focus();
}

function bindPalette() {
  const button = document.querySelector<HTMLButtonElement>("#color-button");
  if (!button) return;
  button.addEventListener("click", () => setPalette(document.querySelector<HTMLElement>("#palette")!.hidden));
  document.querySelector(".color-picker")!.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    event.stopPropagation();
    setPalette(false);
    button.focus();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-set-color]").forEach((swatch) => {
    swatch.addEventListener("click", () => {
      const color = swatch.dataset.setColor;
      if (!isNoteColor(color)) return;
      const id = workspace.activeListId;
      if (color === colorOf(activeList())) { setPalette(false); button.focus(); return; }
      void change(() => { setListColor(workspace, id, color); }, "color-button");
    });
  });
}

// Clicking anywhere outside the open palette closes it without re-rendering.
document.addEventListener("pointerdown", (event) => {
  if (!(event.target as Element).closest?.(".color-picker")) setPalette(false);
});

function bindEvents() {
  document.querySelector("#ai-button")?.addEventListener("click", toggleAi);
  document.querySelector<HTMLTextAreaElement>("#ai-prompt")?.addEventListener("input", (event) => { aiPrompt = (event.target as HTMLTextAreaElement).value; });
  document.querySelector("#ai-panel")?.addEventListener("submit", (event) => { event.preventDefault(); void runAi(); });
  document.querySelector("#ai-run")?.addEventListener("click", () => { if (aiBusy) cancelAi(); });
  document.querySelector("#ai-prompt")?.addEventListener("keydown", (event) => {
    const key = event as KeyboardEvent;
    if (key.isComposing) return;
    if (key.key === "Enter" && !key.shiftKey) { key.preventDefault(); void runAi(); }
    if (key.key === "Escape") { key.stopPropagation(); if (aiBusy) cancelAi(); else toggleAi(); }
  });
  document.querySelector("#undo-button")?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (!undoText()) void undoWorkspace();
  });
  document.querySelector("#settings-button")!.addEventListener("click", () => { void openSettings(); });
  document.querySelectorAll<HTMLButtonElement>("[data-mobile-edit]").forEach((btn) => {
    btn.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      handleMobileEditAction(btn.dataset.mobileEdit!);
    });
  });
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
      const list = addList(workspace, t("newList"));
      workspace.activeListId = list.id;
      board = list.board;
      showArchive = false;
      draggedId = null;
    });
  });
  bindPalette();
  document.querySelector("#archive-back")?.addEventListener("click", () => { void change(() => { showArchive = false; }); });
  document.querySelector("#archive-toggle")!.addEventListener("click", () => {
    void change(() => { showArchive = !showArchive; draggedId = null; });
  });
  const listName = document.querySelector<HTMLInputElement>("#list-name");
  const listId = workspace.activeListId;
  listName?.addEventListener("blur", () => {
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
  listName?.addEventListener("keydown", (event) => {
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
      if (!title && !todo.title) { if (!suppressEmptyCleanup) void change(() => { removeTodo(board, id); }); return; }
      if (!title || title === todo.title) { input.value = todo.title; resizeTodo(input); return; }
      void change(() => { board.todos.find((item) => item.id === id)!.title = title; }, undefined, false).then(() => {
        const saved = board.todos.find((item) => item.id === id);
        if (!saved) return;
        if (document.activeElement !== input) input.value = saved.title;
        input.setAttribute("aria-label", t("editTodo", { title: saved.title }));
        const row = input.closest(".todo")!;
        row.querySelector(".check")?.setAttribute("aria-label", t("taskLabel", { action: t(saved.completed ? "undoComplete" : "complete"), title: saved.title }));
        row.querySelector(".delete")?.setAttribute("aria-label", t("deleteNamedTodo", { title: saved.title }));
        row.querySelector(".row-action")?.setAttribute("aria-label", t("addSubtaskNamed", { title: saved.title }));
        resizeTodo(input);
      });
    });
    input.addEventListener("keydown", (event) => handleTodoKey(input, event));
  });
  document.querySelector("#pin-button")?.addEventListener("click", () => {
    const operation = pendingChange.then(async () => {
      try {
        if (isTauri()) await invoke("set_always_on_top", { value: !pinned });
        pinned = !pinned;
        render();
      } catch { message = t("pinFailed"); render(); }
    });
    pendingChange = operation.catch(console.error);
  });
  document.querySelector("#hide-button")?.addEventListener("click", () => {
    void suspendToTray();
  });
  document.querySelectorAll<HTMLElement>("[data-window-drag]").forEach((region) => {
    region.addEventListener("pointerdown", (event) => {
      if (isMobile() || event.button !== 0 || (event.target as Element).closest("button, input, textarea, select, a, [contenteditable]")) return;
      event.preventDefault();
      if (isTauri()) void invoke("start_dragging").catch(() => { message = t("dragFailed"); render(); });
    });
  });
  bindPointerDrag();
}

function textEditor(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  return (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    && target.matches("#list-name, [data-edit-todo], #ai-prompt") && !target.readOnly && !target.disabled ? target : null;
}

function textState(input: HTMLInputElement | HTMLTextAreaElement): TextState {
  return { value: input.value, start: input.selectionStart, end: input.selectionEnd };
}

document.addEventListener("focusin", (event) => {
  const input = textEditor(event.target);
  if (input) textHistories.set(input, new TextHistory(textState(input)));
  updateMobileToolbarVisibility();
});
document.addEventListener("focusout", (event) => {
  const input = textEditor(event.target);
  if (input) textHistories.delete(input);
  setTimeout(updateMobileToolbarVisibility, 0);
});
document.addEventListener("beforeinput", (event) => {
  const input = textEditor(event.target);
  if (!input) return;
  const history = textHistories.get(input) ?? new TextHistory(textState(input));
  textHistories.set(input, history);
  history.beforeInput(textState(input));
}, true);
document.addEventListener("input", (event) => {
  const input = textEditor(event.target);
  if (input) textHistories.get(input)?.input(textState(input), (event as InputEvent).inputType ?? "");
}, true);

function undoText(): boolean {
  const input = textEditor(document.activeElement);
  if (!input) return false;
  let previous = textHistories.get(input)?.undo(input.value);
  const saved = input.id === "list-name" ? activeList().title
    : input.dataset.editTodo ? board.todos.find((todo) => todo.id === input.dataset.editTodo)?.title : undefined;
  if (!previous && saved !== undefined && input.value !== saved) {
    previous = { value: saved, start: saved.length, end: saved.length };
    textHistories.set(input, new TextHistory(previous));
  }
  if (!previous) return false;
  input.value = previous.value;
  input.setSelectionRange(previous.start, previous.end);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "historyUndo" }));
  return true;
}

window.addEventListener("resize", () => document.querySelectorAll<HTMLTextAreaElement>("[data-edit-todo]").forEach(resizeTodo));
document.addEventListener("keydown", (event) => {
  if (event.isComposing || !initialized || suspending || event.altKey) return;
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (!undoText()) void undoWorkspace();
    return;
  }
  if (initialized && !suspending && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    toggleAi();
  }
});

async function unlockIfNeeded() {
  const status = await invoke<{ locked: boolean }>("vault_status");
  if (!status.locked) return;
  app.innerHTML = `<section class="shell unlock">${!isMobile() ? `<div class="unlock-drag" data-window-drag></div><button id="unlock-hide" class="unlock-hide" aria-label="${t("hide")}">−</button>` : ""}<form id="unlock-form"><h1>${t("unlockTitle")}</h1><p>${t("unlockHint")}</p><input id="unlock-password" type="password" autocomplete="current-password" aria-label="${t("password")}" required/><button type="submit">${t("unlock")}</button><p id="unlock-error" role="alert"></p></form></section>`;
  document.querySelector(".unlock-drag")?.addEventListener("pointerdown", () => { void invoke("start_dragging").catch(console.error); });
  document.querySelector("#unlock-hide")?.addEventListener("click", () => { void suspendToTray(); });
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
    platform = await invoke<"desktop" | "android" | "ios">("get_platform").catch(() => "desktop");
    document.documentElement.dataset.platform = platform;
    if (!isMobile()) {
      const stopHideListener = await listen("tray-hide-requested", () => { void suspendToTray(); });
      window.addEventListener("pagehide", stopHideListener, { once: true });
    }
  }
  if (isTauri()) await unlockIfNeeded();
  const stored = isTauri() ? await invoke<Workspace | null>("load_board") : JSON.parse(localStorage.getItem(browserKey) ?? "null") as Workspace | null;
  const session = isTauri() && !isMobile() ? await invoke<UiSession | null>("load_session") : null;
  workspace = stored ?? createWorkspace(t("myTodos"));
  if (!workspace.lists.length) throw new Error("Invalid workspace");
  let normalized = false;
  for (const list of workspace.lists) normalized = normalize(list.board) || normalized;
  if (!workspace.lists.some((list) => !list.archived)) addList(workspace, t("myTodos"));
  const recolored = ensureColors(workspace);
  if (!workspace.lists.some((list) => list.id === workspace.activeListId && !list.archived)) {
    workspace.activeListId = workspace.lists.find((list) => !list.archived)!.id;
  }
  board = activeList().board;
  if (!stored || recolored || normalized) await persist().catch(console.error);
  if (isTauri()) {
    const stopCliListener = await listen<string>("cli-request", ({ payload }) => {
      void remoteOperation("execute_cli_request", { id: payload, reject: false }, t("aiUpdated"));
    });
    const stopSyncListener = await listen("sync-updated", () => {
      reloadFromSync();
    });
    window.addEventListener("pagehide", () => {
      stopCliListener();
      stopSyncListener();
    }, { once: true });
  }
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
