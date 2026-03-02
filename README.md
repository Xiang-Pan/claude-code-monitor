# ⬡ Claude Code Monitor

[English](README.md) | [中文](README_CN.md)

A real-time dashboard for monitoring multiple Claude Code sessions across SSH hosts. Watch all your sessions at a glance — token usage, status, files changed, and more — without tab-hopping through terminals.

<!-- TODO: add a screenshot to docs/preview.png -->
<!-- ![Dashboard Preview](docs/preview.png) -->

## Why?

If you run Claude Code across multiple remote machines (via SSH + tmux), keeping track of what's happening where becomes painful fast. This tool:

- **Watches `~/.claude/`** on each host for live session data
- **Aggregates** sessions from multiple SSH hosts into one dashboard
- **Streams updates** via WebSocket — no polling, no refresh
- **Shows everything**: status, tokens, model, branch, files changed, sub-agents
- **One-click SSH**: expand any session to see the exact `tmux attach` command

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  SSH Host 1  │     │  SSH Host 2  │     │  SSH Host 3  │
│  ~/.claude/  │     │  ~/.claude/  │     │  ~/.claude/  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │ ssh/sshfs          │                     │
       └────────────┬───────┴─────────────────────┘
                    │
          ┌─────────▼─────────┐
          │   Monitor Server  │
          │  (Node.js + WS)   │
          │   - watches dirs  │
          │   - parses JSONL  │
          │   - aggregates    │
          └─────────┬─────────┘
                    │ WebSocket
          ┌─────────▼─────────┐
          │  React Dashboard  │
          │  (Vite + React)   │
          └───────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- SSH access to your remote hosts (key-based auth recommended)
- Claude Code running in tmux sessions on remote hosts

### 1. Clone & Install

```bash
git clone https://github.com/Xiang-Pan/claude-code-monitor.git
cd claude-code-monitor
npm install
```

### 2. Configure Hosts

Copy the example config and edit it:

```bash
cp config.example.json config.json
```

```jsonc
{
  "hosts": [
    {
      "name": "dev-server-1",
      "mode": "local",           // "local" or "ssh"
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

**Mode options:**
- `local` — Watch `~/.claude` on the machine running the monitor (simplest)
- `ssh` — Poll remote hosts via SSH (works through firewalls, no extra setup on remote)

### 3. Run

```bash
# Development (hot reload on both server + client)
npm run dev

# Production
npm run build
npm start
```

Open **http://localhost:3456** in your browser.

### One-liner for local-only monitoring

If you just want to monitor Claude Code on the current machine:

```bash
npx claude-code-monitor
```

### Connect a remote machine to an existing server

To push session data from a remote machine to your central dashboard:

```bash
git clone https://github.com/Xiang-Pan/claude-code-monitor.git /tmp/ccm && cd /tmp/ccm && npm install && node agent/index.js --server http://YOUR_SERVER:3456 --name $(hostname)
```

## How It Works

### Data Source: `~/.claude/`

Claude Code stores all session data locally:

```
~/.claude/
├── projects/                        # Session transcripts per project
│   └── -home-user-projects-myapp/   # Encoded path (/ → -)
│       ├── {session-uuid}.jsonl     # Full conversation history
│       ├── agent-{id}.jsonl         # Sub-agent transcripts
│       └── sessions-index.json      # Session metadata index
├── stats-cache.json                 # Aggregated usage statistics
├── history.jsonl                    # Global prompt history
├── todos/{sessionId}.json           # Task lists per session
└── file-history/{sessionId}/        # File checkpoints
```

Each `.jsonl` file contains one JSON event per line:

```json
{"type":"user","message":{"role":"user","content":"Fix the auth bug"},"timestamp":"2025-06-02T18:46:59.937Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll look into..."}]},"timestamp":"2025-06-02T18:47:06.267Z"}
```

The monitor parses these to extract:
- Session status (active/idle/completed) based on recency of last message
- Message and tool call counts
- Token usage from assistant message metadata
- Git branch and working directory from session metadata
- Sub-agent activity from `agent-*.jsonl` files

### Remote Monitoring via SSH

For remote hosts, the server periodically runs:

```bash
ssh user@host 'cat ~/.claude/stats-cache.json && \
  find ~/.claude/projects -name "*.jsonl" -mmin -60 -exec tail -1 {} \;'
```

This is lightweight — only reads recently-modified files and pulls the last line to check status. No persistent connection or daemon needed on the remote host.

### Alternative: sshfs Mount

For lower latency, you can mount remote `~/.claude` directories:

```bash
# Mount remote claude dirs
sshfs user@gpu-box:.claude /mnt/claude-gpu-box
sshfs user@dev-server:.claude /mnt/claude-dev-server

