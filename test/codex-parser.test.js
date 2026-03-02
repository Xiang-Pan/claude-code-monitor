import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { parseCodexSessionFile, scanCodexDir } from "../server/codex-parser.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeRollout(lines, filename = "rollout-abc123.jsonl") {
  const filepath = path.join(tmpDir, filename);
  fs.writeFileSync(filepath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filepath;
}

function writeRolloutInDir(lines, filename = "rollout-abc123.jsonl") {
  const dayDir = path.join(tmpDir, "sessions", "2026", "03", "01");
  fs.mkdirSync(dayDir, { recursive: true });
  const filepath = path.join(dayDir, filename);
  fs.writeFileSync(filepath, lines.map((l) => JSON.stringify(l)).join("\n"));
  return filepath;
}

describe("parseCodexSessionFile", () => {
  it("extracts session metadata from session_meta line", async () => {
    const filepath = writeRollout([
      { type: "session_meta", meta: { id: "sess-1", cwd: "/home/user/myproject", cli_version: "1.0.0" }, git: { branch: "main" }, ts: "2026-03-01T10:00:00Z" },
    ]);
    const result = await parseCodexSessionFile(filepath);
    expect(result.cwd).toBe("/home/user/myproject");
    expect(result.branch).toBe("main");
  });

  it("extracts session ID from filename", async () => {
    const filepath = writeRollout([
      { type: "session_meta", meta: { id: "sess-1", cwd: "/tmp" }, ts: "2026-03-01T10:00:00Z" },
    ], "rollout-deadbeef-1234.jsonl");
    const result = await parseCodexSessionFile(filepath);
    expect(result.sessionId).toBe("deadbeef-1234");
  });

  it("counts UserMessage and AgentMessage", async () => {
    const filepath = writeRollout([
      { type: "session_meta", meta: { cwd: "/tmp" }, ts: "2026-03-01T10:00:00Z" },
      { type: "event_msg", payload: { type: "UserMessage", content: "hello" }, ts: "2026-03-01T10:00:01Z" },
      { type: "event_msg", payload: { type: "AgentMessage", content: "hi there" }, ts: "2026-03-01T10:00:02Z" },
      { type: "event_msg", payload: { type: "UserMessage", content: "do something" }, ts: "2026-03-01T10:00:03Z" },
      { type: "event_msg", payload: { type: "AgentMessage", content: "done" }, ts: "2026-03-01T10:00:04Z" },
    ]);
    const result = await parseCodexSessionFile(filepath);
    expect(result.userMessages).toBe(2);
    expect(result.assistantMessages).toBe(2);
    expect(result.messages).toBe(4);
    expect(result.lastUserMessage).toBe("do something");
    expect(result.lastAssistantMessage).toBe("done");
  });

  it("counts tool calls from ExecCommandBegin, McpToolCallBegin, PatchApplyBegin", async () => {
    const filepath = writeRollout([
      { type: "session_meta", meta: { cwd: "/tmp" }, ts: "2026-03-01T10:00:00Z" },
      { type: "event_msg", payload: { type: "ExecCommandBegin" }, ts: "2026-03-01T10:00:01Z" },
      { type: "event_msg", payload: { type: "McpToolCallBegin" }, ts: "2026-03-01T10:00:02Z" },
      { type: "event_msg", payload: { type: "PatchApplyBegin" }, ts: "2026-03-01T10:00:03Z" },
      { type: "event_msg", payload: { type: "ExecCommandBegin" }, ts: "2026-03-01T10:00:04Z" },
    ]);
    const result = await parseCodexSessionFile(filepath);
    expect(result.toolCalls).toBe(4);
  });

  it("accumulates tokens from TokenCount events", async () => {
    const filepath = writeRollout([
      { type: "session_meta", meta: { cwd: "/tmp" }, ts: "2026-03-01T10:00:00Z" },
      { type: "event_msg", payload: { type: "TokenCount", input_tokens: 100, output_tokens: 50, cached_input_tokens: 20, model: "o3" }, ts: "2026-03-01T10:00:01Z" },
      { type: "event_msg", payload: { type: "TokenCount", input_tokens: 200, output_tokens: 100, cached_input_tokens: 40, model: "o3" }, ts: "2026-03-01T10:00:02Z" },
    ]);
    const result = await parseCodexSessionFile(filepath);
    expect(result.tokens.input).toBe(300);
    expect(result.tokens.output).toBe(150);
    expect(result.tokens.cacheRead).toBe(60);
    expect(result.model).toBe("o3");
  });

  it("detects errors from Error payload", async () => {
    const filepath = writeRollout([
      { type: "session_meta", meta: { cwd: "/tmp" }, ts: "2026-03-01T10:00:00Z" },
      { type: "event_msg", payload: { type: "Error", message: "something broke" }, ts: "2026-03-01T10:00:01Z" },
    ]);
    const result = await parseCodexSessionFile(filepath);
    expect(result.hasError).toBe(true);
  });

  it("does not treat ContextCompacted as session completion", async () => {
    const filepath = writeRollout([
      { type: "session_meta", meta: { cwd: "/tmp" }, ts: "2026-03-01T10:00:00Z" },
      { type: "event_msg", payload: { type: "ContextCompacted" }, ts: "2026-03-01T10:00:01Z" },
    ]);
    const result = await parseCodexSessionFile(filepath);
    expect(result.hasSummary).toBe(false);
  });

  it("extracts model from turn_context", async () => {
    const filepath = writeRollout([
      { type: "session_meta", meta: { cwd: "/tmp" }, ts: "2026-03-01T10:00:00Z" },
      { type: "event_msg", payload: { type: "UserMessage", content: "hi", turn_context: { model: "gpt-4o" } }, ts: "2026-03-01T10:00:01Z" },
    ]);
    const result = await parseCodexSessionFile(filepath);
    expect(result.model).toBe("gpt-4o");
  });

  it("returns null for empty files", async () => {
    const filepath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(filepath, "");
    const result = await parseCodexSessionFile(filepath);
    expect(result).toBeNull();
  });

  it("handles array content in messages", async () => {
    const filepath = writeRollout([
      { type: "session_meta", meta: { cwd: "/tmp" }, ts: "2026-03-01T10:00:00Z" },
      { type: "event_msg", payload: { type: "UserMessage", content: [{ type: "text", text: "array msg" }] }, ts: "2026-03-01T10:00:01Z" },
    ]);
    const result = await parseCodexSessionFile(filepath);
    expect(result.lastUserMessage).toBe("array msg");
  });
});

describe("scanCodexDir", () => {
  it("finds sessions in date-organized directories", async () => {
    const lines = [
      { type: "session_meta", meta: { cwd: "/home/user/project" }, git: { branch: "dev" }, ts: new Date().toISOString() },
      { type: "event_msg", payload: { type: "UserMessage", content: "test" }, ts: new Date().toISOString() },
    ];
    writeRolloutInDir(lines, "rollout-uuid1.jsonl");

    const sessions = await scanCodexDir(tmpDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("uuid1");
    expect(sessions[0].project.name).toBe("project");
    expect(sessions[0].branch).toBe("dev");
    expect(sessions[0].status).toBeDefined();
  });

  it("returns empty array when sessions dir does not exist", async () => {
    const sessions = await scanCodexDir(path.join(tmpDir, "nonexistent"));
    expect(sessions).toEqual([]);
  });

  it("skips non-jsonl files", async () => {
    const dayDir = path.join(tmpDir, "sessions", "2026", "03", "01");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, "readme.txt"), "not a session");

    const sessions = await scanCodexDir(tmpDir);
    expect(sessions).toEqual([]);
  });
});
