#!/usr/bin/env bash
# One-liner: curl -sL https://raw.githubusercontent.com/Xiang-Pan/claude-code-monitor/master/install.sh | bash
#
# Env vars:
#   CCM_SERVER  — server URL (default: https://claude.xiangpan.org)
#   CCM_MODE    — "agent" (default, just push data) or "server" (run dashboard + agent)
#   CCM_DIR     — install directory (default: ~/.claude-code-monitor)
#   CCM_PORT    — server port when mode=server (default: 3456)
set -euo pipefail

REPO="https://github.com/Xiang-Pan/claude-code-monitor.git"
INSTALL_DIR="${CCM_DIR:-$HOME/.claude-code-monitor}"
PORT="${CCM_PORT:-3456}"
SERVER="${CCM_SERVER:-http://localhost:3456}"
MODE="${CCM_MODE:-agent}"
TMUX_SESSION="ccm"

echo "⬡ Claude Code Monitor — Install & Start"
echo "─────────────────────────────────────────"
echo "  Mode: $MODE"

# 1. Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[1/3] Updating existing install at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || true
else
  echo "[1/3] Cloning to $INSTALL_DIR..."
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# 2. Install deps
echo "[2/3] Installing dependencies..."
if command -v bun &>/dev/null; then
  bun install --frozen-lockfile 2>/dev/null || bun install
elif command -v npm &>/dev/null; then
  npm install
elif command -v node &>/dev/null; then
  # Node exists but no package manager — install deps manually via npx or corepack
  if command -v npx &>/dev/null; then
    npx --yes npm install
  elif command -v corepack &>/dev/null; then
    corepack enable && npm install
  else
    echo "Warning: no npm/bun/npx found. Trying node directly..."
    echo "  If this fails, install Node.js 20+ with npm: https://nodejs.org"
    exit 1
  fi
else
  echo "Error: node is required. Install Node.js 20+: https://nodejs.org"
  exit 1
fi

# 3. Start in tmux
echo "[3/3] Starting in tmux session '$TMUX_SESSION'..."
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

HOSTNAME=$(hostname -s 2>/dev/null || hostname)

if [ "$MODE" = "server" ]; then
  # Build client for dashboard
  echo "  Building dashboard..."
  if command -v bun &>/dev/null; then
    bun run build
  else
    npx --yes vite build 2>/dev/null || (cd client && npx --yes vite build)
  fi

  tmux new-session -d -s "$TMUX_SESSION" -n server \
    "cd $INSTALL_DIR && node server/index.js; read"
  tmux new-window -t "$TMUX_SESSION" -n agent \
    "cd $INSTALL_DIR && node agent/index.js --server http://localhost:$PORT --name $HOSTNAME; read"

  echo ""
  echo "  ✓ Dashboard: http://localhost:$PORT"
else
  # Agent-only: just push data to remote server
  tmux new-session -d -s "$TMUX_SESSION" -n agent \
    "cd $INSTALL_DIR && node agent/index.js --server $SERVER --name $HOSTNAME; read"

  echo ""
  echo "  ✓ Pushing to: $SERVER"
fi

echo "  ✓ tmux session: $TMUX_SESSION"
echo "  ✓ Attach:  tmux attach -t $TMUX_SESSION"
echo "  ✓ Stop:    tmux kill-session -t $TMUX_SESSION"
echo ""
