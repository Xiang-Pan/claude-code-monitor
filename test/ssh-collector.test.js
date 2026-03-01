import { describe, it, expect } from "vitest";
import { parseRemoteSessions } from "../server/ssh-collector.js";

describe("parseRemoteSessions", () => {
  it("returns empty array for missing sessions", () => {
    expect(parseRemoteSessions({})).toEqual([]);
    expect(parseRemoteSessions({ sessions: null })).toEqual([]);
  });

  it("parses a session with all fields", () => {
    const now = Date.now();
    const result = parseRemoteSessions({
      sessions: [{
        sessionId: "abc-123",
        projectDir: "-home-user-myapp",
        cwd: "/home/user/myapp",
        gitBranch: "main",
        version: "1.0.0",
        model: "claude-sonnet-4-6",
        firstTimestamp: new Date(now - 60000).toISOString(),
        lastTimestamp: new Date(now - 5000).toISOString(),
        lastUserMessage: "fix the bug",
        lastAssistantMessage: "I found the issue",
        userMessages: 5,
        assistantMessages: 10,
        messages: 15,
        toolCalls: 3,
        tokens: { input: 1000, output: 500, cacheRead: 200 },
        hasError: false,
        fileSize: 4096,
        mtime: Math.floor(now / 1000),
      }],
    });

    expect(result).toHaveLength(1);
    const s = result[0];
    expect(s.sessionId).toBe("abc-123");
    expect(s.status).toBe("active");
    expect(s.project.name).toBe("myapp");
    expect(s.project.path).toBe("/home/user/myapp");
    expect(s.branch).toBe("main");
    expect(s.model).toBe("claude-sonnet-4-6");
    expect(s.tokens.input).toBe(1000);
    expect(s.isAgent).toBe(false);
  });

  it("detects agent sessions", () => {
    const result = parseRemoteSessions({
      sessions: [{
        sessionId: "agent-xyz",
        projectDir: "-home-user-app",
        cwd: "",
        lastTimestamp: new Date(Date.now() - 5000).toISOString(),
        userMessages: 0,
        assistantMessages: 0,
        messages: 0,
        toolCalls: 0,
        tokens: { input: 0, output: 0, cacheRead: 0 },
        hasError: false,
        fileSize: 100,
        mtime: Math.floor(Date.now() / 1000),
      }],
    });

    expect(result[0].isAgent).toBe(true);
  });

  it("infers error status from hasError", () => {
    const result = parseRemoteSessions({
      sessions: [{
        sessionId: "err-1",
        projectDir: "-tmp",
        cwd: "/tmp",
        lastTimestamp: new Date().toISOString(),
        userMessages: 1,
        assistantMessages: 1,
        messages: 2,
        toolCalls: 0,
        tokens: { input: 0, output: 0, cacheRead: 0 },
        hasError: true,
        fileSize: 100,
        mtime: Math.floor(Date.now() / 1000),
      }],
    });

    expect(result[0].status).toBe("error");
  });
});
