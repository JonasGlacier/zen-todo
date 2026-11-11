// Every task has any number of previous steps but at most one next step
// (`nextId`), so the dependencies form a forest converging on its roots.
export type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  nextId: string | null;
};

export type Board = { todos: Todo[] };

export type TodoList = { id: string; title: string; board: Board; archived?: boolean };
export type Workspace = { lists: TodoList[]; activeListId: string };
export type DropPlace = "before" | "after" | "into";

const find = (board: Board, id: string | null | undefined) => board.todos.find((todo) => todo.id === id);

export function createList(title = "新列表"): TodoList {
  return { id: crypto.randomUUID(), title, board: { todos: [] }, archived: false };
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
  if (!workspace.lists.some((list) => !list.archived)) workspace.lists.push(createList(fallbackTitle));
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
  if (!workspace.lists.some((list) => !list.archived)) workspace.lists.push(createList(fallbackTitle));
  if (workspace.activeListId === id) {
    workspace.activeListId = (workspace.lists.slice(index).find((list) => !list.archived)
      ?? workspace.lists.slice(0, index).reverse().find((list) => !list.archived)!).id;
  }
}

export function prerequisites(board: Board, id: string): Todo[] {
  return board.todos.filter((todo) => todo.nextId === id);
}

export function countPrerequisites(board: Board, id: string): number {
  return prerequisites(board, id).reduce((sum, todo) => sum + 1 + countPrerequisites(board, todo.id), 0);
}

export function isBlocked(board: Board, todo: Todo): boolean {
  return board.todos.some((item) => item.nextId === todo.id && !item.completed);
}

// True when `id` is `ancestorId` or lies somewhere before it in the chain.
function leadsTo(board: Board, id: string | null, goal: string): boolean {
  const seen = new Set<string>();
  let current = find(board, id);
  while (current && !seen.has(current.id)) {
    if (current.id === goal) return true;
    seen.add(current.id);
    current = find(board, current.nextId);
  }
  return false;
}

export function canLink(board: Board, previousId: string, nextId: string): boolean {
  const previous = find(board, previousId);
  if (!previous || !find(board, nextId) || previousId === nextId || previous.nextId === nextId) return false;
  return !leadsTo(board, nextId, previousId);
}

export function reconcile(board: Board): number {
  let reset = 0;
  let changed: boolean;
  do {
    changed = false;
    for (const todo of board.todos) {
      if (todo.completed && isBlocked(board, todo)) {
        todo.completed = false;
        changed = true;
        reset++;
      }
    }
  } while (changed);
  return reset;
}

export function normalize(board: Board): void {
  const ids = new Set(board.todos.map((todo) => todo.id));
  for (const todo of board.todos) {
    todo.nextId = todo.nextId && todo.nextId !== todo.id && ids.has(todo.nextId) ? todo.nextId : null;
  }
  for (const todo of board.todos) {
    const seen = new Set([todo.id]);
    let current = todo;
    while (current.nextId) {
      if (seen.has(current.nextId)) { current.nextId = null; break; }
      seen.add(current.nextId);
      current = find(board, current.nextId)!;
    }
  }
  reconcile(board);
}

export function toggleTodo(board: Board, id: string): number {
  const todo = find(board, id);
  if (!todo || (!todo.completed && isBlocked(board, todo))) return 0;
  todo.completed = !todo.completed;
  return reconcile(board);
}

export function addTodo(board: Board, title = "", nextId: string | null = null, id: string = crypto.randomUUID()): Todo {
  const next = find(board, nextId);
  const todo: Todo = { id, title, completed: false, createdAt: Date.now(), nextId: next ? next.id : null };
  board.todos.push(todo);
  reconcile(board);
  return todo;
}

// Same next step as `afterId`, placed right after it among its siblings.
export function addSibling(board: Board, afterId: string, id: string = crypto.randomUUID()): Todo | undefined {
  const after = find(board, afterId);
  if (!after) return undefined;
  const todo: Todo = { id, title: "", completed: false, createdAt: Date.now(), nextId: after.nextId };
  board.todos.splice(board.todos.indexOf(after) + 1, 0, todo);
  reconcile(board);
  return todo;
}

export function linkTodos(board: Board, previousId: string, nextId: string): boolean {
  if (!canLink(board, previousId, nextId)) return false;
  find(board, previousId)!.nextId = nextId;
  reconcile(board);
  return true;
}

// Previous steps of a removed task move on to its next step.
export function removeTodo(board: Board, id: string): void {
  const todo = find(board, id);
  if (!todo) return;
  for (const previous of prerequisites(board, id)) previous.nextId = todo.nextId;
  board.todos.splice(board.todos.indexOf(todo), 1);
  reconcile(board);
}

export function indentTodo(board: Board, id: string): boolean {
  const todo = find(board, id);
  if (!todo) return false;
  const siblings = board.todos.filter((item) => item.nextId === todo.nextId);
  const target = siblings[siblings.indexOf(todo) + 1];
  return target ? linkTodos(board, id, target.id) : false;
}

export function outdentTodo(board: Board, id: string): boolean {
  const todo = find(board, id);
  const parent = find(board, todo?.nextId);
  if (!todo || !parent) return false;
  todo.nextId = parent.nextId;
  board.todos.splice(board.todos.indexOf(todo), 1);
  board.todos.splice(board.todos.indexOf(parent), 0, todo);
  reconcile(board);
  return true;
}

export function canMove(board: Board, id: string, targetId: string, place: DropPlace): boolean {
  if (id === targetId || !find(board, id) || !find(board, targetId)) return false;
  return place === "into" ? canLink(board, id, targetId) : !leadsTo(board, targetId, id);
}

export function moveTodo(board: Board, id: string, targetId: string, place: DropPlace): boolean {
  if (!canMove(board, id, targetId, place)) return false;
  if (place === "into") return linkTodos(board, id, targetId);
  const todo = find(board, id)!;
  const target = find(board, targetId)!;
  todo.nextId = target.nextId;
  board.todos.splice(board.todos.indexOf(todo), 1);
  board.todos.splice(board.todos.indexOf(target) + (place === "after" ? 1 : 0), 0, todo);
  reconcile(board);
  return true;
}
