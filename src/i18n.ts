import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Language = "zh-CN" | "en";
export type Settings = { language: Language };

const zh = {
  newList: "新列表", myTodos: "我的待办",
  resetTasks: "已撤销 {count} 项后续待办的完成状态", saveFailed: "保存失败，请重试。",
  reorder: "拖动调整顺序", undoComplete: "撤销完成", complete: "完成", prerequisitesFirst: "请先完成所有上一步",
  editTodo: "编辑待办：{title}", taskLabel: "{action}：{title}", deleteTodo: "删除待办", deleteNamedTodo: "删除 {title}",
  addPrevious: "添加上一步", addPreviousNamed: "为 {title} 添加上一步", cancel: "取消", newTodo: "新待办", todoPlaceholder: "待办名称",
  expandSteps: "展开上一步", collapseSteps: "收起上一步", hiddenSteps: "{count} 项上一步",
  dragWindow: "拖动窗口", listName: "列表名称，点击编辑", renameList: "点击修改列表名称", readyCount: "{count} 项可做", waitingCount: "{count} 项等待", allDone: "全部完成",
  takeYourTime: "一步一步，慢慢来", organize: "收起已完成", unpin: "取消置顶", pin: "置顶窗口", hide: "隐藏到托盘",
  emptyTitle: "写下第一件事", emptyDescription: "回车继续添加；Tab 设为下一项的上一步；拖到另一项上也可建立关系。",
  todoLists: "待办列表", footer: "{count} 项待完成", stayFocused: "保持专注",
  archiveList: "归档清单", archiveListHint: "归档后可在“已归档”中查看和恢复", archived: "已归档", archivedLists: "已归档清单", archivedEmpty: "没有已归档的清单",
  restoreList: "恢复", restoreNamed: "恢复 {title}", archivedProgress: "{done}/{total} 项已完成", emptyArchivedList: "这个清单没有待办",
  pinFailed: "无法更改置顶状态", hideFailed: "无法隐藏窗口", dragFailed: "无法拖动窗口",
  loadFailed: "无法读取待办", loadFailedHint: "请检查数据文件后重启应用。",
  settings: "设置", closeSettings: "关闭设置", general: "通用", language: "语言", languageHint: "切换后立即生效，并自动保存。",
  settingsFailed: "无法保存语言设置，请重试。",
  openSettingsFailed: "无法打开设置窗口，请重试。", settingsDescription: "按你的习惯，调整 Zen Todo。",
  settingsNavigation: "设置分类", generalDescription: "管理应用的语言和通用偏好。", privacy: "隐私", privacyDescription: "管理本地数据的加密和锁定。", privacyDesktopOnly: "本地数据加密仅在桌面应用中可用。", privacyLoading: "正在读取加密状态…", privacyLoadFailed: "无法读取加密状态，请重新打开设置。",
  languageDescription: "选择界面使用的语言，不会修改你的待办内容。", savedAutomatically: "设置会自动保存",
  encryption: "本地数据加密", encryptionDescription: "使用独立密码加密待办。忘记密码后无法恢复数据，请妥善保管。", encryptionEnabled: "加密已开启", password: "加密密码", confirmPassword: "再次输入密码", enableEncryption: "开启加密", passwordMismatch: "请输入相同的非空密码。", encryptionFailed: "操作失败，请重试并检查数据文件。", lockOnHide: "隐藏到托盘时锁定", lockOnHideHint: "关闭时仅在退出应用后锁定；开启后每次隐藏都需要重新输入密码。", unlock: "解锁", unlockTitle: "解锁待办", unlockHint: "请输入你的加密密码。", unlockFailed: "密码错误或数据已损坏。", legacyTempWarning: "发现旧版临时文件 todos.json.tmp，可能包含明文；请检查数据目录并自行处理。",
  changePassword: "修改密码", currentPassword: "当前密码", newPassword: "新密码", confirmNewPassword: "再次输入新密码", passwordChanged: "密码已修改。", currentPasswordFailed: "当前密码错误或数据已损坏。",
};

