export type Language = "zh-CN" | "en";
export type Settings = { language: Language };

const zh = {
  unnamedGroup: "未命名组", newList: "新列表", myTodos: "我的待办",
  resetTasks: "已撤销 {count} 项后续待办的完成状态", saveFailed: "保存失败，请重试。",
  reorder: "拖动调整顺序", undoComplete: "撤销完成", complete: "完成", prerequisitesFirst: "请先完成所有上一步",
  editTodo: "编辑待办：{title}", taskLabel: "{action}：{title}", deleteTodo: "删除待办", deleteNamedTodo: "删除 {title}",
  addTodo: "添加待办", addPrevious: "添加上一步", addNext: "添加下一步", cancel: "取消", todoName: "待办名称",
  todoPlaceholder: "要做什么？", add: "添加", newGroup: "新建分组",
  previousHint: "新组全部完成后，才能做本组。", nextHint: "本组全部完成后，才能做新组。",
  linkExisting: "或关联已有组", linkedPrevious: "已关联的上一步", unlinkHint: "只解除关联，不删除任务",
  locatePrevious: "定位共享的上一步", sharedPrevious: "共享上一步",
  expandGroup: "展开分组", collapseGroup: "折叠分组", expandNamedGroup: "展开{title}", collapseNamedGroup: "折叠{title}",
  optionalGroupName: "组名（可选）", groupDone: "本组已完成", groupProgress: "本组完成进度", groupActions: "分组操作",
  deleteGroup: "删除本组", firstTodo: "添加第一条待办", dragWindow: "拖动窗口", listName: "列表名称，点击编辑",
  renameList: "点击修改列表名称", readyCount: "{count} 项可做", waitingCount: "{count} 项等待", allDone: "全部完成",
  takeYourTime: "一步一步，慢慢来", organize: "一键整理", unpin: "取消置顶", pin: "置顶窗口", hide: "隐藏到托盘",
  emptyTitle: "从一组待办开始", emptyDescription: "同组一起做，前后分步骤。", holdDeleteList: "长按删除列表",
  holdDeleteListHint: "长按 1.5 秒删除当前列表", todoLists: "待办列表", oneGroup: "1 组", manyGroups: "{count} 组",
  footer: "{groups} · {count} 项待完成", clearCompleted: "清除已完成 · {count}", stayFocused: "保持专注",
  pinFailed: "无法更改置顶状态", hideFailed: "无法隐藏窗口", dragFailed: "无法拖动窗口",
  loadFailed: "无法读取待办", loadFailedHint: "请检查数据文件后重启应用。",
  settings: "设置", closeSettings: "关闭设置", general: "通用", language: "语言", languageHint: "切换后立即生效，并自动保存。",
  settingsFailed: "无法保存语言设置，请重试。",
};

const en: Record<keyof typeof zh, string> = {
  unnamedGroup: "Untitled group", newList: "New list", myTodos: "My todos",
  resetTasks: "Downstream tasks marked incomplete: {count}", saveFailed: "Couldn't save. Please try again.",
  reorder: "Drag to reorder", undoComplete: "Mark incomplete", complete: "Complete", prerequisitesFirst: "Complete all previous steps first",
  editTodo: "Edit task: {title}", taskLabel: "{action}: {title}", deleteTodo: "Delete task", deleteNamedTodo: "Delete {title}",
  addTodo: "Add task", addPrevious: "Add previous step", addNext: "Add next step", cancel: "Cancel", todoName: "Task name",
  todoPlaceholder: "What needs doing?", add: "Add", newGroup: "New group",
  previousHint: "Finish the new group before starting this one.", nextHint: "Finish this group before starting the new one.",
  linkExisting: "Or link an existing group", linkedPrevious: "Linked previous steps", unlinkHint: "Unlink only; keep the tasks",
  locatePrevious: "Go to shared previous step", sharedPrevious: "Shared step",
  expandGroup: "Expand group", collapseGroup: "Collapse group", expandNamedGroup: "Expand {title}", collapseNamedGroup: "Collapse {title}",
  optionalGroupName: "Group name (optional)", groupDone: "Group complete", groupProgress: "Group progress", groupActions: "Group actions",
  deleteGroup: "Delete group", firstTodo: "Add the first task", dragWindow: "Drag window", listName: "List name, click to edit",
  renameList: "Click to rename this list", readyCount: "{count} ready", waitingCount: "{count} waiting", allDone: "All done",
  takeYourTime: "One step at a time", organize: "Tidy up", unpin: "Unpin window", pin: "Keep on top", hide: "Hide to tray",
  emptyTitle: "Start with a group", emptyDescription: "Tasks together. Steps in order.", holdDeleteList: "Hold to delete list",
  holdDeleteListHint: "Hold for 1.5 seconds to delete this list", todoLists: "Todo lists", oneGroup: "1 group", manyGroups: "{count} groups",
  footer: "{groups} · {count} remaining", clearCompleted: "Clear completed · {count}", stayFocused: "Stay focused",
  pinFailed: "Couldn't change the pin setting", hideFailed: "Couldn't hide the window", dragFailed: "Couldn't drag the window",
  loadFailed: "Couldn't load your tasks", loadFailedHint: "Check the data file, then restart the app.",
  settings: "Settings", closeSettings: "Close settings", general: "General", language: "Language", languageHint: "Applies immediately and saves automatically.",
  settingsFailed: "Couldn't save the language setting. Please try again.",
};

const settingsKey = "zen-todo-settings";
let settings: Settings = { language: "zh-CN" };
try {
  const stored = JSON.parse(localStorage.getItem(settingsKey) ?? "null");
  if (stored && (stored.language === "en" || stored.language === "zh-CN")) settings = stored;
} catch { /* A missing or invalid preference uses the default language. */ }

export function getLanguage(): Language { return settings.language; }

export function setLanguage(language: Language) {
  const next = { ...settings, language };
  localStorage.setItem(settingsKey, JSON.stringify(next));
  settings = next;
}

export function t(key: keyof typeof zh, params: Record<string, string | number> = {}): string {
  const text = (settings.language === "en" ? en : zh)[key];
  return text.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match));
}
