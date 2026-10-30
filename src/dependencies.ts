export type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
  prerequisiteIds: string[];
};

export function isBlocked(todo: Todo, todos: Todo[]): boolean {
  return todo.prerequisiteIds.some((id) => !todos.find((item) => item.id === id)?.completed);
}

// Adding prerequisite -> dependent is invalid if dependent already leads to prerequisite.
export function canLink(prerequisiteId: string, dependentId: string, todos: Todo[]): boolean {
  if (prerequisiteId === dependentId) return false;
  const dependent = todos.find((todo) => todo.id === dependentId);
  if (!dependent || !todos.some((todo) => todo.id === prerequisiteId) || dependent.prerequisiteIds.includes(prerequisiteId)) return false;
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === dependentId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return todos.find((todo) => todo.id === id)?.prerequisiteIds.some(visit) ?? false;
  };
  return !visit(prerequisiteId);
}

export function reconcile(todos: Todo[]): void {
  // Iterate to propagate an invalidated completion through the entire graph.
  let changed: boolean;
  do {
    changed = false;
    for (const todo of todos) {
      if (todo.completed && isBlocked(todo, todos)) {
        todo.completed = false;
        changed = true;
      }
    }
  } while (changed);
}

export function removeTodos(todos: Todo[], ids: Set<string>): Todo[] {
  return todos.filter((todo) => !ids.has(todo.id)).map((todo) => ({
    ...todo,
    prerequisiteIds: todo.prerequisiteIds.filter((id) => !ids.has(id)),
  }));
}
