# ⬡ Claude Code Monitor

[English](README.md) | [中文](README_CN.md)

跨 SSH 主机实时监控多个 Claude Code 会话的仪表盘。一览所有会话的 token 用量、状态、变更文件等，无需在终端之间来回切换。

<!-- TODO: 添加截图到 docs/preview.png -->
<!-- ![仪表盘预览](docs/preview.png) -->

## 为什么需要这个工具？

如果你在多台远程机器上运行 Claude Code（通过 SSH + tmux），追踪各处的运行状况会很痛苦。这个工具可以：

- **监听 `~/.claude/`** 目录，获取各主机上的实时会话数据
- **聚合** 多台 SSH 主机的会话到一个仪表盘
- **WebSocket 推送** — 无轮询、无需刷新
- **全面展示**：状态、token 用量、模型、分支、变更文件、子 agent
- **一键 SSH**：展开任意会话即可看到 `tmux attach` 命令

## 架构

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  SSH 主机 1  │     │  SSH 主机 2  │     │  SSH 主机 3  │
│  ~/.claude/  │     │  ~/.claude/  │     │  ~/.claude/  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │ ssh/sshfs          │                     │
       └────────────┬───────┴─────────────────────┘
                    │
          ┌─────────▼─────────┐
          │   监控服务器       │
          │  (Node.js + WS)   │
          │   - 监听目录      │
          │   - 解析 JSONL    │
          │   - 数据聚合      │
          └─────────┬─────────┘
                    │ WebSocket
          ┌─────────▼─────────┐
          │   React 仪表盘    │
          │  (Vite + React)   │
          └───────────────────┘
```

## 快速开始

### 前置要求

- Node.js 18+
- 远程主机的 SSH 访问权限（建议使用密钥认证）
- 远程主机上在 tmux 会话中运行 Claude Code

### 1. 克隆 & 安装

```bash
git clone https://github.com/Xiang-Pan/claude-code-monitor.git
cd claude-code-monitor
npm install
```

### 2. 配置主机

复制示例配置并编辑：

```bash
cp config.example.json config.json
```

```jsonc
{
  "hosts": [
    {
      "name": "dev-server-1",
      "mode": "local",           // "local" 或 "ssh"
      "claudeDir": "~/.claude"
    },
    {
      "name": "gpu-box",
      "mode": "ssh",
      "user": "ubuntu",
      "host": "your-server-ip",
      "port": 22,
      "claudeDir": "~/.claude",
      "identityFile": "~/.ssh/id_ed25519"
    }
  ],
  "server": {
    "port": 3456,
    "pollIntervalMs": 3000
  }
}
```

**模式选项：**
- `local` — 监听运行监控程序的本机上的 `~/.claude`（最简单）
- `ssh` — 通过 SSH 轮询远程主机（穿透防火墙，远程无需额外配置）

### 3. 运行

```bash
# 开发模式（服务端 + 客户端热重载）
npm run dev

# 生产模式
npm run build
npm start
```

浏览器打开 **http://localhost:3456**。

### 仅本机监控的一行命令

如果只想监控当前机器上的 Claude Code：

```bash
npx claude-code-monitor
```

## 工作原理

### 数据来源：`~/.claude/`

Claude Code 在本地存储所有会话数据：

```
~/.claude/
├── projects/                        # 每个项目的会话记录
│   └── -home-user-projects-myapp/   # 编码路径（/ → -）
│       ├── {session-uuid}.jsonl     # 完整对话历史
│       ├── agent-{id}.jsonl         # 子 agent 记录
│       └── sessions-index.json      # 会话元数据索引
├── stats-cache.json                 # 聚合使用统计
├── history.jsonl                    # 全局提示历史
├── todos/{sessionId}.json           # 每个会话的任务列表
└── file-history/{sessionId}/        # 文件检查点
```

每个 `.jsonl` 文件每行一个 JSON 事件：

```json
{"type":"user","message":{"role":"user","content":"Fix the auth bug"},"timestamp":"2025-06-02T18:46:59.937Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll look into..."}]},"timestamp":"2025-06-02T18:47:06.267Z"}
```

监控程序解析这些文件以提取：
- 会话状态（活跃/空闲/完成），基于最后一条消息的时间
- 消息和工具调用计数
- 来自 assistant 消息元数据的 token 用量
- 来自会话元数据的 Git 分支和工作目录
- 来自 `agent-*.jsonl` 文件的子 agent 活动

### 通过 SSH 远程监控

对于远程主机，服务器会定期执行：

```bash
ssh user@host 'cat ~/.claude/stats-cache.json && \
  find ~/.claude/projects -name "*.jsonl" -mmin -60 -exec tail -1 {} \;'
```

非常轻量 — 只读取最近修改的文件并拉取最后一行来检查状态。远程主机上无需常驻连接或守护进程。

### 替代方案：sshfs 挂载

如果需要更低延迟，可以挂载远程 `~/.claude` 目录：

```bash
# 挂载远程 claude 目录
sshfs user@gpu-box:.claude /mnt/claude-gpu-box
sshfs user@dev-server:.claude /mnt/claude-dev-server

