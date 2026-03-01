import { spawn } from "child_process";
import { ACTIVE_THRESHOLD_MS, IDLE_THRESHOLD_MS } from "./constants.js";

/**
 * Collect session data from a remote host via SSH.
 */
export async function collectFromSSH(hostConfig) {
  const { user, host, port = 22, claudeDir = "~/.claude", identityFile, sshAlias } = hostConfig;

  const sshArgs = [
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
  ];

  if (sshAlias) {
    sshArgs.push(sshAlias);
  } else {
    sshArgs.push("-o", "StrictHostKeyChecking=accept-new");
    if (port !== 22) sshArgs.push("-p", String(port));
    if (identityFile) sshArgs.push("-i", identityFile);
    sshArgs.push(`${user}@${host}`);
  }

  sshArgs.push("python3", "-");

  // Use a Python script for reliable JSON output and richer data extraction
  const remoteScript = `
import json, os, glob, subprocess, time

CLAUDE_DIR = os.path.expanduser("${claudeDir}")
PROJECTS_DIR = os.path.join(CLAUDE_DIR, "projects")

# Get cwds of running Claude processes on this host
local_cwds = set()
try:
    pids = subprocess.check_output(["pgrep", "-x", "claude"], text=True).strip().split("\\n")
    for pid in pids:
        try:
            cwd = os.readlink(f"/proc/{pid}/cwd")
            local_cwds.add(cwd)
        except: pass
except: pass

# Stats cache
stats = None
stats_path = os.path.join(CLAUDE_DIR, "stats-cache.json")
if os.path.isfile(stats_path):
    try:
        with open(stats_path) as f:
            stats = json.load(f)
    except: pass

# Find recent JSONL files (modified in last 60 min), skip subagents
cutoff = time.time() - 3600
sessions = []

if os.path.isdir(PROJECTS_DIR):
    for proj in os.listdir(PROJECTS_DIR):
        proj_path = os.path.join(PROJECTS_DIR, proj)
        if not os.path.isdir(proj_path):
            continue
        for fname in os.listdir(proj_path):
            if not fname.endswith(".jsonl"):
                continue
            fpath = os.path.join(proj_path, fname)
            try:
                st = os.stat(fpath)
            except: continue
            if st.st_mtime < cutoff:
                continue

            # Parse the JSONL for rich data
            session_id = fname.replace(".jsonl", "")
            cwd = ""
            git_branch = ""
            version = ""
            first_ts = ""
            last_ts = ""
            last_user_msg = ""
            last_assistant_msg = ""
            model = ""
            user_msgs = 0
            assistant_msgs = 0
            tool_calls = 0
            tokens_in = 0
            tokens_out = 0
            tokens_cache = 0
            has_error = False
            total_lines = 0

            try:
                with open(fpath, "r") as f:
                    for line in f:
                        total_lines += 1
                        try:
                            d = json.loads(line)
                        except:
                            continue

                        ts = d.get("timestamp", "")
                        if ts and not first_ts:
                            first_ts = ts
                        if ts:
                            last_ts = ts

                        if not cwd and d.get("cwd"):
                            cwd = d["cwd"]
                        if not git_branch and d.get("gitBranch"):
                            git_branch = d["gitBranch"]
                        if not version and d.get("version"):
                            version = d["version"]

                        msg_type = d.get("type", "")

                        if msg_type == "user":
                            tr = d.get("toolUseResult")
                            if tr is None:
                                user_msgs += 1
                                content = d.get("message", {}).get("content", "")
                                if isinstance(content, str) and content:
                                    last_user_msg = content[:300]
                                elif isinstance(content, list):
                                    for b in content:
                                        if isinstance(b, dict) and b.get("type") == "text":
                                            last_user_msg = b.get("text", "")[:300]
                                            break

                        elif msg_type == "assistant":
                            assistant_msgs += 1
                            msg = d.get("message", {})
                            if msg.get("model"):
                                model = msg["model"]
                            usage = msg.get("usage", {})
                            if usage:
                                tokens_in += usage.get("input_tokens", 0)
                                tokens_out += usage.get("output_tokens", 0)
                                tokens_cache += usage.get("cache_read_input_tokens", 0)
                            content = msg.get("content", [])
                            if isinstance(content, list):
                                for b in content:
                                    if isinstance(b, dict):
                                        if b.get("type") == "text" and b.get("text", "").strip():
                                            last_assistant_msg = b["text"][:300]
                                        if b.get("type") == "tool_use":
                                            tool_calls += 1

                        if msg_type == "error" or d.get("error"):
                            has_error = True

            except Exception as e:
                pass

            # Only filter by running processes if we found any
            # When no Claude process is running, show all recent sessions
            if local_cwds and cwd and cwd not in local_cwds:
                continue

            sessions.append({
                "sessionId": session_id,
                "projectDir": proj,
                "cwd": cwd,
                "gitBranch": git_branch,
                "version": version,
                "model": model,
                "firstTimestamp": first_ts,
                "lastTimestamp": last_ts,
                "lastUserMessage": last_user_msg,
                "lastAssistantMessage": last_assistant_msg,
                "userMessages": user_msgs,
                "assistantMessages": assistant_msgs,
                "messages": user_msgs + assistant_msgs,
                "totalLines": total_lines,
                "toolCalls": tool_calls,
                "tokens": {"input": tokens_in, "output": tokens_out, "cacheRead": tokens_cache},
                "hasError": has_error,
                "fileSize": st.st_size,
                "mtime": int(st.st_mtime),
            })

print(json.dumps({"statsCache": stats, "sessions": sessions}))
`;

  return new Promise((resolve) => {
    const proc = spawn("ssh", sshArgs, {
      timeout: 45_000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdin.write(remoteScript);
    proc.stdin.end();

    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({
        host: hostConfig.name,
        status: "error",
        error: "SSH timeout after 45s",
        sessions: [],
        statsCache: null,
        collectedAt: Date.now(),
      });
    }, 45_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        resolve({
          host: hostConfig.name,
          status: "error",
          error: stderr.trim() || `SSH exited with code ${code}`,
          sessions: [],
          statsCache: null,
          collectedAt: Date.now(),
        });
        return;
      }

      try {
        const data = JSON.parse(stdout);
        resolve({
          host: hostConfig.name,
          status: "connected",
          ...data,
          collectedAt: Date.now(),
        });
      } catch (err) {
        resolve({
          host: hostConfig.name,
          status: "error",
          error: `JSON parse error: ${err.message}\nRaw: ${stdout.slice(0, 500)}`,
          sessions: [],
          statsCache: null,
          collectedAt: Date.now(),
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        host: hostConfig.name,
        status: "error",
        error: err.message,
        sessions: [],
        statsCache: null,
        collectedAt: Date.now(),
      });
    });
  });
}

