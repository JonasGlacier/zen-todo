# AI and external Agent CLI / AI 与外部 Agent CLI

## In-app AI / 应用内 AI

Configure an endpoint in **Settings → AI**, save, and optionally test the saved connection. Click ✨ or press **Ctrl+K** to enter a command, then press Enter. Shift+Enter inserts a line break. Examples:

- `Create a release checklist and break suitable tasks into concrete subtasks.`
- `Break down the publishing task into subtasks. Keep my other tasks.`
- `创建一份周末旅行清单。`
- `把整理行李拆分成具体的物品子任务，保留其他待办。`

Zen Todo is a **todo list with nested subtasks**. Parents appear above their children. AI first writes a task list, then considers each task and breaks it down into more detailed subtasks where useful. For example, “Pack items for the trip” can contain “3 shirts”, “5 pairs of underwear”, “Sunglasses”, and “Toothbrush”. Simple items do not need forced subdivision.

Zen Todo 是一个**可以嵌套子任务的待办清单**。AI 指示为：先写一份任务清单，再尝试给每一条任务（如果可以的话）拆分出更详细的子任务。例如，“整理旅行需要携带的物品”可以包含“衬衫3件”“内裤5件”“太阳镜”“牙刷”等。它们是父任务包含的内容，不是执行先后关系。

Changes apply immediately. The footer notice offers **Undo / 撤销** for the latest AI/Agent write. A manual edit or list switch invalidates that snapshot rather than discarding later work. Invalid JSON, duplicate IDs, unknown parents and cyclic nesting are rejected without changing the saved list. Results based on an outdated workspace are rejected too.

API presets are editable examples, not guarantees of free service or model availability. Small models are worth trying, but task quality and JSON reliability vary. Ollama's default example requires `ollama pull qwen2.5:7b` and a running local Ollama server.

## CLI setup / CLI 使用

**Quick start:** open **Settings → AI → Connect your Agent → Copy instructions for your Agent**, then paste into OpenCode, Claude Code or another terminal-capable Agent. The copied instructions already contain this computer's actual CLI path, shell quoting examples and the workflow. No path editing or in-app model/API key configuration is needed. Instructions follow the interface language. A missing CLI or clipboard failure is shown in Settings instead of reporting success.

**快速开始：**打开 **设置 → AI → 连接你的 Agent → 复制提示词给你的 Agent**，粘贴给 OpenCode、Claude Code 等支持终端的 Agent 即可。提示词自动填写本机实际 CLI 路径，附带带引号的命令示例与操作规则，不需要手改路径，也无需配置应用内模型或 API Key。提示词语言跟随界面语言；CLI 缺失或剪贴板操作失败时会在设置中显示错误。

The Windows installer includes **`zen-todo-cli.exe`** beside the GUI executable. Use its full path or add that directory to your own PATH. It is a separate console executable so Windows shells and Agents receive stdout, stderr and exit codes correctly. Keep Zen Todo running; it may be hidden in the tray. A locked vault rejects data access. The CLI never starts a second GUI or edits `todos.json` directly.

Windows 安装包会将独立的控制台程序 `zen-todo-cli.exe` 放在应用安装目录。可使用完整路径，或自行将安装目录加入 PATH。应用必须保持运行，可以隐藏到托盘；锁定保险库后，CLI 不能读取或修改数据。

Development build / 开发构建：

```sh
cargo build --manifest-path src-tauri/Cargo.toml --bin zen-todo-cli
./src-tauri/target/debug/zen-todo-cli.exe schema
```

Commands / 命令：

```sh
zen-todo-cli schema               # protocol and examples, no running app required
zen-todo-cli list                 # nested taskLists, flat workspace, revision, canUndo
zen-todo-cli apply request.json   # submit UTF-8 JSON from a file
zen-todo-cli apply -              # submit JSON from stdin
zen-todo-cli undo                 # undo latest AI/Agent write
```

Success writes JSON to stdout and exits 0. Failure writes a JSON error to stderr and exits 1. `schema` and `--help` work offline without an instance. Requests use an authenticated loopback connection; the current port and random session token are in `%APPDATA%/com.zentodo.app/cli-session.json`. Do not pass that token to the language model. The file is replaced on each app start; a stale file does not mean the app is running.

### Create a list / 新建清单

Save the following as UTF-8 `request.json`, then run `zen-todo-cli apply request.json`:

```json
{
  "command": "apply",
  "action": {
    "mode": "create",
    "title": "旅行",
    "color": "green",
    "todos": [
      {
        "id": "pack",
        "title": "整理旅行需要携带的物品",
        "children": [
          { "id": "shirts", "title": "衬衫3件" },
          { "id": "underwear", "title": "内裤5件" },
          { "id": "glasses", "title": "太阳镜" },
          { "id": "brush", "title": "牙刷" }
        ]
      }
    ]
  }
}
```

`todos` contains top-level tasks. **`children` contains a task's subtasks**, recursively. Omit `children` or use `[]` for a leaf task. Each task needs a unique `id`; new temporary IDs are mapped to UUIDs. New leaf tasks default to incomplete.

