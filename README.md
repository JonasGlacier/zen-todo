# Zen Todo

一个面向 Windows 10/11 的轻量悬浮待办应用。使用 Tauri 2、Rust 和原生 HTML/CSS/TypeScript 构建。

## 当前功能

- 按组添加、完成、删除待办事项，直接点击组名可重命名
- 嵌套边框展示步骤：上一步在内侧，下一步在外侧下方
- 同组任务并行；所有前置组全部完成后，下一组才可完成
- 支持组之间多对多依赖，共享的上一步显示为可点击定位的引用
- 撤销前提完成状态时，自动撤销相关后续任务的完成状态
- 组内拖动排序，删除组时只删除本组及相关依赖，不删除后续组
- 任务保存到用户数据目录，不依赖数据库
- 无边框小窗口，支持拖动和始终置顶
- 关闭窗口时隐藏到系统托盘
- 左键点击托盘图标恢复窗口
- 托盘菜单支持显示窗口和退出应用

## 分组与步骤

1. 在列表底部输入组名，创建第一组，再输入该组的待办；可连续按回车添加。
2. 点击组标题右侧的 `⋯`，选择 `＋ 上一步` 或 `＋ 下一步`。
3. 输入组名创建新步骤，或点击已有组建立关联。每个组可以有多个上一步和下一步，循环依赖不可添加。
4. 等待中的组完整显示、任务置灰，完成按钮不可用。空的前置组不会解锁下一步，需要添加并完成待办，或解除关联。
5. 在 `⋯` 中可以解除上一步关联或删除本组。清除已完成会移除完整完成的组及其关联，部分完成的组仅移除已完成待办。

在普通浏览器中运行时，数据保存在该浏览器的 localStorage；桌面应用使用本地文件。

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
