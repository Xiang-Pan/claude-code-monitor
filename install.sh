#!/usr/bin/env bash
# One-liner: curl -sL https://raw.githubusercontent.com/Xiang-Pan/claude-code-monitor/master/install.sh | bash
set -euo pipefail

REPO="https://github.com/Xiang-Pan/claude-code-monitor.git"
INSTALL_DIR="${CCM_DIR:-$HOME/.claude-code-monitor}"
PORT="${CCM_PORT:-3456}"
SERVER="${CCM_SERVER:-https://claude.xiangpan.org}"
TMUX_SESSION="ccm"

echo "⬡ Claude Code Monitor — Install & Start"
echo "─────────────────────────────────────────"

# 1. Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[1/4] Updating existing install at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || git -C "$INSTALL_DIR" fetch --all
else
  echo "[1/4] Cloning to $INSTALL_DIR..."
  git clone "$REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# 2. Install deps (prefer bun, fall back to npm)
echo "[2/4] Installing dependencies..."
if command -v bun &>/dev/null; then
  bun install --frozen-lockfile 2>/dev/null || bun install
elif command -v npm &>/dev/null; then
  npm install --production=false
else
  echo "Error: need bun or npm"; exit 1
fi

# 3. Build client
echo "[3/4] Building dashboard..."
if command -v bun &>/dev/null; then
  bun run build
else
  npx vite build --outDir dist 2>/dev/null || (cd client && npx vite build)
fi

# 4. Start in tmux
echo "[4/4] Starting in tmux session '$TMUX_SESSION'..."

# Kill existing session if any
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true

HOSTNAME=$(hostname)

tmux new-session -d -s "$TMUX_SESSION" -n server \
  "cd $INSTALL_DIR && node server/index.js; read"

tmux new-window -t "$TMUX_SESSION" -n agent \
  "cd $INSTALL_DIR && node agent/index.js --server $SERVER --name $HOSTNAME; read"

echo ""
echo "  ✓ Running in tmux session: $TMUX_SESSION"
echo "  ✓ Server:    $SERVER"
echo "  ✓ Attach:    tmux attach -t $TMUX_SESSION"
echo ""
echo "  Stop:   tmux kill-session -t $TMUX_SESSION"
echo "  Logs:   tmux attach -t $TMUX_SESSION"
echo ""
