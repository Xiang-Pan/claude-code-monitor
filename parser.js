import fs from "fs";
import path from "path";
import readline from "readline";

/**
 * Decode a Claude Code project directory name back to a filesystem path.
 * Claude encodes `/home/user/project` as `-home-user-project`.
 */
export function decodeProjectPath(encoded) {
  // Leading dash represents the root `/`
  return encoded.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Extract the short project name from an encoded path.
 * e.g., `-home-user-projects-api-gateway` → `api-gateway`
 */
export function extractProjectName(encoded) {
  const decoded = decodeProjectPath(encoded);
  return path.basename(decoded);
}

/**
 * Parse a single JSONL session file and return structured session info.
 */
export async function parseSessionFile(filepath) {
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

  const sessionId = path.basename(filepath, ".jsonl");
  const isAgent = sessionId.startsWith("agent-");

  // Count message types
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

  for (const entry of lines) {
    const ts = entry.timestamp || entry.ts;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    switch (entry.type) {
      case "user":
        userMessages++;
        if (typeof entry.message?.content === "string") {
          lastUserMessage = entry.message.content;
        }
        break;

      case "assistant":
        assistantMessages++;
        if (entry.message?.content) {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text") {
                lastAssistantMessage = block.text;
              }
              if (block.type === "tool_use") {
                toolCalls++;
              }
            }
          } else if (typeof content === "string") {
            lastAssistantMessage = content;
          }
        }
        // Extract token usage from assistant message metadata
        if (entry.message?.usage) {
          totalInputTokens += entry.message.usage.input_tokens || 0;
          totalOutputTokens += entry.message.usage.output_tokens || 0;
          totalCacheRead += entry.message.usage.cache_read_input_tokens || 0;
        }
        if (entry.usage) {
          totalInputTokens += entry.usage.input_tokens || 0;
          totalOutputTokens += entry.usage.output_tokens || 0;
          totalCacheRead += entry.usage.cache_read_input_tokens || 0;
        }
        if (entry.model) model = entry.model;
        break;

      case "summary":
      case "system_summary":
        hasSummary = true;
        break;

      case "file-history-snapshot":
        // Tracked file changes
        break;
    }

    // Check for error indicators
    if (entry.error || entry.type === "error") {
      hasError = true;
    }

    // Extract branch if present in session metadata
    if (entry.branch) branch = entry.branch;
    if (entry.metadata?.branch) branch = entry.metadata.branch;
  }

  return {
    sessionId,
    isAgent,
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
  };
}

/**
 * Determine session status based on timestamps and content.
 */
export function inferStatus(session) {
  if (session.hasError) return "error";
  if (session.hasSummary) return "completed";

  if (!session.lastTimestamp) return "completed";

  const lastActiveMs = new Date(session.lastTimestamp).getTime();
  const ageMs = Date.now() - lastActiveMs;

  if (ageMs < 60_000) return "active";       // < 1 min
  if (ageMs < 600_000) return "idle";         // < 10 min
  return "completed";
}

/**
 * Parse sessions-index.json if it exists for richer metadata.
 */
export async function parseSessionsIndex(indexPath) {
  try {
    const raw = await fs.promises.readFile(indexPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Parse stats-cache.json for aggregate usage stats.
 */
export async function parseStatsCache(claudeDir) {
  const statsPath = path.join(claudeDir, "stats-cache.json");
  try {
    const raw = await fs.promises.readFile(statsPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Scan a Claude directory and return all sessions with their parsed data.
 */
export async function scanClaudeDir(claudeDir) {
  const projectsDir = path.join(claudeDir, "projects");
  const sessions = [];

  let projectDirs;
  try {
    projectDirs = await fs.promises.readdir(projectsDir);
  } catch {
    return sessions;
  }

  for (const projectDir of projectDirs) {
    const projectPath = path.join(projectsDir, projectDir);
    const stat = await fs.promises.stat(projectPath).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const projectName = extractProjectName(projectDir);
    const decodedPath = decodeProjectPath(projectDir);

    // Read sessions-index.json for metadata
    const index = await parseSessionsIndex(
      path.join(projectPath, "sessions-index.json")
    );

    // Scan JSONL files
    let files;
    try {
      files = await fs.promises.readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const filepath = path.join(projectPath, file);
      const fileStat = await fs.promises.stat(filepath).catch(() => null);
      if (!fileStat) continue;

      // Skip files not modified in the last 24 hours for performance
      const ageHours = (Date.now() - fileStat.mtimeMs) / 3_600_000;
      if (ageHours > 24) continue;

      const parsed = await parseSessionFile(filepath);
      if (!parsed) continue;

      // Enrich with index metadata if available
      const indexEntry = index?.sessions?.[parsed.sessionId];
      const branch = parsed.branch || indexEntry?.branch || null;
      const summary = indexEntry?.summary || null;

      sessions.push({
        ...parsed,
        status: inferStatus(parsed),
        project: {
          name: projectName,
          path: decodedPath,
          encoded: projectDir,
        },
        branch,
        summary,
        fileSize: fileStat.size,
        lastModified: fileStat.mtimeMs,
      });
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
