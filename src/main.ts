import { invoke, isTauri } from "@tauri-apps/api/core";
import { canLink, clearCompleted, createList, createWorkspace, deleteList, groupComplete, groupReady, linkGroups, reconcile, removeGroups, toggleTodo } from "./board";
import type { Board, Group, Todo, Workspace } from "./board";
import { getLanguage, setLanguage, t } from "./i18n";
import type { Language } from "./i18n";
import "./styles.css";

const app = document.querySelector<HTMLElement>("#app")!;
const browserKey = "zen-todo-board";
let workspace: Workspace = createWorkspace(t("myTodos"));
let board: Board = workspace.lists[0].board;
let pinned = true;
let pendingChange = Promise.resolve();
let message = "";
let composer: { groupId: string; mode: "task" | "previous" | "next" } | null = null;
let draggedId: string | null = null;
let settingsOpen = false;

const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[character]!);
const name = (id: string) => board.groups.find((group) => group.id === id)?.title || t("unnamedGroup");

const icons = {
  task: '<path d="M8 5h11M8 12h11M8 19h6M3 5h.01M3 12h.01M3 19h.01M19 16v6M16 19h6"/>',
  previous: '<path d="m8 7 4-4 4 4M12 3v12M5 15v6h14v-6"/>',
  next: '<path d="m8 17 4 4 4-4M12 21V9M5 9V3h14v6"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  organize: '<path d="M4 5h9M4 12h13M4 19h9M18 2l1.2 3.8L23 7l-3.8 1.2L18 12l-1.2-3.8L13 7l3.8-1.2L18 2Z"/>',
  settings: '<path d="m9 3 .7-1h4.6l.7 1 .4 2 1.8 1 1.9-.7 1.2.2 2.3 4-.4 1.2-1.6 1.3v2l1.6 1.3.4 1.2-2.3 4-1.2.2-1.9-.7-1.8 1-.4 2-.7 1H9.7L9 21l-.4-2-1.8-1-1.9.7-1.2-.2-2.3-4 .4-1.2L3.4 12v-2L1.8 8.7l-.4-1.2 2.3-4 1.2-.2 1.9.7 1.8-1L9 3Z" transform="translate(1 1) scale(.9)"/><circle cx="12" cy="12" r="3"/>',
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
        current.id === todo.id && !current.completed && !groupReady(board, current.groupId))).length;
      if (reset) message = t("resetTasks", { count: reset });
      await persist();
    } catch (error) {
      workspace = previous;
      board = workspace.lists.find((list) => list.id === workspace.activeListId)!.board;
      message = t("saveFailed");
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
    <span class="drag-handle" draggable="true" data-drag="${todo.id}" title="${t("reorder")}" aria-hidden="true">⠿</span>
    <button class="check ${todo.completed ? "checked" : ""}" data-action="toggle" data-id="${todo.id}"
      ${!ready ? "disabled" : ""} aria-pressed="${todo.completed}" aria-label="${escapeHtml(t("taskLabel", { action: t(todo.completed ? "undoComplete" : "complete"), title: todo.title }))}"
      title="${ready ? "" : t("prerequisitesFirst")}">${todo.completed ? "✓" : ""}</button>
    <textarea class="todo-title" data-edit-todo="${todo.id}" aria-label="${escapeHtml(t("editTodo", { title: todo.title }))}" rows="1" maxlength="200" spellcheck="false">${escapeHtml(todo.title)}</textarea>
    <button class="delete" data-action="delete-task" data-id="${todo.id}" title="${t("deleteTodo")}" aria-label="${escapeHtml(t("deleteNamedTodo", { title: todo.title }))}">×</button>
  </div>`;
}

function composerTemplate(group: Group) {
  if (composer?.groupId !== group.id) return "";
  const mode = composer.mode;
  const candidates = mode === "task" ? [] : board.groups.filter((candidate) =>
    mode === "previous" ? canLink(board, candidate.id, group.id) : canLink(board, group.id, candidate.id));
  return `<${mode === "task" ? 'form id="step-form"' : "div"} class="inline-form" data-group="${group.id}" data-mode="${mode}">
    <div class="composer-heading">${t(mode === "task" ? "addTodo" : mode === "previous" ? "addPrevious" : "addNext")}<button type="button" data-action="close-composer" aria-label="${t("cancel")}">×</button></div>
    ${mode === "task" ? `<div class="input-line"><input id="step-input" aria-label="${t("todoName")}" placeholder="${t("todoPlaceholder")}" autocomplete="off" required maxlength="200"/><button type="submit">${t("add")}</button></div>` : `<button class="create-step" data-action="create-${mode}" data-id="${group.id}">＋ ${t("newGroup")}</button>`}
    ${mode === "task" ? "" : `<p class="hint">${t(mode === "previous" ? "previousHint" : "nextHint")}</p>
    ${candidates.length ? `<div class="existing"><span>${t("linkExisting")}</span>${candidates.map((candidate) => `<button type="button" data-action="link-${mode}" data-id="${candidate.id}" data-group="${group.id}"><span data-group-label="${candidate.id}">${escapeHtml(name(candidate.id))}</span><span>＋</span></button>`).join("")}</div>` : ""}
    ${group.prerequisiteIds.length ? `<div class="existing"><span>${t("linkedPrevious")}</span>${group.prerequisiteIds.map((id) => `<button type="button" data-action="unlink" data-id="${id}" data-group="${group.id}" title="${t("unlinkHint")}"><span data-group-label="${id}">${escapeHtml(name(id))}</span><span>×</span></button>`).join("")}</div>` : ""}`}
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
    return `<button class="shared-step ${groupComplete(board, id) ? "is-done" : ""}" data-action="jump" data-id="${id}" title="${t("locatePrevious")}">${groupComplete(board, id) ? "✓" : "↗"} <span data-group-label="${id}">${escapeHtml(name(id))}</span><span class="shared-caption">${t("sharedPrevious")}</span></button>`;
  }).join("");
  return `<section class="step ${complete ? "step-complete" : ""} ${depth > 5 ? "deep-step" : ""}" id="group-${group.id}" aria-label="${escapeHtml(name(group.id))}">
    ${predecessors ? `<div class="previous-steps">${predecessors}</div>` : ""}
    <div class="group-body ${!ready ? "is-blocked" : ""}">
      <header class="group-header">
        <button class="fold-button ${collapsed ? "" : "is-expanded"}" id="fold-${group.id}" data-action="fold" data-id="${group.id}" title="${t(collapsed ? "expandGroup" : "collapseGroup")}" aria-label="${escapeHtml(t(collapsed ? "expandNamedGroup" : "collapseNamedGroup", { title: name(group.id) }))}" aria-expanded="${!collapsed}" aria-controls="content-${group.id}">${icon("chevron")}</button>
        <input class="group-name" value="${escapeHtml(group.title)}" placeholder="${t("optionalGroupName")}" aria-label="${t("optionalGroupName")}" data-rename="${group.id}" maxlength="80" />
        <span class="group-count" title="${t(complete ? "groupDone" : "groupProgress")}">${done}/${tasks.length}</span>
        <div class="group-tools" role="group" aria-label="${t("groupActions")}">
          <button data-action="task" data-id="${group.id}" title="${t("addTodo")}" aria-label="${t("addTodo")}">${icon("task")}</button>
          <button data-action="previous" data-id="${group.id}" title="${t("addPrevious")}" aria-label="${t("addPrevious")}">${icon("previous")}</button>
          <button data-action="next" data-id="${group.id}" title="${t("addNext")}" aria-label="${t("addNext")}">${icon("next")}</button>
          <button class="danger" data-action="delete-group" data-id="${group.id}" title="${t("deleteGroup")}" aria-label="${t("deleteGroup")}">${icon("delete")}</button>
        </div>
      </header>
      <div class="group-content" id="content-${group.id}" ${collapsed ? "hidden" : ""}>
        <div class="tasks">${tasks.map((todo) => todoTemplate(todo, ready)).join("")}</div>
        ${composer?.groupId === group.id ? composerTemplate(group) : tasks.length ? "" : `<button class="add-task" data-action="task" data-id="${group.id}">＋ ${t("firstTodo")}</button>`}
      </div>
    </div>
  </section>`;
}