`todos` 放顶层任务，**`children` 放该任务的子任务**，可以继续嵌套。叶子任务可省略 `children` 或填写 `[]`。每个任务都需要唯一 ID，新任务可用临时 ID，应用会统一转换为 UUID。

### Edit a list / 编辑清单

First run `list`. Prefer its **`taskLists`** field: each list already contains a nested `todos` tree that can be reused in an update. Copy the response's `revision` and the target list's `id`. Submit:

```json
{
  "command": "apply",
  "revision": "COPY_REVISION_FROM_LIST",
  "action": {
    "mode": "update",
    "listId": "COPY_LIST_ID_FROM_LIST",
    "todos": [
      {
        "id": "EXISTING_PARENT_ID",
        "title": "整理旅行需要携带的物品",
        "children": [
          { "id": "EXISTING_SHIRTS_ID", "title": "衬衫3件", "completed": true },
          { "id": "new-item", "title": "牙刷", "completed": false }
        ]
      }
    ]
  }
}
```

**`todos` and its `children` are the complete target tree. Omitted tasks and subtasks are removed.** Include every task to retain. Existing IDs and creation timestamps are preserved. Omitting `completed` preserves an existing leaf task's state. A parent's state is derived from its children: all complete → complete; any incomplete → incomplete. To complete/reopen a subtree through a full-state `apply`, set its leaf completion states. The UI's parent checkbox updates the whole subtree for you. Updates to archived lists are rejected. `title` and `color` are optional on updates; new lists require `title`. Allowed colors: `yellow`, `orange`, `pink`, `purple`, `blue`, `green`. Maximum: **300 tasks including subtasks**, 200 characters per task title, 80 per list title.

**`todos` 及其 `children` 是完整的目标树，没提交的任务或子任务会被移除。** 更新时须保留所有希望保留的待办和原始 ID。省略 `completed` 会保留已有叶子任务的完成状态；父任务的完成状态由子任务自动计算。通过完整状态的 `apply` 完成/取消整棵子任务树时，要更新其中的叶子任务状态；界面勾选父任务会自动完成这个操作。

For tools that prefer a flat representation, `workspace.lists[].board.todos` stores each task with **`parentId`** (`null` for a root). Flat `action.todos` entries with `parentId` are also accepted. Prefer nested `children` for generation; do not mix conflicting parent references with nesting. Protocol version **2** does not accept `nextId` in new actions. Legacy saved files are read as parent/child relationships and written with `parentId` on the next save; IDs, titles and timestamps are retained, with parent completion recalculated.

习惯扁平结构的工具也可使用 `parentId` 指向父任务，顶层任务为 `null`；内部 `workspace` 使用此表示。AI 生成推荐使用嵌套 `children`，不要同时提交相互冲突的父子关系。协议版本 **2** 不再接受新请求中的 `nextId`；旧版存储会自动按父子关系读取，下一次保存时写入 `parentId`，保留原任务 ID、标题和创建时间，并按子任务重算父任务完成状态。

If the workspace changes between `list` and `apply`, the update fails with a conflict. Re-read and re-plan rather than blindly replaying the old request. The foreground UI commits its active editor and flushes its save queue before processing CLI requests; a failed pending save rejects the CLI request. When hidden, Rust applies and encrypts changes directly, and stale editor drafts are discarded before the next restore. Undo is in-memory, one level, and cleared on exit or vault lock.

出现冲突时，应重新读取清单并重新规划，不要直接覆盖。前台 CLI 操作会等待编辑器保存；后台操作由 Rust 统一处理并按当前加密状态落盘。后台修改后会丢弃旧界面草稿，防止恢复窗口时旧内容盖住新内容。撤销仅保留一层，退出应用或锁定保险库后清除。

### Suggested Agent instruction / 可交给 Agent 的指令

> Use `zen-todo-cli schema`, then `list` and its nested `taskLists` view. First write a task list, then break each task into more detailed subtasks where useful. “Pack items for the trip” can contain “3 shirts”, “5 pairs of underwear”, “Sunglasses”, and “Toothbrush”. Submit the complete tree using `todos` and `children`, with a unique ID for every task. Updates need revision and listId; retain existing IDs, completion states and tasks outside the request. Re-read and re-plan on conflict. Never edit app data or session files directly.

> 先执行 `zen-todo-cli schema`，再用 `list` 的嵌套 `taskLists` 视图读取清单。先写一份任务清单，再尝试给每一条任务（如果可以的话）拆分出更详细的子任务。例如，“整理旅行需要携带的物品”可拆成“衬衫3件”“内裤5件”“太阳镜”“牙刷”。用 `todos` 和 `children` 提交完整的父子树，每个任务都使用唯一 ID。更新时附上 revision、明确 listId，保留原任务 ID、完成状态和请求范围外的待办。遇到冲突先重新读取并规划，不要直接编辑应用的数据文件或会话文件。
