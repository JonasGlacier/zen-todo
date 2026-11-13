# OneByOne: AI To-Do List

**English** · [简体中文](#简体中文)

A lightweight todo app with nested subtasks for **Windows 10/11** and **Android**, built with Tauri 2, Rust, TypeScript, HTML and CSS. Package identifier: `com.rossemlab.onebyone`.

<img src="screenshot.png" alt="OneByOne with nested tasks and subtasks" width="380">

*App preview with example tasks.*

## Features

- **Multiple Sticky-Note Lists**: Keep independent lists with 6 paper colors; archive them for later viewing and restoration, or hold the delete button for 1.5 seconds to delete a list.
- **Nested Subtasks**: Organize tasks into recursive subtasks. Check a parent to complete its whole subtree, or finish its subtasks individually and the parent completes automatically. Unchecking a child reopens its ancestors.
- **Desktop & Touch Ergonomics**:
  - Desktop: Enter adds a sibling, Tab nests under the previous sibling, Shift+Tab lifts a level; compact borderless always-on-top window with low-memory system tray mode.
  - Android: Touch drag-and-drop via Pointer Events, floating quick-edit bar above the keyboard (`Indent`, `Outdent`, `Add Subtask`, `Add Sibling`, `Delete`), top Undo button, and single-window inline settings.
- **LAN Peer-to-Peer Sync**: Discover devices automatically on the same Wi-Fi, pair once using an Argon2id-hardened **6-digit pairing code**, and sync changes end-to-end encrypted (`AES-256-GCM`) with conflict-free LWW + tombstone merging—no cloud server or account required.
- **AI & Agent Native**:
  - **In-app BYOK AI**: Use ✨ or Ctrl+K with any OpenAI-compatible API or local/LAN Ollama (`http://localhost:11434/v1` or `http://192.168.x.x:11434/v1`).
  - **Android 16+ App Functions API**: Exposes `OneByOneAppFunctionService` directly to system Gemini Agent to list, create, break down, and undo nested todo lists.
  - **Desktop CLI**: External Agents can use `onebyone-cli.exe` to read lists, submit changes, and undo. See [AI, App Functions & CLI](docs/ai-and-cli.md).
- **Local Vault Encryption**: Protect data at rest with Argon2id + AES-256-GCM.

## Privacy and Storage

Desktop data is stored in `%APPDATA%/com.rossemlab.onebyone/todos.json`; Android data is stored in the app's private sandbox (`files/todos.json`). Encryption is off by default and can be enabled under **Settings → Privacy**. **A forgotten encryption password cannot be recovered.**

## Development

Requirements: Node.js 22.18+, Rust stable, Windows WebView2 Runtime (desktop), and Android SDK 36 + NDK 29 (Android).

```bash
npm install
npm run dev          # browser development preview
npm test             # nested task and history tests
npm run build        # frontend TypeScript + Vite build
cargo test --manifest-path src-tauri/Cargo.toml # Rust unit tests (agent, sync, pairing, AI, vault)
npm run build:cli    # desktop CLI (onebyone-cli)
npm run tauri dev    # desktop development
npm run tauri build  # Windows installer
```

Android build:

```bash
rustup target add aarch64-linux-android
cd src-tauri/gen/android && ./gradlew assembleArm64Debug
```

---

## 简体中文

**OneByOne**（商店名：**OneByOne: AI To-Do List**，包名：`com.rossemlab.onebyone`）是一个面向 **Windows 10/11** 与 **Android**、支持多层嵌套子任务的轻量便签待办应用，基于 Tauri 2、Rust 与原生 HTML/CSS/TypeScript 构建。

### 核心功能

- **多便签清单与归档**：6 种柔和便签纸色，支持创建、重命名、归档恢复与长按 1.5 秒彻底删除。
- **父子任务自动联动**：父任务在上，子任务缩进在下；勾选父任务完成整棵子树，子任务全部完成时父任务自动完成，取消任一子任务自动重开祖先任务。
- **桌面与 Android 双端交互**：
  - Windows 桌面端：紧凑无边框置顶悬浮窗、低内存系统托盘销毁/恢复模式、键盘 `Enter` / `Tab` / `Shift+Tab` 快速大纲编辑。
  - Android 移动端：基于 Pointer Events 的触控拖拽排序与嵌套、软键盘上方悬浮快捷编辑栏（缩进、提升、加子任务、加同级、删除）、顶部一键撤销与单窗口内嵌设置页。
- **局域网点对点加密同步（LAN P2P）**：同一 Wi-Fi 下通过 UDP 多播/广播自动发现设备，首次使用 **6 位动态配对码** 双向认证并派生 256 位密钥，后续通过 TCP + `AES-256-GCM` 自动同步；内置基于时间戳（`updatedAt`）与软删除墓碑（Tombstones）的无冲突合并引擎，无需任何云端服务器或账号。
- **全场景 AI 支持**：
  - **应用内自带 API Key（BYOK）**：支持自定义兼容接口及本机/局域网 Ollama（手机可直接调用局域网电脑上的 Ollama）。
  - **Android 16+ App Functions API**：原生实现 `OneByOneAppFunctionService`，向系统级 Gemini Agent 暴露清单读取、创建、子任务拆解与撤销能力。
  - **桌面端 Agent CLI**：随安装包附带 `onebyone-cli.exe`，供 OpenCode、Claude Code 等终端 Agent 直接调用。详见 [AI、Android 系统 Agent 与桌面 CLI 说明](docs/ai-and-cli.md)。
- **本地保险库加密**：支持基于 Argon2id + AES-256-GCM 的独立密码本地加密。
