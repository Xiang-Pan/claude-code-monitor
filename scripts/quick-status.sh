#!/usr/bin/env bash
#
# quick-status.sh — Check Claude Code session status across hosts
# Usage: bash scripts/quick-status.sh [config.json]
#
# Works standalone without the Node.js server. Just needs bash + ssh + jq.

set -euo pipefail

CONFIG="${1:-config.json}"
if [ ! -f "$CONFIG" ] && [ -f "config.example.json" ]; then
  CONFIG="config.example.json"
fi

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}⬡${NC} ${BOLD}Claude Code Status${NC}"
echo -e "${DIM}─────────────────────────────────────────${NC}"
echo ""

# ── Check local sessions ─────────────────────────────────────
check_local() {
  local name="$1"
  local claude_dir="$2"

  # Expand ~
  claude_dir="${claude_dir/#\~/$HOME}"

  echo -e "${BOLD}▸ ${name}${NC} ${DIM}(local: ${claude_dir})${NC}"

  if [ ! -d "$claude_dir/projects" ]; then
    echo -e "  ${YELLOW}No projects directory found${NC}"
    echo ""
    return
  fi

  # Find recently modified JSONL files (last 60 min)
  local count=0
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    count=$((count + 1))

    local project_dir
    project_dir=$(basename "$(dirname "$file")")
    local project_name
    project_name=$(echo "$project_dir" | rev | cut -d'-' -f1 | rev)
    local session_file
    session_file=$(basename "$file" .jsonl)
    local lines
    lines=$(wc -l < "$file" 2>/dev/null || echo 0)
    local mtime_epoch
    mtime_epoch=$(stat -c%Y "$file" 2>/dev/null || stat -f%m "$file" 2>/dev/null || echo 0)
    local now_epoch
    now_epoch=$(date +%s)
    local age_sec=$(( now_epoch - mtime_epoch ))

    # Determine status
    local status status_color
    if [ "$age_sec" -lt 60 ]; then
      status="ACTIVE"
      status_color="$GREEN"
    elif [ "$age_sec" -lt 600 ]; then
      status="IDLE"
      status_color="$YELLOW"
    else
      status="DONE"
      status_color="$DIM"
    fi

    # Format age
    local age_str
    if [ "$age_sec" -lt 60 ]; then
      age_str="${age_sec}s ago"
    elif [ "$age_sec" -lt 3600 ]; then
      age_str="$(( age_sec / 60 ))m ago"
    else
      age_str="$(( age_sec / 3600 ))h ago"
    fi

    # Get last line for model info
    local model=""
    local last_line
    last_line=$(tail -1 "$file" 2>/dev/null || echo "")
    if command -v jq &>/dev/null && [ -n "$last_line" ]; then
      model=$(echo "$last_line" | jq -r '.model // empty' 2>/dev/null || echo "")
    fi

    local is_agent=""
    if [[ "$session_file" == agent-* ]]; then
      is_agent=" ${DIM}(sub-agent)${NC}"
    fi

    echo -e "  ${status_color}●${NC} ${BOLD}${project_name}${NC}${is_agent}  ${status_color}${status}${NC}  ${DIM}${lines} lines · ${age_str}${NC}${model:+ · ${DIM}${model}${NC}}"

  done < <(find "$claude_dir/projects" -name "*.jsonl" -mmin -60 -type f 2>/dev/null | sort -t/ -k6 || true)

  if [ "$count" -eq 0 ]; then
    echo -e "  ${DIM}No active sessions (last 60 min)${NC}"
  fi

  # Stats cache summary
  if [ -f "$claude_dir/stats-cache.json" ] && command -v jq &>/dev/null; then
    local today_msgs today_sessions
    today_msgs=$(jq -r '.dailyActivity[-1].messageCount // 0' "$claude_dir/stats-cache.json" 2>/dev/null || echo 0)
    today_sessions=$(jq -r '.dailyActivity[-1].sessionCount // 0' "$claude_dir/stats-cache.json" 2>/dev/null || echo 0)
    echo -e "  ${DIM}Today: ${today_msgs} messages across ${today_sessions} sessions${NC}"
  fi

  echo ""
}

