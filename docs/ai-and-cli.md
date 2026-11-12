# AI and external Agent CLI / AI 与外部 Agent CLI

## In-app AI / 应用内 AI

Configure an endpoint in **Settings → AI**, save, and optionally test the saved connection. Click ✨ or press **Ctrl+K** to enter a command, then press Enter. Shift+Enter inserts a line break. Examples:

- `Create a checklist for releasing my app, with testing before publishing.`
- `Break down the publishing task into a few prerequisite steps. Keep my other tasks.`
- `创建一份周末旅行清单。`
- `把当前清单里的发布任务拆解成几个上一步，保留其他待办。`

Changes apply immediately. The footer notice offers **Undo / 撤销** for the latest AI/Agent write. A manual edit or list switch invalidates that snapshot rather than discarding later work. Invalid JSON, duplicate IDs, unknown references and dependency cycles are rejected without changing the saved list. Results based on an outdated workspace are rejected too.

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
zen-todo-cli list                 # workspace (including archives), revision, canUndo
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
    "title": "Release",
    "color": "green",
    "todos": [
      { "id": "test", "title": "Run tests", "nextId": "publish" },
      { "id": "publish", "title": "Publish release", "nextId": null }
    ]
  }
}
```

`nextId` points **from a prerequisite to its next step**. Several prerequisites can point to one next step, but each task has at most one next step. New temporary IDs are mapped to real UUIDs, including references between them. New tasks default to incomplete.

`nextId` 是从“上一步”指向“下一步”。多个上一步可以指向同一个下一步；每个待办只有一个下一步。临时 ID 会统一转换为 UUID，并同步转换引用。

### Edit a list / 编辑清单

First run `list`. Copy its `revision` and the target list's `id`. Submit:

```json
{
  "command": "apply",
  "revision": "COPY_REVISION_FROM_LIST",
  "action": {
    "mode": "update",
    "listId": "COPY_LIST_ID_FROM_LIST",
    "todos": [
      { "id": "EXISTING_TASK_ID", "title": "Updated task", "nextId": null },
      { "id": "new-task", "title": "Another task", "nextId": null }
    ]
  }
}
```

**`todos` is the complete target list. Omitted tasks are removed.** Include all tasks to retain. Existing task IDs and creation timestamps are preserved. Omitting `completed` preserves an existing task's state; omitting `nextId` detaches it. Adding unfinished prerequisites reopens blocked completed tasks. Updates to archived lists are rejected. `title` and `color` are optional on updates; new lists require `title`. Allowed colors: `yellow`, `orange`, `pink`, `purple`, `blue`, `green`. Maximum: 300 tasks, 200 characters per task title, 80 per list title.

**`todos` 是完整的目标清单，没提交的任务会被移除。** 更新时须保留所有希望保留的任务及其原始 ID。省略 `completed` 保留已有完成状态，省略 `nextId` 则断开该任务与下一步的关系。

If the workspace changes between `list` and `apply`, the update fails with a conflict. Re-read and re-plan rather than blindly replaying the old request. The foreground UI commits its active editor and flushes its save queue before processing CLI requests; a failed pending save rejects the CLI request. When hidden, Rust applies and encrypts changes directly, and stale editor drafts are discarded before the next restore. Undo is in-memory, one level, and cleared on exit or vault lock.

出现冲突时，应重新读取清单并重新规划，不要直接覆盖。前台 CLI 操作会等待编辑器保存；后台操作由 Rust 统一处理并按当前加密状态落盘。后台修改后会丢弃旧界面草稿，防止恢复窗口时旧内容盖住新内容。撤销仅保留一层，退出应用或锁定保险库后清除。

### Suggested Agent instruction / 可交给 Agent 的指令

> Use `zen-todo-cli schema` to learn the protocol. Read the workspace with `list`, then submit `apply` using a UTF-8 file or stdin. For updates, include the returned revision and explicit listId, preserve existing IDs, and include every task that should remain. nextId points from a prerequisite to its next step. Re-read and re-plan on conflict. Do not directly edit the app's data or session files.

> 先执行 `zen-todo-cli schema` 学习协议，再用 `list` 读取清单。通过 UTF-8 文件或标准输入提交 `apply`。更新时附上 revision、明确 listId，保留已有任务 ID，并提交所有希望保留的待办。nextId 从上一步指向下一步。遇到冲突先重新读取并规划，不要直接编辑应用的数据文件或会话文件。
