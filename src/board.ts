// A task belongs to at most one parent and can contain any number of subtasks.
export type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  parentId: string | null;
};

export type Board = { todos: Todo[] };

// Each list is a sticky note in one of a small, fixed set of paper colours.
// Only the key is stored; the actual shades live in styles.css.
export const NOTE_COLORS = ["yellow", "orange", "pink", "purple", "blue", "green"] as const;
export type NoteColor = typeof NOTE_COLORS[number];

export type TodoList = { id: string; title: string; board: Board; archived?: boolean; color?: NoteColor };
export type Workspace = { lists: TodoList[]; activeListId: string };
export type DropPlace = "before" | "after" | "into";

const find = (board: Board, id: string | null | undefined) => board.todos.find((todo) => todo.id === id);

export const isNoteColor = (value: unknown): value is NoteColor => NOTE_COLORS.includes(value as NoteColor);

// The least-used colour among open lists; ties continue the palette after the
// most recent list so neighbouring notes differ.
export function nextColor(workspace: Workspace): NoteColor {
  const open = workspace.lists.filter((list) => !list.archived);
  const counts = NOTE_COLORS.map((color) => open.filter((list) => list.color === color).length);
  const last = NOTE_COLORS.indexOf(open[open.length - 1]?.color as NoteColor);
  const order = NOTE_COLORS.map((_, index) => (last + 1 + index) % NOTE_COLORS.length);
  return NOTE_COLORS[order.reduce((best, index) => counts[index] < counts[best] ? index : best, order[0])];
}

export function createList(title = "新列表", color: NoteColor = NOTE_COLORS[0]): TodoList {
  return { id: crypto.randomUUID(), title, board: { todos: [] }, archived: false, color };
}

export function addList(workspace: Workspace, title = "新列表"): TodoList {
  const list = createList(title, nextColor(workspace));
  workspace.lists.push(list);
  return list;
}

// Lists saved before colours existed (or with an unknown colour) get one.
export function ensureColors(workspace: Workspace): boolean {
  let changed = false;
  const valid = workspace.lists.filter((list) => isNoteColor(list.color));
  for (const list of workspace.lists) {
    if (isNoteColor(list.color)) continue;
    list.color = nextColor({ lists: valid, activeListId: "" });
    valid.push(list);
    changed = true;
  }
  return changed;
}

export function setListColor(workspace: Workspace, id: string, color: NoteColor): void {
  const list = workspace.lists.find((item) => item.id === id);
  if (list && isNoteColor(color)) list.color = color;
}

export function createWorkspace(title = "我的待办"): Workspace {
  const list = createList(title);
  return { lists: [list], activeListId: list.id };
}

// Archiving keeps the list; the active list always remains an unarchived one.
export function archiveList(workspace: Workspace, id: string, fallbackTitle = "我的待办"): void {
  const index = workspace.lists.findIndex((list) => list.id === id);
  if (index < 0) return;
  workspace.lists[index].archived = true;
  if (!workspace.lists.some((list) => !list.archived)) addList(workspace, fallbackTitle);
  if (workspace.activeListId === id) {
    const next = workspace.lists.slice(index + 1).find((list) => !list.archived)
      ?? workspace.lists.slice(0, index).reverse().find((list) => !list.archived)!;
    workspace.activeListId = next.id;
  }
}

export function restoreList(workspace: Workspace, id: string): void {
  const list = workspace.lists.find((item) => item.id === id);
  if (!list) return;
  list.archived = false;
  workspace.activeListId = id;
}

export function deleteList(workspace: Workspace, id: string, fallbackTitle = "我的待办"): void {
  const index = workspace.lists.findIndex((list) => list.id === id);
  if (index < 0) return;
  workspace.lists.splice(index, 1);
  if (!workspace.lists.some((list) => !list.archived)) addList(workspace, fallbackTitle);
  if (workspace.activeListId === id) {
    workspace.activeListId = (workspace.lists.slice(index).find((list) => !list.archived)
      ?? workspace.lists.slice(0, index).reverse().find((list) => !list.archived)!).id;
  }
}

export function subtasks(board: Board, id: string): Todo[] {
  return board.todos.filter((todo) => todo.parentId === id);
}

export function countSubtasks(board: Board, id: string): number {
  return subtasks(board, id).reduce((sum, todo) => sum + 1 + countSubtasks(board, todo.id), 0);
}

export function orderedTodos(board: Board, parentId: string | null = null): Todo[] {
  return board.todos.filter((todo) => todo.parentId === parentId).flatMap((todo) => [todo, ...orderedTodos(board, todo.id)]);
}

// True when `id` is `goal` or is a descendant of it.
function leadsTo(board: Board, id: string | null, goal: string): boolean {
  const seen = new Set<string>();
  let current = find(board, id);
  while (current && !seen.has(current.id)) {
    if (current.id === goal) return true;
    seen.add(current.id);
    current = find(board, current.parentId);
  }
  return false;
}

