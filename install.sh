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

# 0. Check required tools
if ! command -v git &>/dev/null; then
  echo "Error: git is required but not found."
  echo "  Install it with your package manager, e.g.:"
  echo "    apt install git   (Debian/Ubuntu)"
  echo "    yum install git   (RHEL/CentOS)"
  echo "    brew install git  (macOS)"
  exit 1
fi

if ! command -v tmux &>/dev/null; then
  echo "Error: tmux is required but not found."
  echo "  Install it with your package manager, e.g.:"
  echo "    apt install tmux   (Debian/Ubuntu)"
  echo "    yum install tmux   (RHEL/CentOS)"
  echo "    brew install tmux  (macOS)"
  exit 1
fi

if ! command -v curl &>/dev/null; then
  echo "Error: curl is required but not found."
  echo "  Install it with your package manager, e.g.:"
  echo "    apt install curl   (Debian/Ubuntu)"
  echo "    yum install curl   (RHEL/CentOS)"
  echo "    brew install curl  (macOS)"
  exit 1
fi

# Detect JS runtime: prefer bun, then node; auto-install bun if neither found
if command -v bun &>/dev/null; then
  RUNTIME="bun"
elif command -v node &>/dev/null; then
  RUNTIME="node"
else
  echo "  No JS runtime found. Installing bun..."
  curl -fsSL https://bun.sh/install | bash || true
  # Source bun into current session
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    echo "Error: bun installation failed."
    echo "  Try installing manually: https://bun.sh"
    exit 1
  fi
  RUNTIME="bun"
  echo "  ✓ bun installed"
fi

echo "  Runtime: $RUNTIME"

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
if [ "$RUNTIME" = "bun" ]; then
  bun install --frozen-lockfile 2>/dev/null || bun install
else
  if command -v npm &>/dev/null; then
    npm install
  elif command -v npx &>/dev/null; then
    npx --yes npm install
  elif command -v corepack &>/dev/null; then
    corepack enable && npm install
  else
    echo "Error: node found but no package manager (npm/npx/corepack)."
    echo "  Install Node.js 20+ with npm: https://nodejs.org"
    exit 1
  fi
fi

# 3. Start in tmux
echo "[3/3] Starting in tmux session '$TMUX_SESSION'..."
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "  Replacing existing session '$TMUX_SESSION'..."
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  sleep 0.5
fi

HOSTNAME=$(hostname -s 2>/dev/null || hostname)

# Build PATH export for tmux commands (ensures bun is available inside tmux)
TMUX_ENV=""
if [ "$RUNTIME" = "bun" ]; then
  TMUX_ENV="export PATH=\"${BUN_INSTALL:-$HOME/.bun}/bin:\$PATH\"; "
fi

if [ "$MODE" = "server" ]; then
  # Build client for dashboard
  echo "  Building dashboard..."
  if [ "$RUNTIME" = "bun" ]; then
    bun run build
  else
    npx --yes vite build 2>/dev/null || (cd client && npx --yes vite build)
  fi

  tmux new-session -d -s "$TMUX_SESSION" -n server \
    "${TMUX_ENV}cd \"$INSTALL_DIR\" && $RUNTIME server/index.js; read"
  tmux new-window -t "$TMUX_SESSION" -n agent \
    "${TMUX_ENV}cd \"$INSTALL_DIR\" && $RUNTIME agent/index.js --server \"http://localhost:$PORT\" --name \"$HOSTNAME\"; read"

  echo ""
  echo "  ✓ Dashboard: http://localhost:$PORT"
else
  # Agent-only: just push data to remote server
  tmux new-session -d -s "$TMUX_SESSION" -n agent \
    "${TMUX_ENV}cd \"$INSTALL_DIR\" && $RUNTIME agent/index.js --server \"$SERVER\" --name \"$HOSTNAME\"; read"

  echo ""
  echo "  ✓ Pushing to: $SERVER"
fi

echo "  ✓ tmux session: $TMUX_SESSION"
echo "  ✓ Attach:  tmux attach -t $TMUX_SESSION"
echo "  ✓ Stop:    tmux kill-session -t $TMUX_SESSION"
echo ""
