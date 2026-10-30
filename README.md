# Zen Todo

一个面向 Windows 10/11 的轻量悬浮待办应用。使用 Tauri 2、Rust 和原生 HTML/CSS/TypeScript 构建。

## 当前功能

- 添加、完成、删除待办事项
- 任务保存到用户数据目录，不依赖数据库
- 无边框小窗口，支持拖动和始终置顶
- 关闭窗口时隐藏到系统托盘
- 左键点击托盘图标恢复窗口
- 托盘菜单支持显示窗口和退出应用
- 生产前端包约 8 KB（未压缩）

## 开发环境

需要安装：

- Node.js 20+
- Rust stable（通过 `rustup` 安装）
- Windows WebView2 Runtime

安装依赖后运行前端：

```bash
npm install
npm run dev
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
