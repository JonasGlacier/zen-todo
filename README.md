# Zen Todo

**English** · [简体中文](#简体中文)

A lightweight floating todo app for Windows 10 and 11, built with Tauri 2, Rust, TypeScript, HTML and CSS.

<img src="screenshot.png" alt="Zen Todo showing tasks and their dependencies" width="380">

*App preview with example tasks.*

## Features

- Keep multiple independent lists; archive them for later viewing and restoration, or hold the delete button for 1.5 seconds to delete a list.
- Tasks are plain, Notion-style rows. Each task can have several previous steps but only one next step, so dependencies form a tree that converges. Previous steps are indented above the task they lead to; a task can be completed only after all its previous steps are done, and reopening one reopens the tasks after it.
- Edit in place: Enter adds a task, Tab/Shift+Tab nests or lifts it, and drag the handle to reorder or drop onto another task to make it that task's previous step.
- Use a compact, draggable, always-on-top window. Hide it to the system tray and restore it with a click; choose Quit from the tray to exit.
- Switch between English and Simplified Chinese in Settings. The settings window is borderless and can be dragged from its top edge.
- Optionally encrypt desktop data with a separate password and choose whether hiding to the tray locks the app.

## Privacy and storage

Desktop data is stored in `%APPDATA%/com.zentodo.app/todos.json`. Encryption is **off by default**; enable it under **Settings → Privacy**. Zen Todo uses Argon2id to derive a key and AES-256-GCM to encrypt the lists. The password can be changed after entering the current password. **A forgotten encryption password cannot be recovered.**

When lock-on-hide is enabled, reopening from the tray requires the password, and unsent drafts are retained encrypted in the tray process. Old `todos.json.tmp` files, system backups, or other existing copies may still contain plaintext. Browser development mode stores data in localStorage and does not provide this encryption. Cross-device synchronization is not yet implemented.

## Development

Requirements: Node.js 22.18 or later, Rust stable, and the Windows WebView2 Runtime.

```bash
npm install
npm run dev          # browser development preview
npm test             # task-dependency tests
npm run build        # frontend build
npm run tauri dev    # desktop development
npm run tauri build  # Windows installer
```

The repository also includes a GitHub Actions workflow to build the Windows installer; download the `zen-todo-windows-installer` artifact from the workflow run.

---

## 简体中文

一个面向 Windows 10/11 的轻量悬浮待办应用。使用 Tauri 2、Rust 和原生 HTML/CSS/TypeScript 构建。

## 当前功能

- 通过标签页创建、切换、重命名多个独立待办列表；点击顶部列表名称可编辑
- 可归档清单，在标签栏的归档按钮中查看并恢复；也可长按删除按钮 1.5 秒删除活跃或已归档的清单。归档或删除最后一个活跃列表时自动创建空白列表
- 待办是类似 Notion 的独立行，不再有分组；点击文字即可编辑，已完成的待办会一直保留
- 每个待办可以有多个“上一步”，但只有一个“下一步”，整体是逐渐收敛的树；上一步缩进显示在下一步上方
- 所有上一步完成后，待办才能完成；撤销某个上一步时，自动撤销其后续待办的完成状态
- 键盘：回车添加同级待办；Tab 设为下一行待办的上一步，Shift+Tab 上移一级；空的新待办按 Backspace 删除；上下方向键在待办间移动
- 拖动左侧手柄：落在目标上/下边缘为调整顺序（并改为同一个下一步），落在中间则成为目标的上一步；不能形成循环
- 悬停显示“添加上一步”和删除；删除待办时，其上一步改为连接到它的下一步
- 所有上一步始终显示在清单中
- 任务保存到用户数据目录，不依赖数据库；旧数据不做迁移兼容
- 无边框小窗口，支持拖动和始终置顶，整条顶部区域可拖动
- 顶部齿轮打开独立设置窗口，可切换简体中文 / English
- 桌面版可在设置中启用独立密码加密，并选择隐藏到托盘时是否锁定
- 界面使用 Lucide SVG 图标，默认启用低内存托盘模式：收起时保存状态并销毁窗口，只保留托盘进程

在普通浏览器中运行时，数据保存在该浏览器的 localStorage；桌面应用使用本地文件。

## 设置与语言

点击右上角齿轮打开独立设置窗口，默认尺寸为 640×480，最小尺寸为 480×360，可通过窗口顶部空白区域拖动。窗口采用左侧分类、右侧设置内容的布局。重复点击齿轮会激活已有设置窗口；关闭设置窗口不会退出应用，也不影响主窗口使用。

在“通用 → 语言”中选择简体中文或 English，设置即时保存。语言偏好单独保存在 WebView / 浏览器的 `zen-todo-settings` 中，下次打开自动恢复。跨窗口通过 storage 事件与 Tauri 事件同步，切换语言不会修改已有列表名称、组名和待办内容，也不会丢失主窗口中正在编辑的草稿。

普通浏览器开发模式下，设置会打开到独立的命名弹出窗口；也可以直接访问 `/?view=settings` 预览设置页面。

### 本地加密

桌面版默认不加密。在设置的“隐私 → 本地数据加密”中输入两次密码并开启后，应用使用 Argon2id 派生密钥，以 AES-256-GCM 加密所有列表。迁移时先验证密文，再通过临时文件替换 `todos.json`；后续保存的临时文件也只包含密文。密码不会保存到文件中，**忘记密码将无法恢复数据**，请使用可靠的密码管理方式。

重启应用需要输入密码。可在设置中开启“隐藏到托盘时锁定”，此时关闭或隐藏窗口后重新显示也需要密码；未提交的输入草稿会在托盘进程内以密文保留，解锁后恢复。关闭该选项时，应用在托盘运行期间保持解锁，直到退出应用。

加密开启后可在“隐私 → 本地数据加密”中修改密码；需要输入当前密码和两次新密码。应用验证原密码并以新密码重新加密，写入成功后才切换密钥。

加密文件带有版本和密钥派生参数，可在未来跨平台实现兼容读取；目前尚未实现同步。该功能不加密浏览器开发模式的 localStorage。旧版遗留的 `todos.json.tmp`、系统备份或其他已有副本可能仍包含明文，应用不会擅自删除这些文件；请根据需要自行检查处理。

顶部拖动区域已扩大为整窗宽 24px；列表名称下方的状态文字与标题栏空白处也可拖动，输入框和操作按钮保持原有交互。

## 低内存托盘模式

此模式默认开启，不提供开关。点击隐藏按钮或关闭主窗口时，应用会等待当前保存完成，再保存待办和界面快照，销毁主窗口及设置窗口的 WebView。没有窗口时，Rust 进程和系统托盘仍然运行；托盘菜单的“退出”才会结束应用。

点击托盘图标或“显示窗口”时，应用按原窗口配置重新创建主窗口，恢复当前列表、置顶状态、窗口位置和大小、滚动位置及待办输入草稿。设置窗口不自动重建。界面快照保留在托盘进程内存中；已保存待办仍写入 `todos.json`。保存失败时不会销毁主窗口，可继续编辑并重试。

## 开发环境

需要安装：

- Node.js 22.18+（支持直接运行 TypeScript 依赖规则测试）
- Rust stable（通过 `rustup` 安装）
- Windows WebView2 Runtime

安装依赖后运行前端：

```bash
npm install
npm run dev
```

运行依赖规则测试及前端构建：

```bash
npm test
npm run build
```

运行桌面开发模式：

```bash
npm run tauri dev
```

构建 Windows 安装包：

```bash
npm run tauri build
```

## GitHub 云端构建

项目已包含 GitHub Actions 工作流。将代码推送到 GitHub 后，在仓库的 `Actions` 页面手动运行 `Build Windows Installer`，或推送到 `main`/`master` 分支自动构建。

构建完成后，在对应任务的 `Artifacts` 中下载 `zen-todo-windows-installer`，其中包含 Windows `.exe` 安装包。本地无需安装 Rust。

工作流会先从 `src-tauri/icons/icon.svg` 自动生成 Windows 安装包所需的图标文件。

数据保存在 `%APPDATA%/com.zentodo.app/` 下的 `todos.json` 中。