const en: Record<keyof typeof zh, string> = {
  newList: "New list", myTodos: "My todos",
  resetTasks: "Downstream tasks marked incomplete: {count}", saveFailed: "Couldn't save. Please try again.",
  reorder: "Drag to reorder", undoComplete: "Mark incomplete", complete: "Complete", prerequisitesFirst: "Complete all previous steps first",
  editTodo: "Edit task: {title}", taskLabel: "{action}: {title}", deleteTodo: "Delete task", deleteNamedTodo: "Delete {title}",
  addPrevious: "Add previous step", addPreviousNamed: "Add a previous step to {title}", cancel: "Cancel", newTodo: "New task", todoPlaceholder: "Task name",
  expandSteps: "Show previous steps", collapseSteps: "Hide previous steps", hiddenSteps: "{count} previous",
  dragWindow: "Drag window", listName: "List name, click to edit", renameList: "Click to rename this list", readyCount: "{count} ready", waitingCount: "{count} waiting", allDone: "All done",
  takeYourTime: "One step at a time", organize: "Fold completed", unpin: "Unpin window", pin: "Keep on top", hide: "Hide to tray",
  emptyTitle: "Write the first thing", emptyDescription: "Enter adds more; Tab makes a task the previous step of the next one; or drop one onto another.",
  todoLists: "Todo lists", footer: "{count} remaining", stayFocused: "Stay focused",
  archiveList: "Archive list", archiveListHint: "Archived lists can be viewed and restored from Archived", archived: "Archived", archivedLists: "Archived lists", archivedEmpty: "No archived lists",
  restoreList: "Restore", restoreNamed: "Restore {title}", archivedProgress: "{done}/{total} done", emptyArchivedList: "This list has no tasks",
  pinFailed: "Couldn't change the pin setting", hideFailed: "Couldn't hide the window", dragFailed: "Couldn't drag the window",
  loadFailed: "Couldn't load your tasks", loadFailedHint: "Check the data file, then restart the app.",
  settings: "Settings", closeSettings: "Close settings", general: "General", language: "Language", languageHint: "Applies immediately and saves automatically.",
  settingsFailed: "Couldn't save the language setting. Please try again.",
  openSettingsFailed: "Couldn't open settings. Please try again.", settingsDescription: "Make Zen Todo feel like home.",
  settingsNavigation: "Settings categories", generalDescription: "Manage your language and general preferences.", privacy: "Privacy", privacyDescription: "Manage local data encryption and locking.", privacyDesktopOnly: "Local data encryption is available in the desktop app.", privacyLoading: "Loading encryption status…", privacyLoadFailed: "Couldn't load encryption status. Please reopen settings.",
  languageDescription: "Choose the interface language. Your tasks stay as they are.", savedAutomatically: "Settings save automatically",
  encryption: "Local data encryption", encryptionDescription: "Protect tasks with a separate password. Lost passwords cannot be recovered.", encryptionEnabled: "Encryption enabled", password: "Encryption password", confirmPassword: "Confirm password", enableEncryption: "Enable encryption", passwordMismatch: "Enter matching, non-empty passwords.", encryptionFailed: "Operation failed. Check the data file and try again.", lockOnHide: "Lock when hidden to tray", lockOnHideHint: "When off, lock only on exit; when on, hiding requires a password to reopen.", unlock: "Unlock", unlockTitle: "Unlock tasks", unlockHint: "Enter your encryption password.", unlockFailed: "Incorrect password or damaged data.", legacyTempWarning: "A legacy todos.json.tmp file exists and may contain plaintext; inspect it in the data directory.",
  changePassword: "Change password", currentPassword: "Current password", newPassword: "New password", confirmNewPassword: "Confirm new password", passwordChanged: "Password changed.", currentPasswordFailed: "The current password is incorrect or the data is damaged.",
};

const settingsKey = "zen-todo-settings";
let settings: Settings = { language: "zh-CN" };
try {
  const stored = JSON.parse(localStorage.getItem(settingsKey) ?? "null");
  if (stored && (stored.language === "en" || stored.language === "zh-CN")) settings = stored;
} catch { /* A missing or invalid preference uses the default language. */ }

export function getLanguage(): Language { return settings.language; }

export function setLanguage(language: Language) {
  if (language === settings.language) return;
  const next = { ...settings, language };
  localStorage.setItem(settingsKey, JSON.stringify(next));
  settings = next;
  window.dispatchEvent(new Event("zen-settings-changed"));
}

// storage covers browser windows; the native event also covers WebViews where
// storage notifications can be delayed. Both paths deduplicate by language.
export async function watchSettings(onChange: () => void): Promise<() => void> {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== settingsKey) return;
    try {
      const next = JSON.parse(event.newValue ?? "null");
      if (next && (next.language === "en" || next.language === "zh-CN") && next.language !== settings.language) {
        settings = next;
        onChange();
      }
    } catch { /* Ignore incomplete or invalid settings from another window. */ }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("zen-settings-changed", onChange);
  const unlisten = isTauri() ? await listen<Language>("settings-changed", ({ payload }) => {
    if (payload === "en" || payload === "zh-CN") {
      try { setLanguage(payload); } catch (error) { console.error(error); }
    }
  }).catch(() => undefined) : undefined;
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("zen-settings-changed", onChange);
    unlisten?.();
  };
}

export function t(key: keyof typeof zh, params: Record<string, string | number> = {}): string {
  const text = (settings.language === "en" ? en : zh)[key];
  return text.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match));
}