# ── Check remote sessions via SSH ────────────────────────────
check_ssh() {
  local name="$1"
  local user="$2"
  local host="$3"
  local port="${4:-22}"
  local claude_dir="${5:-~/.claude}"
  local identity_file="${6:-}"

  echo -e "${BOLD}▸ ${name}${NC} ${DIM}(ssh: ${user}@${host})${NC}"

  local ssh_args=(-o "StrictHostKeyChecking=accept-new" -o "ConnectTimeout=5" -o "BatchMode=yes" -p "$port")
  [ -n "$identity_file" ] && ssh_args+=(-i "$identity_file")

  local output
  if ! output=$(ssh "${ssh_args[@]}" "${user}@${host}" "
    find ${claude_dir}/projects -name '*.jsonl' -mmin -60 -type f 2>/dev/null | while read f; do
      project_dir=\$(basename \"\$(dirname \"\$f\")\")
      project_name=\$(echo \"\$project_dir\" | rev | cut -d'-' -f1 | rev)
      lines=\$(wc -l < \"\$f\" 2>/dev/null || echo 0)
      mtime=\$(stat -c%Y \"\$f\" 2>/dev/null || stat -f%m \"\$f\" 2>/dev/null || echo 0)
      age=\$(( \$(date +%s) - mtime ))
      is_agent=''
      [[ \"\$(basename \$f .jsonl)\" == agent-* ]] && is_agent=' (agent)'
      if [ \$age -lt 60 ]; then
        echo \"ACTIVE|\$project_name|\$lines|\${age}s\$is_agent\"
      elif [ \$age -lt 600 ]; then
        echo \"IDLE|\$project_name|\$lines|\$(( age / 60 ))m\$is_agent\"
      else
        echo \"DONE|\$project_name|\$lines|\$(( age / 3600 ))h\$is_agent\"
      fi
    done
  " 2>/dev/null); then
    echo -e "  ${RED}● Connection failed${NC}"
    echo ""
    return
  fi

  if [ -z "$output" ]; then
    echo -e "  ${DIM}No active sessions (last 60 min)${NC}"
  else
    while IFS='|' read -r status project lines age; do
      local color="$DIM"
      [ "$status" = "ACTIVE" ] && color="$GREEN"
      [ "$status" = "IDLE" ] && color="$YELLOW"
      echo -e "  ${color}●${NC} ${BOLD}${project}${NC}  ${color}${status}${NC}  ${DIM}${lines} lines · ${age} ago${NC}"
    done <<< "$output"
  fi
  echo ""
}

# ── Parse config and check each host ────────────────────────
if [ -f "$CONFIG" ] && command -v jq &>/dev/null; then
  host_count=$(jq '.hosts | length' "$CONFIG")
  for i in $(seq 0 $(( host_count - 1 ))); do
    mode=$(jq -r ".hosts[$i].mode // \"local\"" "$CONFIG")
    name=$(jq -r ".hosts[$i].name" "$CONFIG")
    claude_dir=$(jq -r ".hosts[$i].claudeDir // \"~/.claude\"" "$CONFIG")

    if [ "$mode" = "ssh" ]; then
      user=$(jq -r ".hosts[$i].user" "$CONFIG")
      host=$(jq -r ".hosts[$i].host" "$CONFIG")
      port=$(jq -r ".hosts[$i].port // 22" "$CONFIG")
      identity=$(jq -r ".hosts[$i].identityFile // \"\"" "$CONFIG")
      check_ssh "$name" "$user" "$host" "$port" "$claude_dir" "$identity"
    else
      check_local "$name" "$claude_dir"
    fi
  done
else
  # No config or no jq — just check local
  check_local "local" "~/.claude"
fi

echo -e "${DIM}─────────────────────────────────────────${NC}"
echo -e "${DIM}$(date '+%Y-%m-%d %H:%M:%S')${NC}"
