export type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  groupId: string;
};

export type Group = {
  id: string;
  title: string;
  prerequisiteIds: string[];
  collapsed?: boolean;
};

export type Board = { groups: Group[]; todos: Todo[] };

export type TodoList = { id: string; title: string; board: Board };
export type Workspace = { lists: TodoList[]; activeListId: string };

export function createList(title = "新列表"): TodoList {
  return { id: crypto.randomUUID(), title, board: { groups: [], todos: [] } };
}

export function createWorkspace(): Workspace {
  const list = createList("我的待办");
  return { lists: [list], activeListId: list.id };
}

export function deleteList(workspace: Workspace, id: string): void {
  const index = workspace.lists.findIndex((list) => list.id === id);
  if (index < 0) return;
  workspace.lists.splice(index, 1);
  if (!workspace.lists.length) workspace.lists.push(createList("我的待办"));
  if (workspace.activeListId === id) {
    workspace.activeListId = workspace.lists[Math.min(index, workspace.lists.length - 1)].id;
  }
}

export function groupComplete(board: Board, id: string): boolean {
  const tasks = board.todos.filter((todo) => todo.groupId === id);
  // An empty step must not silently unlock its successors.
  return tasks.length > 0 && tasks.every((todo) => todo.completed);
}

export function groupReady(board: Board, id: string, visiting = new Set<string>()): boolean {
  const group = board.groups.find((item) => item.id === id);
  if (!group || visiting.has(id)) return false;
  const path = new Set(visiting).add(id);
  return group.prerequisiteIds.every((previous) =>
    groupComplete(board, previous) && groupReady(board, previous, path));
}

export function canLink(board: Board, previous: string, next: string): boolean {
  if (previous === next || !board.groups.some((g) => g.id === previous)) return false;
  const target = board.groups.find((group) => group.id === next);
  if (!target || target.prerequisiteIds.includes(previous)) return false;
  const visited = new Set<string>();
  const reachesNext = (id: string): boolean => {
    if (id === next) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return board.groups.find((group) => group.id === id)?.prerequisiteIds.some(reachesNext) ?? false;
  };
  return !reachesNext(previous);
}

export function linkGroups(board: Board, previous: string, next: string): boolean {
  if (!canLink(board, previous, next)) return false;
  board.groups.find((group) => group.id === next)!.prerequisiteIds.push(previous);
  reconcile(board);
  return true;
}

export function reconcile(board: Board): number {
  let reset = 0;
  // Repeat because invalid completed steps can occur in any storage order.
  let changed: boolean;
  do {
    changed = false;
    for (const todo of board.todos) {
      if (todo.completed && !groupReady(board, todo.groupId)) {
        todo.completed = false;
        changed = true;
        reset++;
      }
    }
  } while (changed);
  return reset;
}

export function toggleTodo(board: Board, id: string): number {
  const todo = board.todos.find((item) => item.id === id);
  if (!todo || (!todo.completed && !groupReady(board, todo.groupId))) return 0;
  todo.completed = !todo.completed;
  return reconcile(board);
}

export function removeGroups(board: Board, ids: Set<string>) {
  board.groups = board.groups.filter((group) => !ids.has(group.id));
  board.todos = board.todos.filter((todo) => !ids.has(todo.groupId));
  for (const group of board.groups) {
    group.prerequisiteIds = group.prerequisiteIds.filter((id) => !ids.has(id));
  }
  reconcile(board);
}

export function clearCompleted(board: Board) {
  // Remove fully completed steps and their links before removing their tasks.
  const complete = new Set(board.groups.filter((group) => groupComplete(board, group.id)).map((group) => group.id));
  removeGroups(board, complete);
  board.todos = board.todos.filter((todo) => !todo.completed);
  reconcile(board);
}