# 然后配置为 "local" 模式指向挂载点
{
  "name": "gpu-box",
  "mode": "local",
  "claudeDir": "/mnt/claude-gpu-box"
}
```

## 配置

### `config.json`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `hosts` | array | 必填 | 主机配置列表 |
| `hosts[].name` | string | 必填 | 主机显示名称 |
| `hosts[].mode` | string | `"local"` | `"local"` 或 `"ssh"` |
| `hosts[].claudeDir` | string | `"~/.claude"` | .claude 目录路径 |
| `hosts[].user` | string | — | SSH 用户名（仅 ssh 模式） |
| `hosts[].host` | string | — | SSH 主机名/IP（仅 ssh 模式） |
| `hosts[].port` | number | `22` | SSH 端口（仅 ssh 模式） |
| `hosts[].identityFile` | string | — | SSH 密钥路径（仅 ssh 模式） |
| `hosts[].sshAlias` | string | — | SSH 配置别名（替代 user/host/port） |
| `server.port` | number | `3456` | HTTP/WebSocket 服务端口 |
| `server.pollIntervalMs` | number | `3000` | 更新检查间隔（毫秒） |

### 环境变量

```bash
CCM_PORT=3456              # 覆盖服务端口
CCM_CONFIG=./config.json   # 配置文件路径
CCM_POLL_INTERVAL=3000     # 轮询间隔（毫秒）
```

## 会话状态逻辑

| 状态 | 条件 |
|------|------|
| 🟢 **活跃** | 最后一条消息 < 60 秒前 |
| 🟡 **空闲** | 最后一条消息 1–10 分钟前 |
| ⚪ **完成** | 最后一条消息 > 10 分钟前，或会话有系统摘要 |
| 🔴 **错误** | 最后一条消息包含错误指示 |

## 使用技巧

### tmux 会话命名

为获得最佳体验，建议以项目名称命名 tmux 会话：

```bash
# 推荐 — 仪表盘显示有意义的名称
tmux new-session -s api-gateway -c ~/projects/api-gateway 'claude'
tmux new-session -s web-app -c ~/projects/web-app 'claude'

# 不推荐 — 仪表盘显示 "0"、"1"、"2"
tmux new-session 'claude'
```

### 使用 mosh 保持稳定连接

```bash
mosh gpu-box -- tmux attach -t api-gateway
```

### 使用 Git worktree 并行会话

```bash
git worktree add ../myapp-feat-auth feat/auth
git worktree add ../myapp-fix-bug fix/critical-bug
# 然后在每个目录中运行独立的 Claude Code 会话
```

## Hook 集成

你可以将 Claude Code 的 hook 事件（Stop、Notification、工具失败）转发到仪表盘，实现实时告警。将示例 hook 配置复制到 Claude Code 设置中：

```bash
cp hooks.example.json ~/.claude/settings.json
# 或合并到已有的 settings.json 中
```

事件会被 POST 到 `http://localhost:3456/api/hook`，并在仪表盘中以 toast 通知的形式显示。

## 通过 Gradio 隧道公开分享

将仪表盘通过公开 URL 暴露（适合与队友分享或在手机上查看）：

```bash
npm run share
# 或：uv run share.py
```

这使用 [Gradio 的 FRP 隧道](https://www.gradio.app/) 创建一个临时公开 URL，将流量转发到本地服务器。需要安装 `gradio`（`pip install gradio` 或使用 `uv run` 自动安装）。

## 项目结构

```
claude-code-monitor/
├── server/
│   ├── index.js           # Express + WebSocket 服务器
│   ├── watcher.js         # ~/.claude 文件系统监听器
│   ├── parser.js          # JSONL 会话解析器
│   ├── ssh-collector.js   # 通过 SSH 收集远程主机数据
│   ├── tmux-collector.js  # 通过 libtmux/CLI 获取 tmux 会话状态
│   └── aggregator.js      # 聚合所有主机的数据
├── client/
│   ├── src/
│   │   ├── App.jsx        # 仪表盘主界面
│   │   └── hooks/         # WebSocket hook
│   ├── index.html
│   └── vite.config.js
├── scripts/
│   └── quick-status.sh    # CLI 状态检查器（无需服务器）
├── share.py               # Gradio FRP 隧道，生成公开 URL
├── config.example.json
├── hooks.example.json     # Claude Code hook 配置，用于实时告警
├── package.json
└── README.md
```

## 相关工具

- [`ccusage`](https://github.com/ryoppippi/ccusage) — 按日期/会话/项目查看 Claude Code 用量的 CLI 工具
- [`claude-code-usage-monitor`](https://pypi.org/project/claude-code-usage-monitor/) — 基于 Python 的实时 token 追踪器
- [`claude-code-monitor`](https://github.com/onikan27/claude-code-monitor) — macOS 移动端 Web UI（不同项目，名称相似）
- [`claude-code-log`](https://github.com/daaain/claude-code-log) — 将 JSONL 记录转换为可读 HTML
- [`claude-code-transcripts`](https://github.com/simonw/claude-code-transcripts) — 发布会话记录

## 许可证

MIT
