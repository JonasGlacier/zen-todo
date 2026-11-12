import type { Workspace } from "./board";

export type HistoryStatus = { canUndo: boolean; undoCount: number };
const sameContent = (a: Workspace, b: Workspace) => JSON.stringify(a.lists) === JSON.stringify(b.lists);

// Browser preview mirrors the desktop's in-memory, transactional history.
export class WorkspaceHistory {
  private past: Workspace[] = [];
  private latest: Workspace | null = null;

  status(current: Workspace): HistoryStatus {
    const undoCount = this.latest && sameContent(this.latest, current) ? this.past.length : 0;
    return { canUndo: undoCount > 0, undoCount };
  }

  record(before: Workspace, after: Workspace) {
    if (sameContent(before, after)) return;
    if (this.latest && !sameContent(this.latest, before)) this.clear();
    this.past.push(structuredClone(before));
    if (this.past.length > 20) this.past.shift();
    this.latest = structuredClone(after);
  }

  target(current: Workspace): Workspace | null {
    return this.status(current).canUndo ? structuredClone(this.past[this.past.length - 1]) : null;
  }

  didUndo(target: Workspace) {
    this.past.pop();
    this.latest = this.past.length ? structuredClone(target) : null;
  }

  clear() { this.past = []; this.latest = null; }
}

export type TextState = { value: string; start: number | null; end: number | null };

// Text edits stay local until committed. Unlike a browser-wide native undo
// stack, this never changes a stale input removed by a workspace re-render.
export class TextHistory {
  private past: TextState[] = [];
  private current: TextState;
  private before: TextState | null = null;
  private group: { type: string; time: number } | null = null;

  constructor(initial: TextState) { this.current = { ...initial }; }

  beforeInput(state: TextState) { this.before = { ...state }; }

  input(state: TextState, type: string, now = Date.now()) {
    if (type === "historyUndo") return;
    const before = this.before ?? this.current;
    this.before = null;
    if (before.value === state.value) { this.current = { ...state }; return; }
    const coalesce = this.group?.type === type && now - this.group.time < 750
      && ["insertText", "insertCompositionText", "deleteContentBackward", "deleteContentForward"].includes(type)
      && before.value === this.current.value && before.start === this.current.start && before.end === this.current.end;
    if (!coalesce) {
      this.past.push({ ...before });
      if (this.past.length > 20) this.past.shift();
    }
    this.current = { ...state };
    this.group = { type, time: now };
  }

  undo(value: string): TextState | null {
    if (value !== this.current.value) { this.past = []; this.group = null; return null; }
    const previous = this.past.pop();
    if (!previous) return null;
    this.current = { ...previous };
    this.before = null;
    this.group = null;
    return { ...previous };
  }
}