/**
 * Parse remote sessions — now the Python script does the heavy lifting,
 * so this is mostly just adding status inference and project name.
 */
export function parseRemoteSessions(remoteData) {
  if (!remoteData.sessions) return [];

  return remoteData.sessions.map((s) => {
    const realPath = s.cwd || "";
    const projectName = realPath
      ? realPath.split("/").filter(Boolean).pop()
      : s.projectDir.replace(/^-/, "").split("-").pop();

    // Infer status
    const effectiveLastActive = s.lastTimestamp
      ? new Date(s.lastTimestamp).getTime()
      : s.mtime * 1000;
    const ageMs = Date.now() - effectiveLastActive;

    let status = "completed";
    if (s.hasError) status = "error";
    else if (ageMs < ACTIVE_THRESHOLD_MS) status = "active";
    else if (ageMs < IDLE_THRESHOLD_MS) status = "idle";

    return {
      sessionId: s.sessionId,
      isAgent: s.sessionId.startsWith("agent-"),
      status,
      project: {
        name: projectName,
        path: realPath || s.projectDir.replace(/^-/, "/").replace(/-/g, "/"),
        encoded: s.projectDir,
      },
      messages: s.messages,
      userMessages: s.userMessages,
      assistantMessages: s.assistantMessages,
      toolCalls: s.toolCalls,
      tokens: s.tokens,
      firstTimestamp: s.firstTimestamp || null,
      lastTimestamp: s.lastTimestamp || new Date(s.mtime * 1000).toISOString(),
      lastUserMessage: s.lastUserMessage || "",
      lastAssistantMessage: s.lastAssistantMessage || "",
      model: s.model || null,
      branch: s.gitBranch || null,
      version: s.version || null,
      hasError: s.hasError,
      fileSize: s.fileSize,
      lastModified: s.mtime * 1000,
    };
  });
}
