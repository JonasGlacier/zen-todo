import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

export type Language = "zh-CN" | "en";
export const UI_SCALES = [100, 110, 125, 150] as const;
export type UiScale = typeof UI_SCALES[number];
export type Settings = { language: Language; uiScale: UiScale };
export const isUiScale = (value: unknown): value is UiScale => UI_SCALES.includes(value as UiScale);

const zh = {
  aiKeySaved: "API Key 已保存。", aiKeyNotSaved: "尚未保存 API Key。", aiKeyUnknown: "无法确认 API Key 的保存状态。", aiKeyReplacePlaceholder: "输入新密钥以替换已保存的密钥",
  undoShortcut: "撤销（Ctrl+Z）", undoAvailable: "撤销最近一次操作，还可撤销 {count} 次", undoDone: "已撤销上一次操作", nothingToUndo: "没有可撤销的操作", undoFailed: "撤销失败：{error}",
  aiPlanningHint: "先列出任务，再将适合的任务拆分为更具体的子任务。",
  agentSetup: "连接你的 Agent", agentCopyPrompt: "复制提示词给你的 Agent", agentCopyHint: "复制后粘贴给 OpenCode、Claude Code 等支持终端的 Agent。提示词自动包含本机 CLI 路径，无需配置应用内模型或 API Key。", agentCopying: "正在复制…", agentCopied: "已复制，粘贴给你的 Agent 即可。", agentCopyFailed: "复制失败：{error}",
  androidAgentTitle: "Android 系统 AI 代理（App Functions）", androidAgentDescription: "在 Android 16+ 上，OneByOne 已向系统 Gemini Agent 开放原生 App Functions 接口，可直接通过系统助手读取、创建、拆分和撤销嵌套清单。锁定时拒绝访问。",
  aiTest: "测试已保存的连接", aiTestOk: "连接成功", aiTestFailed: "连接失败：{error}",
  ai: "AI", aiOpen: "AI 指令（Ctrl+K）", aiPlaceholder: "创建一份旅行清单，或调整当前任务…", aiRun: "执行", aiThinking: "正在生成…", aiUpdated: "AI / Agent 已更新清单", undo: "撤销", aiUndone: "已撤销更新", aiFailed: "AI / Agent 操作失败：{error}", aiDesktopOnly: "AI 功能请在客户端应用中使用。", aiDescription: "用自然语言创建和编辑清单，或连接系统/外部 AI Agent。", aiPreset: "服务预设", aiCustom: "自定义兼容接口", aiBaseUrl: "API Base URL", aiModel: "模型名称", aiApiKey: "API Key", aiKeyHint: "留空保留已存密钥；密钥在本地安全加密存储。", aiClearKey: "清除已存 API Key（本地/局域网模型可勾选）", aiPrivacyHint: "执行时会将当前清单和指令发送到所选接口。支持连接本机或同一局域网下的 Ollama。服务可用性、价格与免费额度以服务商为准。", aiSave: "保存配置", aiSaved: "AI 配置已保存", aiSaveFailed: "无法保存 AI 配置：{error}", aiLoadFailed: "无法读取 AI 配置：{error}", aiCliHint: "外部 Agent：桌面端运行 onebyone-cli schema 查看协议；Android 16+ 支持通过系统 Gemini Agent (App Functions) 直接管理清单。锁定时拒绝访问。", aiConflict: "清单已变化，本次结果未应用，请重新执行。", aiCancelled: "已取消应用本次生成结果", aiSettingsHint: "首次使用请先在设置 → AI 中配置接口与模型。",
  sync: "同步", syncDescription: "在同一 Wi-Fi 局域网下点对点加密同步电脑与手机，无需云端服务器或账号。", syncEnable: "开启局域网同步", syncEnableHint: "开启后，同一局域网内的已配对设备会自动发现并合并待办变更；保险库锁定时暂停同步。", syncDeviceName: "本机名称", syncSaveDevice: "保存名称", syncPairingTitle: "配对新设备", syncPairingHint: "在一台设备上生成 6 位配对码，在另一台设备的“附近设备”中输入该配对码完成双向加密绑定。", syncGenerateCode: "生成 6 位配对码", syncActiveCode: "当前配对码：{code}（2 分钟内有效）", syncNearbyTitle: "附近未配对设备", syncNoNearby: "暂未发现同一 Wi-Fi 下开启同步的其他设备。", syncPair: "配对", syncCodePlaceholder: "6 位配对码", syncConfirmPair: "确认连接", syncPairedTitle: "已配对设备", syncNoPaired: "尚未配对任何设备。", syncNow: "立即同步", syncing: "正在同步…", syncOnline: "在线", syncOffline: "离线", syncInSync: "已同步", syncOutdated: "待同步", syncRemovePeer: "移除", syncUpdatedBanner: "已从局域网设备同步最新待办", syncDone: "局域网同步完成", syncFailed: "同步失败：{error}", pairSuccess: "设备配对成功并已完成首次同步", pairFailed: "配对失败：{error}", syncDesktopMobileOnly: "局域网同步请在桌面或手机客户端中使用。",
  indentTask: "设为子任务", outdentTask: "提升层级", addSiblingTask: "添加同级任务",
  newList: "新列表", myTodos: "我的待办",
  saveFailed: "保存失败，请重试。",
  reorder: "拖动调整顺序或嵌套子任务", undoComplete: "撤销完成", complete: "完成", toggleSubtasks: "勾选或取消父任务会同时更新全部子任务",
  editTodo: "编辑待办：{title}", taskLabel: "{action}：{title}", deleteTodo: "删除待办", deleteNamedTodo: "删除 {title}",
  addSubtask: "添加子任务", addSubtaskNamed: "为 {title} 添加子任务", subtaskProgress: "{done}/{total} 个子任务已完成", cancel: "取消", newTodo: "新待办", todoPlaceholder: "任务或子任务名称",
  dragWindow: "拖动窗口", listName: "列表名称，点击编辑", renameList: "点击修改列表名称", taskProgress: "{done}/{total} 项已完成", allDone: "全部完成",
  takeYourTime: "一步一步，慢慢来", unpin: "取消置顶", pin: "置顶窗口", hide: "隐藏到托盘",
  emptyTitle: "写下任务，再拆分子任务", emptyDescription: "回车添加同级任务；Tab 设为前一项的子任务，Shift+Tab 提升一级；也可拖入其他任务。", emptyDescriptionMobile: "点击下方添加任务；编辑时可用底部工具栏缩进为子任务，或按住左侧手柄拖动排序。",
  todoLists: "待办列表", footer: "{count} 项待完成", stayFocused: "保持专注",
  archiveList: "归档清单", archiveListHint: "归档后可在“已归档”中查看和恢复", archived: "已归档", archivedLists: "已归档清单", archivedEmpty: "没有已归档的清单",
  holdDeleteList: "长按删除清单", holdDeleteListHint: "长按 1.5 秒删除清单", holdDeleteNamedList: "长按 1.5 秒删除清单：{title}",
  archivedHint: "长按垃圾桶 1.5 秒可永久删除清单。", backToList: "返回清单", restoreList: "恢复", restoreNamed: "恢复 {title}", archivedProgress: "{done}/{total} 项已完成", emptyArchivedList: "这个清单没有待办",
  pinFailed: "无法更改置顶状态", hideFailed: "无法隐藏窗口", dragFailed: "无法拖动窗口",
  loadFailed: "无法读取待办", loadFailedHint: "请检查数据文件后重启应用。",
  settings: "设置", closeSettings: "关闭设置", general: "通用", language: "语言", languageHint: "切换后立即生效，并自动保存。",
  settingsFailed: "无法保存语言设置，请重试。",
  openSettingsFailed: "无法打开设置，请重试。", settingsDescription: "按你的习惯，调整 OneByOne。",
  settingsNavigation: "设置分类", generalDescription: "管理应用的语言和通用偏好。", privacy: "隐私", privacyDescription: "管理本地数据的加密和锁定。", privacyDesktopOnly: "本地数据加密仅在客户端应用中可用。", privacyLoading: "正在读取加密状态…", privacyLoadFailed: "无法读取加密状态，请重新打开设置。",
  languageDescription: "选择界面使用的语言，不会修改你的待办内容。", savedAutomatically: "设置会自动保存",
  uiScale: "界面缩放", uiScaleDescription: "调整整个应用中文字和控件的大小。", uiScaleFailed: "无法保存界面缩放设置，请重试。",
  encryption: "本地数据加密", encryptionDescription: "使用独立密码加密待办。忘记密码后无法恢复数据，请妥善保管。", encryptionEnabled: "加密已开启", password: "加密密码", confirmPassword: "再次输入密码", enableEncryption: "开启加密", passwordMismatch: "请输入相同的非空密码。", encryptionFailed: "操作失败，请重试并检查数据文件。", lockOnHide: "隐藏到托盘时锁定", lockOnHideHint: "关闭时仅在退出应用后锁定；开启后每次隐藏都需要重新输入密码。", unlock: "解锁", unlockTitle: "解锁待办", unlockHint: "请输入你的加密密码。", unlockFailed: "密码错误或数据已损坏。", legacyTempWarning: "发现旧版临时文件 todos.json.tmp，可能包含明文；请检查数据目录并自行处理。",
  noteColor: "便签颜色", noteColorNamed: "便签颜色：{color}",
  color_yellow: "柠檬黄", color_orange: "杏橙", color_pink: "蔷薇粉", color_purple: "薰衣草紫", color_blue: "雾蓝", color_green: "薄荷绿",
  changePassword: "修改密码", currentPassword: "当前密码", newPassword: "新密码", confirmNewPassword: "再次输入新密码", passwordChanged: "密码已修改。", currentPasswordFailed: "当前密码错误或数据已损坏。",
};

