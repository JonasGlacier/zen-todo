import type { Workspace } from "./board";

export type EditorState = {
  selector: string;
  value: string;
  focused: boolean;
  start: number | null;
  end: number | null;
};

// A sync refresh must not mistake an old rendered value for an unsaved edit.
// Compare against the pre-sync model, then restore clean editors from the new
// model. Keep actual drafts, focus and selection without masking remote edits.
export function editorsAfterSync(editors: EditorState[], before: Workspace, after: Workspace): EditorState[] {
  if (before.activeListId !== after.activeListId) return [];
  const oldList = before.lists.find((list) => list.id === before.activeListId);
  const newList = after.lists.find((list) => list.id === after.activeListId);
  if (!oldList || !newList) return [];
  const oldValues = new Map(oldList.board.todos.map((todo) => [`#todo-${todo.id}`, todo.title]));
  const newValues = new Map(newList.board.todos.map((todo) => [`#todo-${todo.id}`, todo.title]));
  oldValues.set("#list-name", oldList.title);
  newValues.set("#list-name", newList.title);
  return editors.flatMap((editor) => {
    const previous = oldValues.get(editor.selector);
    const current = newValues.get(editor.selector);
    if (previous === undefined || current === undefined) return [];
    const edited = editor.selector === "#list-name"
      ? editor.value.trim() : editor.value.replace(/[\r\n]+/g, " ").trim();
    return [{ ...editor, value: edited === previous ? current : editor.value }];
  });
}
export type UiSession = {
  version: 1;
  listId: string;
  pinned: boolean;
  scrollTop: number;
  editors: EditorState[];
};

export function captureEditors(): EditorState[] {
  return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("#list-name, [data-edit-todo]")).map((input) => ({
    selector: input.id ? `#${input.id}` : `[data-edit-todo="${input.dataset.editTodo}"]`,
    value: input.value, focused: document.activeElement === input,
    start: input.selectionStart, end: input.selectionEnd,
  }));
}

export function restoreEditors(editors: EditorState[], resize: (input: HTMLTextAreaElement) => void) {
  for (const editor of editors) {
    const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(editor.selector);
    if (!input) continue;
    input.value = editor.value;
    if (input instanceof HTMLTextAreaElement) resize(input);
    if (editor.focused) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(editor.start, editor.end);
    }
  }
}