# Then configure as "local" mode pointing to mount
{
  "name": "gpu-box",
  "mode": "local",
  "claudeDir": "/mnt/claude-gpu-box"
}
```

## Configuration

### `config.json`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hosts` | array | required | List of host configurations |
| `hosts[].name` | string | required | Display name for the host |
| `hosts[].mode` | string | `"local"` | `"local"` or `"ssh"` |
| `hosts[].claudeDir` | string | `"~/.claude"` | Path to .claude directory |
| `hosts[].user` | string | — | SSH username (ssh mode only) |
| `hosts[].host` | string | — | SSH hostname/IP (ssh mode only) |
| `hosts[].port` | number | `22` | SSH port (ssh mode only) |
| `hosts[].identityFile` | string | — | SSH key path (ssh mode only) |
| `hosts[].sshAlias` | string | — | SSH config alias (used instead of user/host/port) |
| `server.port` | number | `3456` | HTTP/WebSocket server port |
| `server.pollIntervalMs` | number | `3000` | How often to check for updates |

### Environment Variables

```bash
CCM_PORT=3456              # Override server port
CCM_CONFIG=./config.json   # Config file path
CCM_POLL_INTERVAL=3000     # Poll interval in ms
```

## Session Status Logic

| Status | Condition |
|--------|-----------|
| 🟢 **Active** | Last message < 60s ago |
| 🟡 **Idle** | Last message 1–10 min ago |
| ⚪ **Done** | Last message > 10 min ago, or session has system summary |
| 🔴 **Error** | Last message contains error indicators |

## Tips

### tmux session naming

For the best experience, name your tmux sessions after the project:

```bash
# Good — dashboard shows meaningful names
tmux new-session -s api-gateway -c ~/projects/api-gateway 'claude'
tmux new-session -s web-app -c ~/projects/web-app 'claude'

# Meh — dashboard shows "0", "1", "2"
tmux new-session 'claude'
```

### Resilient connections with mosh

```bash
mosh gpu-box -- tmux attach -t api-gateway
```

### Git worktrees for parallel sessions

```bash
git worktree add ../myapp-feat-auth feat/auth
git worktree add ../myapp-fix-bug fix/critical-bug
# Now run separate Claude Code sessions in each directory
```

## Hook Integration

You can forward Claude Code hook events (Stop, Notification, tool failures) to the dashboard for real-time alerts. Copy the example hook config into your Claude Code settings:

```bash
cp hooks.example.json ~/.claude/settings.json
# or merge it into your existing settings.json
```

Events are POSTed to `http://localhost:3456/api/hook` and displayed as toast notifications in the dashboard.

## Public Sharing via Gradio Tunnel

Expose your dashboard with a public URL (useful for sharing with teammates or viewing on mobile):

```bash
npm run share
# or: uv run share.py
```

This uses [Gradio's FRP tunnel](https://www.gradio.app/) to create a temporary public URL that tunnels to your local server. Requires `gradio` (`pip install gradio` or use `uv run` which auto-installs).

## Project Structure

```
claude-code-monitor/
├── server/
│   ├── index.js           # Express + WebSocket server
│   ├── watcher.js         # File system watcher for ~/.claude
│   ├── parser.js          # JSONL session parser
│   ├── ssh-collector.js   # Remote host data collection via SSH
│   ├── tmux-collector.js  # tmux session status via libtmux/CLI
│   └── aggregator.js      # Merges data from all hosts
├── client/
│   ├── src/
│   │   ├── App.jsx        # Main dashboard UI
│   │   └── hooks/         # WebSocket hook
│   ├── index.html
│   └── vite.config.js
├── scripts/
│   └── quick-status.sh    # CLI status checker (no server needed)
├── share.py               # Gradio FRP tunnel for public URL
├── config.example.json
├── hooks.example.json     # Claude Code hook config for live alerts
├── package.json
└── README.md
```

## Related Tools

- [`ccusage`](https://github.com/ryoppippi/ccusage) — CLI tool for viewing Claude Code usage by date/session/project
- [`claude-code-usage-monitor`](https://pypi.org/project/claude-code-usage-monitor/) — Python-based real-time token tracker
- [`claude-code-monitor`](https://github.com/onikan27/claude-code-monitor) — Mobile web UI for macOS (different project, similar name)
- [`claude-code-log`](https://github.com/daaain/claude-code-log) — Convert JSONL transcripts to readable HTML
- [`claude-code-transcripts`](https://github.com/simonw/claude-code-transcripts) — Publish session transcripts

## License

MIT