const en: Record<keyof typeof zh, string> = {
  aiKeySaved: "API key saved.", aiKeyNotSaved: "No API key saved.", aiKeyUnknown: "Unable to determine whether an API key is saved.", aiKeyReplacePlaceholder: "Enter a new key to replace the saved key",
  undoShortcut: "Undo (Ctrl+Z)", undoAvailable: "Undo the last operation; {count} undo steps available", undoDone: "Last operation undone", nothingToUndo: "Nothing to undo", undoFailed: "Couldn't undo: {error}",
  aiPlanningHint: "First list the tasks, then break suitable tasks into more specific subtasks.",
  agentSetup: "Connect your Agent", agentCopyPrompt: "Copy instructions for your Agent", agentCopyHint: "Paste into a terminal-capable Agent such as OpenCode or Claude Code. Instructions include this computer's CLI path automatically. No in-app model or API key setup is needed.", agentCopying: "Copying…", agentCopied: "Copied. Paste into your Agent to get started.", agentCopyFailed: "Couldn't copy: {error}",
  androidAgentTitle: "Android System Agent (App Functions)", androidAgentDescription: "On Android 16+, OneByOne exposes native App Functions to Gemini Agent so it can list, create, break down, and undo nested task lists directly. Locked vaults reject access.",
  aiTest: "Test saved connection", aiTestOk: "Connection successful", aiTestFailed: "Connection failed: {error}",
  ai: "AI", aiOpen: "AI command (Ctrl+K)", aiPlaceholder: "Create a travel list, or edit these tasks…", aiRun: "Run", aiThinking: "Generating…", aiUpdated: "AI / Agent updated the list", undo: "Undo", aiUndone: "Update undone", aiFailed: "AI / Agent failed: {error}", aiDesktopOnly: "AI features are available in the native app.", aiDescription: "Create and edit lists with natural language, or connect a system/external Agent.", aiPreset: "Service preset", aiCustom: "Custom compatible API", aiBaseUrl: "API Base URL", aiModel: "Model", aiApiKey: "API Key", aiKeyHint: "Leave blank to keep the saved key. Keys are stored securely on device.", aiClearKey: "Remove saved API key (useful for local/LAN models)", aiPrivacyHint: "Commands send the current list and prompt to the selected endpoint, even with local encryption enabled. Local or LAN Ollama is supported. Availability, pricing and free quotas depend on the provider.", aiSave: "Save configuration", aiSaved: "AI configuration saved", aiSaveFailed: "Couldn't save AI configuration: {error}", aiLoadFailed: "Couldn't load AI configuration: {error}", aiCliHint: "External Agents: run onebyone-cli schema on desktop, or use Gemini Agent (App Functions) on Android 16+. Locked vaults reject access.", aiConflict: "The list changed. This result was not applied; please run again.", aiCancelled: "Cancelled applying this generation", aiSettingsHint: "First configure your endpoint and model in Settings → AI.",
  sync: "Sync", syncDescription: "Peer-to-peer encrypted sync across PC and Android over the same Wi-Fi LAN—no cloud or account needed.", syncEnable: "Enable LAN sync", syncEnableHint: "Paired devices on the same Wi-Fi automatically discover and merge changes. Sync pauses while your vault is locked.", syncDeviceName: "Device name", syncSaveDevice: "Save name", syncPairingTitle: "Pair a new device", syncPairingHint: "Generate a 6-digit code on one device, then enter it under Nearby devices on your other device.", syncGenerateCode: "Generate 6-digit code", syncActiveCode: "Pairing code: {code} (valid for 2 min)", syncNearbyTitle: "Nearby unpaired devices", syncNoNearby: "No other devices with LAN sync enabled detected on this Wi-Fi.", syncPair: "Pair", syncCodePlaceholder: "6-digit code", syncConfirmPair: "Connect", syncPairedTitle: "Paired devices", syncNoPaired: "No paired devices yet.", syncNow: "Sync now", syncing: "Syncing…", syncOnline: "Online", syncOffline: "Offline", syncInSync: "In sync", syncOutdated: "Pending", syncRemovePeer: "Remove", syncUpdatedBanner: "Synced latest changes from LAN peer", syncDone: "LAN sync completed", syncFailed: "Sync failed: {error}", pairSuccess: "Device paired and synced", pairFailed: "Pairing failed: {error}", syncDesktopMobileOnly: "LAN sync is available in the desktop and mobile apps.",
  indentTask: "Make subtask", outdentTask: "Lift level", addSiblingTask: "Add sibling task",
  newList: "New list", myTodos: "My todos",
  saveFailed: "Couldn't save. Please try again.",
  reorder: "Drag to reorder or nest subtasks", undoComplete: "Mark incomplete", complete: "Complete", toggleSubtasks: "Checking or unchecking a parent also updates all its subtasks",
  editTodo: "Edit task: {title}", taskLabel: "{action}: {title}", deleteTodo: "Delete task", deleteNamedTodo: "Delete {title}",
  addSubtask: "Add subtask", addSubtaskNamed: "Add a subtask to {title}", subtaskProgress: "{done}/{total} subtasks completed", cancel: "Cancel", newTodo: "New task", todoPlaceholder: "Task or subtask name",
  dragWindow: "Drag window", listName: "List name, click to edit", renameList: "Click to rename this list", taskProgress: "{done}/{total} completed", allDone: "All done",
  takeYourTime: "One step at a time", unpin: "Unpin window", pin: "Keep on top", hide: "Hide to tray",
  emptyTitle: "Write a task, then add subtasks", emptyDescription: "Enter adds a sibling; Tab nests under the previous task, Shift+Tab lifts one level. Or drag a task into another.", emptyDescriptionMobile: "Tap below to add a task. Use the bottom bar while editing to indent subtasks, or drag the left handle to reorder.",
  todoLists: "Todo lists", footer: "{count} remaining", stayFocused: "Stay focused",
  archiveList: "Archive list", archiveListHint: "Archived lists can be viewed and restored from Archived", archived: "Archived", archivedLists: "Archived lists", archivedEmpty: "No archived lists",
  holdDeleteList: "Hold to delete list", holdDeleteListHint: "Hold for 1.5 seconds to delete this list", holdDeleteNamedList: "Hold for 1.5 seconds to delete list: {title}",
  archivedHint: "Hold the trash button for 1.5 seconds to delete a list permanently.", backToList: "Back to list", restoreList: "Restore", restoreNamed: "Restore {title}", archivedProgress: "{done}/{total} done", emptyArchivedList: "This list has no tasks",
  pinFailed: "Couldn't change the pin setting", hideFailed: "Couldn't hide the window", dragFailed: "Couldn't drag the window",
  loadFailed: "Couldn't load your tasks", loadFailedHint: "Check the data file, then restart the app.",
  settings: "Settings", closeSettings: "Close settings", general: "General", language: "Language", languageHint: "Applies immediately and saves automatically.",
  settingsFailed: "Couldn't save the language setting. Please try again.",
  openSettingsFailed: "Couldn't open settings. Please try again.", settingsDescription: "Make OneByOne feel like home.",
  settingsNavigation: "Settings categories", generalDescription: "Manage your language and general preferences.", privacy: "Privacy", privacyDescription: "Manage local data encryption and locking.", privacyDesktopOnly: "Local data encryption is available in the native app.", privacyLoading: "Loading encryption status…", privacyLoadFailed: "Couldn't load encryption status. Please reopen settings.",
  languageDescription: "Choose the interface language. Your tasks stay as they are.", savedAutomatically: "Settings save automatically",
  uiScale: "UI Scale", uiScaleDescription: "Scales text and controls across the whole app.", uiScaleFailed: "Couldn't save the UI scale. Please try again.",
  encryption: "Local data encryption", encryptionDescription: "Protect tasks with a separate password. Lost passwords cannot be recovered.", encryptionEnabled: "Encryption enabled", password: "Encryption password", confirmPassword: "Confirm password", enableEncryption: "Enable encryption", passwordMismatch: "Enter matching, non-empty passwords.", encryptionFailed: "Operation failed. Check the data file and try again.", lockOnHide: "Lock when hidden to tray", lockOnHideHint: "When off, lock only on exit; when on, hiding requires a password to reopen.", unlock: "Unlock", unlockTitle: "Unlock tasks", unlockHint: "Enter your encryption password.", unlockFailed: "Incorrect password or damaged data.", legacyTempWarning: "A legacy todos.json.tmp file exists and may contain plaintext; inspect it in the data directory.",
  noteColor: "Note color", noteColorNamed: "Note color: {color}",
  color_yellow: "Lemon", color_orange: "Apricot", color_pink: "Rose", color_purple: "Lavender", color_blue: "Mist blue", color_green: "Mint",
  changePassword: "Change password", currentPassword: "Current password", newPassword: "New password", confirmNewPassword: "Confirm new password", passwordChanged: "Password changed.", currentPasswordFailed: "The current password is incorrect or the data is damaged.",
};

