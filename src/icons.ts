import {
  Archive, ArchiveRestore, ArrowLeft, ArrowUpToLine, Check, ChevronRight, GripVertical, Languages,
  ListFilter, ListTodo, Minus, Pin, PinOff, Plus, Settings, ShieldCheck, SlidersHorizontal, Trash2, X, createElement,
} from "lucide";

const icons = {
  previous: ArrowUpToLine, chevron: ChevronRight, organize: ListFilter, settings: Settings,
  pin: Pin, pinOff: PinOff, hide: Minus, plus: Plus, close: X, check: Check,
  grip: GripVertical, empty: ListTodo, back: ArrowLeft, trash: Trash2, archive: Archive, restore: ArchiveRestore,
  general: SlidersHorizontal, language: Languages, privacy: ShieldCheck,
};
const cache = new Map<keyof typeof icons, string>();

export function icon(name: keyof typeof icons): string {
  if (!cache.has(name)) {
    cache.set(name, createElement(icons[name], {
      class: "lucide", "data-icon": name, "stroke-width": 1.75,
      "aria-hidden": "true", focusable: "false",
    }).outerHTML);
  }
  return cache.get(name)!;
}
