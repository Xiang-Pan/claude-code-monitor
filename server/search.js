import { spawn } from "child_process";
import path from "path";
import os from "os";

/**
 * Run ripgrep search across Claude Code JSONL transcripts.
 * Returns results grouped by session, sorted by match count.
 */
export async function searchTranscripts(query, { claudeDir, limit = 50, timeoutMs = 5000 } = {}) {
  const searchDir = path.join(claudeDir, "projects");
  const results = await runRipgrep(query, searchDir, { timeoutMs, limit });
  return results;
}

/**
 * Run ripgrep on a remote host via SSH.
 */
export async function searchTranscriptsSSH(query, hostConfig, { limit = 50, timeoutMs = 8000 } = {}) {
  const { user, host, port = 22, claudeDir = "~/.claude", identityFile, sshAlias } = hostConfig;

  const rgCmd = `rg --json -i --max-count 10 -e ${shellEscape(query)} ${claudeDir}/projects/ 2>/dev/null || true`;

  const sshArgs = [
    "-o", "ConnectTimeout=5",
    "-o", "BatchMode=yes",
  ];

  // Use ControlMaster pool if available
  sshArgs.push("-o", "ControlPath=/tmp/ccm-ssh-%C");

  if (sshAlias) {
    sshArgs.push(sshAlias);
  } else {
    sshArgs.push("-o", "StrictHostKeyChecking=accept-new");
    if (port !== 22) sshArgs.push("-p", String(port));
    if (identityFile) sshArgs.push("-i", identityFile);
    sshArgs.push(`${user}@${host}`);
  }

  sshArgs.push(rgCmd);

  return new Promise((resolve) => {
    const proc = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      // Safety: stop collecting if output is too large
      if (stdout.length > 5 * 1024 * 1024) {
        killed = true;
        proc.kill("SIGTERM");
      }
    });

    proc.on("close", () => {
      clearTimeout(timer);
      if (killed && !stdout) {
        resolve({ sessions: [], total: 0 });
        return;
      }
      try {
        const parsed = parseRipgrepJson(stdout, query, limit);
        resolve(parsed);
      } catch {
        resolve({ sessions: [], total: 0 });
      }
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ sessions: [], total: 0 });
    });
  });
}

/**
 * Run local ripgrep and parse results.
 */
function runRipgrep(query, searchDir, { timeoutMs, limit }) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn("rg", [
        "--json",
        "-i",
        "--max-count", "10",
        "--glob", "*.jsonl",
        "-e", query,
        searchDir,
      ], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ sessions: [], total: 0 });
      return;
    }

    let stdout = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 5 * 1024 * 1024) {
        killed = true;
        proc.kill("SIGTERM");
      }
    });

    proc.on("close", () => {
      clearTimeout(timer);
      if (killed && !stdout) {
        resolve({ sessions: [], total: 0 });
        return;
      }
      try {
        const parsed = parseRipgrepJson(stdout, query, limit);
        resolve(parsed);
      } catch {
        resolve({ sessions: [], total: 0 });
      }
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ sessions: [], total: 0 });
    });
  });
}

/**
 * Parse ripgrep JSON output into grouped session results.
 */
function parseRipgrepJson(output, query, limit) {
  const lines = output.split("\n").filter(Boolean);
  // Map: filePath -> { matches: [...] }
  const fileMap = new Map();

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type !== "match") continue;

    const filePath = obj.data?.path?.text;
    const lineText = obj.data?.lines?.text;
    if (!filePath || !lineText) continue;

    if (!fileMap.has(filePath)) {
      fileMap.set(filePath, { matches: [] });
    }

    const entry = fileMap.get(filePath);
    if (entry.matches.length >= 3) continue; // max 3 snippets per session

    // Try to extract meaningful text from the JSONL line
    const extracted = extractMessageText(lineText, query);
    if (extracted) {
      entry.matches.push(extracted);
    }
  }

  // Convert to session results
  const sessions = [];
  for (const [filePath, data] of fileMap) {
    if (data.matches.length === 0) continue;

    const { sessionId, project } = parseFilePath(filePath);
    sessions.push({
      sessionId,
      project,
      host: null, // will be filled by caller
      matchCount: data.matches.length,
      matches: data.matches,
    });
  }

  // Sort by match count descending
  sessions.sort((a, b) => b.matchCount - a.matchCount);

  const total = sessions.length;
  return {
    sessions: sessions.slice(0, limit),
    total,
  };
}

/**
 * Extract human-readable message text from a JSONL line.
 */
function extractMessageText(lineText, query) {
  let parsed;
  try {
    parsed = JSON.parse(lineText.trim());
  } catch {
    // Not valid JSON, use raw text
    const snippet = lineText.trim().slice(0, 300);
    return {
      text: snippet,
      context: "raw",
      timestamp: null,
    };
  }

  // Claude Code JSONL format: each line is a message object
  let text = "";
  let context = "message";
  let timestamp = parsed.timestamp || null;

  // Handle different message formats
  if (parsed.type === "human" || parsed.role === "user") {
    context = "user";
    text = extractContent(parsed.message?.content || parsed.content);
  } else if (parsed.type === "assistant" || parsed.role === "assistant") {
    context = "assistant";
    text = extractContent(parsed.message?.content || parsed.content);
  } else if (parsed.type === "system") {
    context = "system";
    text = extractContent(parsed.message?.content || parsed.content);
  } else {
    // Fallback: try to get any text content
    text = extractContent(parsed.message?.content || parsed.content || parsed.text);
    if (!text) {
      // Last resort: stringify and search
      const str = JSON.stringify(parsed).slice(0, 500);
      if (str.toLowerCase().includes(query.toLowerCase())) {
        text = str.slice(0, 300);
        context = "raw";
      }
    }
  }

  if (!text) return null;

  // Trim to reasonable length, centered on the query match
  const trimmed = trimAroundQuery(text, query, 200);

  return {
    text: trimmed,
    context,
    timestamp,
  };
}

/**
 * Extract text content from Claude message content (can be string or array of blocks).
 */
function extractContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block.type === "text") return block.text || "";
        if (block.type === "tool_use") return `[tool: ${block.name || "unknown"}]`;
        if (block.type === "tool_result") {
          if (typeof block.content === "string") return block.content;
          if (Array.isArray(block.content)) {
            return block.content.map(b => b.text || "").join(" ");
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

/**
 * Trim text to `maxLen` chars, centered around the first occurrence of query.
 */
function trimAroundQuery(text, query, maxLen) {
  if (text.length <= maxLen) return text;

  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen) + "...";

  const start = Math.max(0, idx - Math.floor(maxLen / 2));
  const end = Math.min(text.length, start + maxLen);
  let result = text.slice(start, end);
  if (start > 0) result = "..." + result;
  if (end < text.length) result = result + "...";
  return result;
}

/**
 * Parse file path to extract session ID and project name.
 * Paths look like: ~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
 */
function parseFilePath(filePath) {
  const parts = filePath.split(path.sep);
  const fileName = parts[parts.length - 1] || "";
  const sessionId = fileName.replace(".jsonl", "");

  // Project is the directory name (which is the encoded project path)
  let project = parts[parts.length - 2] || "unknown";

  // Try to make the project name more readable
  // The encoded path typically uses hyphens or URL encoding
  if (project.includes("-")) {
    // Take the last meaningful segment
    const segments = project.split("-").filter(Boolean);
    if (segments.length > 0) {
      project = segments[segments.length - 1] || project;
    }
  }

  return { sessionId, project };
}

/**
 * Shell-escape a string for use in SSH commands.
 */
function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