const settingsKey = "onebyone-settings";
let settings: Settings = { language: "zh-CN", uiScale: 100 };
try {
  const stored = JSON.parse(localStorage.getItem(settingsKey) ?? "null");
  if (stored && (stored.language === "en" || stored.language === "zh-CN")) {
    settings = { language: stored.language, uiScale: isUiScale(stored.uiScale) ? stored.uiScale : 100 };
  }
} catch { /* A missing or invalid preference uses the default language. */ }
document.documentElement.style.zoom = `${settings.uiScale}%`;

export function getLanguage(): Language { return settings.language; }
export function getUiScale(): UiScale { return settings.uiScale; }

export function setUiScale(uiScale: UiScale) {
  if (!isUiScale(uiScale) || uiScale === settings.uiScale) return;
  const next = { ...settings, uiScale };
  localStorage.setItem(settingsKey, JSON.stringify(next));
  settings = next;
  document.documentElement.style.zoom = `${uiScale}%`;
  window.dispatchEvent(new Event("zen-settings-changed"));
  if (isTauri()) void emit("ui-scale-changed", uiScale).catch(console.error);
}

export function setLanguage(language: Language) {
  if (language === settings.language) return;
  const next = { ...settings, language };
  localStorage.setItem(settingsKey, JSON.stringify(next));
  settings = next;
  window.dispatchEvent(new Event("zen-settings-changed"));
}

// Storage covers browser windows; native events also cover delayed WebView notifications.
export async function watchSettings(onChange: () => void): Promise<() => void> {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== settingsKey) return;
    try {
      const next = JSON.parse(event.newValue ?? "null");
      if (next && (next.language === "en" || next.language === "zh-CN")) {
        const uiScale = isUiScale(next.uiScale) ? next.uiScale : 100;
        if (next.language === settings.language && uiScale === settings.uiScale) return;
        settings = { language: next.language, uiScale };
        document.documentElement.style.zoom = `${uiScale}%`;
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
  const unlistenScale = isTauri() ? await listen<number>("ui-scale-changed", ({ payload }) => {
    if (isUiScale(payload) && payload !== settings.uiScale) {
      settings = { ...settings, uiScale: payload };
      document.documentElement.style.zoom = `${payload}%`;
      onChange();
    }
  }).catch(() => undefined) : undefined;
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("zen-settings-changed", onChange);
    unlisten?.();
    unlistenScale?.();
  };
}

export function t(key: keyof typeof zh, params: Record<string, string | number> = {}): string {
  const text = (settings.language === "en" ? en : zh)[key];
  return text.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match));
}