export function canNest(board: Board, id: string, parentId: string): boolean {
  const todo = find(board, id);
  if (!todo || !find(board, parentId) || id === parentId || todo.parentId === parentId) return false;
  return !leadsTo(board, parentId, id);
}

export function reconcile(board: Board): number {
  let reset = 0;
  let changed: boolean;
  do {
    changed = false;
    for (const todo of board.todos) {
      const children = subtasks(board, todo.id);
      if (!children.length) continue;
      const completed = children.every((child) => child.completed);
      if (todo.completed !== completed) {
        if (todo.completed) reset++;
        todo.completed = completed;
        changed = true;
      }
    }
  } while (changed);
  return reset;
}

export function normalize(board: Board): boolean {
  const previous = JSON.stringify(board);
  const ids = new Set(board.todos.map((todo) => todo.id));
  for (const todo of board.todos) {
    // Read old saved boards once, but only write the new parentId model.
    const legacy = todo as Todo & { nextId?: string | null };
    if (!Object.prototype.hasOwnProperty.call(todo, "parentId")) todo.parentId = legacy.nextId ?? null;
    delete legacy.nextId;
    todo.parentId = todo.parentId && todo.parentId !== todo.id && ids.has(todo.parentId) ? todo.parentId : null;
  }
  for (const todo of board.todos) {
    const seen = new Set([todo.id]);
    let current = todo;
    while (current.parentId) {
      if (seen.has(current.parentId)) { current.parentId = null; break; }
      seen.add(current.parentId);
      current = find(board, current.parentId)!;
    }
  }
  reconcile(board);
  return JSON.stringify(board) !== previous;
}

export function toggleTodo(board: Board, id: string): number {
  const todo = find(board, id);
  if (!todo) return 0;
  const completed = !todo.completed;
  for (const item of board.todos) {
    if (leadsTo(board, item.id, id)) item.completed = completed;
  }
  return reconcile(board);
}

export function addTodo(board: Board, title = "", parentId: string | null = null, id: string = crypto.randomUUID()): Todo {
  const parent = find(board, parentId);
  const todo: Todo = { id, title, completed: false, createdAt: Date.now(), parentId: parent ? parent.id : null };
  board.todos.push(todo);
  reconcile(board);
  return todo;
}

// Same parent as `afterId`, placed right after it among its siblings.
export function addSibling(board: Board, afterId: string, id: string = crypto.randomUUID()): Todo | undefined {
  const after = find(board, afterId);
  if (!after) return undefined;
  const todo: Todo = { id, title: "", completed: false, createdAt: Date.now(), parentId: after.parentId };
  board.todos.splice(board.todos.indexOf(after) + 1, 0, todo);
  reconcile(board);
  return todo;
}

export function nestTodo(board: Board, id: string, parentId: string): boolean {
  if (!canNest(board, id, parentId)) return false;
  find(board, id)!.parentId = parentId;
  reconcile(board);
  return true;
}

// Keep a deleted parent's subtasks by promoting them into its former position.
export function removeTodo(board: Board, id: string): void {
  const todo = find(board, id);
  if (!todo) return;
  const children = subtasks(board, id);
  for (const child of children) child.parentId = todo.parentId;
  for (const child of children) board.todos.splice(board.todos.indexOf(child), 1);
  board.todos.splice(board.todos.indexOf(todo), 0, ...children);
  board.todos.splice(board.todos.indexOf(todo), 1);
  reconcile(board);
}

export function indentTodo(board: Board, id: string): boolean {
  const todo = find(board, id);
  if (!todo) return false;
  const siblings = board.todos.filter((item) => item.parentId === todo.parentId);
  const target = siblings[siblings.indexOf(todo) - 1];
  return target ? nestTodo(board, id, target.id) : false;
}

export function outdentTodo(board: Board, id: string): boolean {
  const todo = find(board, id);
  const parent = find(board, todo?.parentId);
  if (!todo || !parent) return false;
  todo.parentId = parent.parentId;
  board.todos.splice(board.todos.indexOf(todo), 1);
  board.todos.splice(board.todos.indexOf(parent) + 1, 0, todo);
  reconcile(board);
  return true;
}

export function canMove(board: Board, id: string, targetId: string, place: DropPlace): boolean {
  if (id === targetId || !find(board, id) || !find(board, targetId)) return false;
  return place === "into" ? canNest(board, id, targetId) : !leadsTo(board, targetId, id);
}

export function moveTodo(board: Board, id: string, targetId: string, place: DropPlace): boolean {
  if (!canMove(board, id, targetId, place)) return false;
  if (place === "into") return nestTodo(board, id, targetId);
  const todo = find(board, id)!;
  const target = find(board, targetId)!;
  todo.parentId = target.parentId;
  board.todos.splice(board.todos.indexOf(todo), 1);
  board.todos.splice(board.todos.indexOf(target) + (place === "after" ? 1 : 0), 0, todo);
  reconcile(board);
  return true;
}
