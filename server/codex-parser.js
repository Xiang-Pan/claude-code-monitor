import fs from "fs";
import path from "path";
import readline from "readline";
import { inferStatus } from "./parser.js";

/**
 * Parse a single Codex rollout JSONL file and return structured session info.
 *
 * Codex JSONL schema:
 *  - First line: { type: "session_meta", meta: { id, cwd, cli_version }, git: { branch } }
 *  - Subsequent: { type: "event_msg", payload: { type: "UserMessage"|"AgentMessage"|... }, ts }
 *  - Token events: { type: "event_msg", payload: { type: "TokenCount", input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, model } }
 */
export async function parseCodexSessionFile(filepath) {
  const lines = [];
  const fileStream = fs.createReadStream(filepath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  if (lines.length === 0) return null;

  // Extract session ID from filename: rollout-<uuid>.jsonl → <uuid>
  const basename = path.basename(filepath, ".jsonl");
  const sessionId = basename.startsWith("rollout-")
    ? basename.slice("rollout-".length)
    : basename;

  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let lastUserMessage = "";
  let lastAssistantMessage = "";
  let hasError = false;
  let hasSummary = false;
  let model = null;
  let branch = null;
  let cwd = null;

  for (const entry of lines) {
    // Extract timestamp
    const ts = entry.ts || entry.timestamp;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    if (entry.type === "session_meta") {
      if (entry.meta?.cwd) cwd = entry.meta.cwd;
      if (entry.meta?.id && !sessionId) sessionId = entry.meta.id;
      if (entry.git?.branch) branch = entry.git.branch;
      continue;
    }

    if (entry.type === "event_msg" && entry.payload) {
      const p = entry.payload;

      switch (p.type) {
        case "UserMessage":
          userMessages++;
          if (typeof p.content === "string") {
            lastUserMessage = p.content;
          } else if (Array.isArray(p.content)) {
            for (const block of p.content) {
              if (block.type === "text" && block.text) {
                lastUserMessage = block.text;
              }
            }
          }
          break;

        case "AgentMessage":
          assistantMessages++;
          if (typeof p.content === "string") {
            lastAssistantMessage = p.content;
          } else if (Array.isArray(p.content)) {
            for (const block of p.content) {
              if (block.type === "text" && block.text) {
                lastAssistantMessage = block.text;
              }
            }
          }
          break;

        case "ExecCommandBegin":
        case "McpToolCallBegin":
        case "PatchApplyBegin":
          toolCalls++;
          break;

        case "TokenCount":
          totalInputTokens += p.input_tokens || 0;
          totalOutputTokens += p.output_tokens || 0;
          totalCacheRead += p.cached_input_tokens || 0;
          if (p.model) model = p.model;
          break;

        case "Error":
          hasError = true;
          break;

        case "ContextCompacted":
          hasSummary = true;
          break;
      }

      // Model from turn_context
      if (p.turn_context?.model && !model) {
        model = p.turn_context.model;
      }
    }
  }

  return {
    sessionId,
    isAgent: false,
    messages: userMessages + assistantMessages,
    userMessages,
    assistantMessages,
    toolCalls,
    tokens: {
      input: totalInputTokens,
      output: totalOutputTokens,
      cacheRead: totalCacheRead,
    },
    firstTimestamp,
    lastTimestamp,
    lastUserMessage: truncate(lastUserMessage, 200),
    lastAssistantMessage: truncate(lastAssistantMessage, 200),
    hasError,
    hasSummary,
    model,
    branch,
    cwd,
  };
}

/**
 * Scan a Codex directory (~/.codex) and return all recent sessions.
 *
 * Codex stores sessions at: ~/.codex/sessions/YYYY/MM/DD/rollout-<uuid>.jsonl
 */
export async function scanCodexDir(codexDir) {
  const sessionsDir = path.join(codexDir, "sessions");
  const sessions = [];

  // Walk the date-based directory tree: sessions/YYYY/MM/DD/
  let years;
  try {
    years = await fs.promises.readdir(sessionsDir);
  } catch {
    return sessions;
  }

  for (const year of years) {
    const yearPath = path.join(sessionsDir, year);
    const yearStat = await fs.promises.stat(yearPath).catch(() => null);
    if (!yearStat?.isDirectory()) continue;

    let months;
    try {
      months = await fs.promises.readdir(yearPath);
    } catch {
      continue;
    }

    for (const month of months) {
      const monthPath = path.join(yearPath, month);
      const monthStat = await fs.promises.stat(monthPath).catch(() => null);
      if (!monthStat?.isDirectory()) continue;

      let days;
      try {
        days = await fs.promises.readdir(monthPath);
      } catch {
        continue;
      }

      for (const day of days) {
        const dayPath = path.join(monthPath, day);
        const dayStat = await fs.promises.stat(dayPath).catch(() => null);
        if (!dayStat?.isDirectory()) continue;

        let files;
        try {
          files = await fs.promises.readdir(dayPath);
        } catch {
          continue;
        }

        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;

          const filepath = path.join(dayPath, file);
          const fileStat = await fs.promises.stat(filepath).catch(() => null);
          if (!fileStat) continue;

          // Skip files not modified in the last 24 hours
          const ageHours = (Date.now() - fileStat.mtimeMs) / 3_600_000;
          if (ageHours > 24) continue;

          const parsed = await parseCodexSessionFile(filepath);
          if (!parsed) continue;

          const effectiveName = parsed.cwd ? path.basename(parsed.cwd) : "unknown";

          sessions.push({
            ...parsed,
            status: inferStatus(parsed),
            project: {
              name: effectiveName,
              path: parsed.cwd || "",
              encoded: "",
            },
            summary: null,
            fileSize: fileStat.size,
            lastModified: fileStat.mtimeMs,
          });
        }
      }
    }
  }

  // Sort by last active (most recent first)
  sessions.sort((a, b) => {
    const aTime = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0;
    const bTime = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0;
    return bTime - aTime;
  });

  return sessions;
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}
