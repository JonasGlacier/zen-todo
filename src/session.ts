export type EditorState = {
  selector: string;
  value: string;
  focused: boolean;
  start: number | null;
  end: number | null;
};
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