function render() {
  document.documentElement.lang = getLanguage();
  const listScroll = document.querySelector(".list")?.scrollTop ?? 0;
  const activeList = workspace.lists.find((list) => list.id === workspace.activeListId)!;
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
    <div class="window-drag-region" data-window-drag title="${t("dragWindow")}" aria-label="${t("dragWindow")}"><span></span></div>
    <header class="controls" data-window-drag><div class="heading"><input class="list-name" id="list-name" value="${escapeHtml(activeList.title)}" aria-label="${t("listName")}" title="${t("renameList")}" maxlength="80"/><span class="status">${pending.length ? `${t("readyCount", { count: available })}${pending.length > available ? ` · ${t("waitingCount", { count: pending.length - available })}` : ""}` : t(completed ? "allDone" : "takeYourTime")}</span></div>
      <div class="window-actions"><button class="icon-button" id="organize-button" title="${t("organize")}" aria-label="${t("organize")}">${icon("organize")}</button><button class="icon-button" id="settings-button" title="${t("settings")}" aria-label="${t("settings")}" aria-expanded="${settingsOpen}" aria-controls="settings-panel" aria-haspopup="dialog">${icon("settings")}</button><button class="icon-button ${pinned ? "is-active" : ""}" id="pin-button" title="${t(pinned ? "unpin" : "pin")}" aria-label="${t(pinned ? "unpin" : "pin")}">⌃</button><button class="icon-button" id="hide-button" title="${t("hide")}" aria-label="${t("hide")}">−</button></div>
    </header>
    <section class="settings-panel" id="settings-panel" role="dialog" aria-labelledby="settings-title" ${settingsOpen ? "" : "hidden"}>
      <header class="settings-header"><strong id="settings-title">${t("settings")}</strong><button id="close-settings" aria-label="${t("closeSettings")}" title="${t("closeSettings")}">×</button></header>
      <section class="settings-section" aria-labelledby="general-settings"><h2 id="general-settings">${t("general")}</h2>
        <div class="setting-row"><label for="language-select">${t("language")}</label><select id="language-select"><option value="zh-CN" lang="zh-CN" ${getLanguage() === "zh-CN" ? "selected" : ""}>简体中文</option><option value="en" lang="en" ${getLanguage() === "en" ? "selected" : ""}>English</option></select></div>
        <p class="setting-hint">${t("languageHint")}</p>
      </section>
    </section>
    <div class="workspace">
    <div class="list" id="todo-list" role="tabpanel">${roots.length ? roots.map((group) => groupTemplate(group, owner)).join("") : `<div class="empty"><span>☷</span><strong>${t("emptyTitle")}</strong><p>${t("emptyDescription")}</p></div>`}
      <button class="new-group-button" id="new-group-button"><span aria-hidden="true">＋</span> ${t("newGroup")}</button>
      <button class="delete-list-button" id="delete-list" title="${t("holdDeleteListHint")}">${t("holdDeleteList")}</button>
    </div>
    <div class="tabs-bar">
      <div class="tabs" role="tablist" aria-label="${t("todoLists")}">${workspace.lists.map((list) => `<button class="tab ${list.id === workspace.activeListId ? "is-selected" : ""}" role="tab" aria-selected="${list.id === workspace.activeListId}" aria-controls="todo-list" data-list="${list.id}" title="${escapeHtml(list.title)}">${escapeHtml(list.title)}</button>`).join("")}</div>
      <button class="tab-action" id="new-list" title="${t("newList")}" aria-label="${t("newList")}">＋</button>
    </div>
    </div>
    <footer class="footer"><span>${t("footer", { groups: t(board.groups.length === 1 ? "oneGroup" : "manyGroups", { count: board.groups.length }), count: pending.length })}</span>${completed ? `<button id="clear-completed">${t("clearCompleted", { count: completed })}</button>` : `<span>${t("stayFocused")}</span>`}</footer>
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

function showSettings(open: boolean, restoreFocus = false) {
  settingsOpen = open;
  document.getElementById("settings-panel")!.hidden = !open;
  document.getElementById("settings-button")!.setAttribute("aria-expanded", String(open));
  if (open) document.getElementById("language-select")?.focus();
  else if (restoreFocus) document.getElementById("settings-button")?.focus();
}

function changeLanguage(language: Language) {
  const operation = pendingChange.then(async () => {
    const previous = getLanguage();
    if (language === previous) return;
    const draft = document.querySelector<HTMLInputElement>("#step-input")?.value;
    const select = document.querySelector<HTMLSelectElement>("#language-select")!;
    select.disabled = true;
    try {
      if (isTauri()) await invoke("set_language", { language });
      setLanguage(language);
      message = "";
    } catch (error) {
      if (isTauri()) await invoke("set_language", { language: previous }).catch(console.error);
      message = t("settingsFailed");
      console.error(error);
    }
    render();
    const input = document.querySelector<HTMLInputElement>("#step-input");
    if (input && draft !== undefined) input.value = draft;
    if (settingsOpen) document.getElementById("language-select")?.focus();
  });
  pendingChange = operation.catch(console.error);
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
      if (reset) message = t("resetTasks", { count: reset });
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
  document.querySelector("#settings-button")!.addEventListener("click", () => showSettings(!settingsOpen));
  document.querySelector("#close-settings")!.addEventListener("click", () => showSettings(false, true));
  document.querySelector<HTMLSelectElement>("#language-select")!.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === "en" || value === "zh-CN") changeLanguage(value);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-list]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.list!;
      if (id === workspace.activeListId) return;
      void change(() => {
        const list = workspace.lists.find((item) => item.id === id);
        if (!list) return;
        workspace.activeListId = id;
        board = list.board;
        composer = null;
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
      composer = null;
      draggedId = null;
    });
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
  const deleteButton = document.querySelector<HTMLButtonElement>("#delete-list")!;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelHold = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
    deleteButton.classList.remove("is-holding");
  };
  const startHold = () => {
    if (holdTimer) return;
    deleteButton.classList.add("is-holding");
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      deleteButton.classList.remove("is-holding");
      if (!deleteButton.isConnected) return;
      void change(() => {
        if (workspace.activeListId !== listId) return;
        deleteList(workspace, listId, t("myTodos"));
        board = workspace.lists.find((item) => item.id === workspace.activeListId)!.board;
        composer = null;
        draggedId = null;
      });
    }, 1500);
  };
  deleteButton.addEventListener("pointerdown", (event) => { if (event.button === 0) startHold(); });
  for (const event of ["pointerup", "pointerleave", "pointercancel", "blur"] as const) deleteButton.addEventListener(event, cancelHold);
  deleteButton.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") { event.preventDefault(); startHold(); }
  });
  deleteButton.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") { event.preventDefault(); cancelHold(); }
  });
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
        input.setAttribute("aria-label", t("editTodo", { title: saved.title }));
        const row = input.closest(".todo")!;
        row.querySelector(".check")?.setAttribute("aria-label", t("taskLabel", { action: t(saved.completed ? "undoComplete" : "complete"), title: saved.title }));
        row.querySelector(".delete")?.setAttribute("aria-label", t("deleteNamedTodo", { title: saved.title }));
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
    } catch { message = t("pinFailed"); render(); }
  });
  document.querySelector("#hide-button")!.addEventListener("click", () => {
    if (isTauri()) void invoke("hide_window").catch(() => { message = t("hideFailed"); render(); });
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
  if (event.key === "Escape" && settingsOpen) { event.preventDefault(); showSettings(false, true); return; }
  if (event.key === "Escape") { composer = null; render(); }
});

document.addEventListener("pointerdown", (event) => {
  if (settingsOpen && !(event.target as Element).closest("#settings-panel, #settings-button")) showSettings(false);
});

window.addEventListener("resize", () => document.querySelectorAll<HTMLTextAreaElement>("[data-edit-todo]").forEach(resizeTodo));

async function start() {
  const stored = isTauri() ? await invoke<Workspace | null>("load_board") : JSON.parse(localStorage.getItem(browserKey) ?? "null") as Workspace | null;
  workspace = stored ?? createWorkspace(t("myTodos"));
  if (!workspace.lists.length || !workspace.lists.some((list) => list.id === workspace.activeListId)) throw new Error("Invalid workspace");
  for (const list of workspace.lists) reconcile(list.board);
  board = workspace.lists.find((list) => list.id === workspace.activeListId)!.board;
  if (isTauri()) await invoke("set_language", { language: getLanguage() }).catch(() => { message = t("settingsFailed"); });
  render();
}

start().catch((error) => {
  console.error(error);
  document.documentElement.lang = getLanguage();
  app.innerHTML = `<section class="shell error"><strong>${t("loadFailed")}</strong><p>${t("loadFailedHint")}</p></section>`;
});
