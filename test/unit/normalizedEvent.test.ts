import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { normalizeRawEvent } from "../../src/normalizedEvent";
import { normalizeClaudeEvent } from "../../src/claudeEventMapper";
import { openStorage, DriftStorage, DriftRawEvent } from "../../src/storage";
import { DRIFT_HOOK_EVENTS } from "../../src/hookInstaller";

function openTempStorage(): DriftStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-normalized-event-test-"));
  return openStorage(path.join(dir, "drift.sqlite3"));
}

// Shapes below are taken directly from a real captured Claude Code session
// (M4C), not invented.
const REAL_USER_PROMPT_SUBMIT = {
  session_id: "1597a795-6eb8-4a93-8b6d-6114ca6e2cc3",
  transcript_path: "/Users/dev/.claude/projects/proj/1597a795.jsonl",
  cwd: "/Users/dev/drift-scratch",
  scratchpad_dir: "/private/tmp/claude-501/drift-scratch/scratchpad",
  prompt_id: "3ac3ba74-7baf-48f1-973c-8c352e991d30",
  permission_mode: "auto",
  hook_event_name: "UserPromptSubmit",
  prompt: "Read package.json and tell me the package name. Do not modify anything.",
};

const REAL_PRE_TOOL_USE = {
  session_id: "1597a795-6eb8-4a93-8b6d-6114ca6e2cc3",
  transcript_path: "/Users/dev/.claude/projects/proj/1597a795.jsonl",
  cwd: "/Users/dev/drift-scratch",
  permission_mode: "auto",
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: { file_path: "/Users/dev/drift-scratch/package.json" },
  tool_use_id: "toolu_01XrzYcz4K91HawUJgkxZPGz",
};

const REAL_POST_TOOL_USE = {
  session_id: "1597a795-6eb8-4a93-8b6d-6114ca6e2cc3",
  cwd: "/Users/dev/drift-scratch",
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: { file_path: "/Users/dev/drift-scratch/package.json" },
  tool_response: { type: "text", file: { filePath: "package.json", content: "{\"name\":\"x\"}\n" } },
  tool_use_id: "toolu_01XrzYcz4K91HawUJgkxZPGz",
  duration_ms: 8,
};

const REAL_POST_TOOL_BATCH = {
  session_id: "1597a795-6eb8-4a93-8b6d-6114ca6e2cc3",
  cwd: "/Users/dev/drift-scratch",
  hook_event_name: "PostToolBatch",
  tool_calls: [
    {
      tool_name: "Read",
      tool_input: { file_path: "/Users/dev/drift-scratch/package.json" },
      tool_use_id: "toolu_01XrzYcz4K91HawUJgkxZPGz",
      tool_response: "1\t{\"name\":\"x\"}\n",
    },
  ],
};

const REAL_SUBAGENT_STOP = {
  session_id: "1597a795-6eb8-4a93-8b6d-6114ca6e2cc3",
  hook_event_name: "SubagentStop",
  agent_id: "ae4080e2163be0ac8",
  agent_type: "",
  stop_hook_active: false,
  last_assistant_message: "what's the version number",
  background_tasks: [],
  session_crons: [],
};

const REAL_SESSION_END = {
  session_id: "1597a795-6eb8-4a93-8b6d-6114ca6e2cc3",
  transcript_path: "/Users/dev/.claude/projects/proj/1597a795.jsonl",
  cwd: "/Users/dev/drift-scratch",
  prompt_id: "a2c179f8-ec94-4088-9908-0759fc177a50",
  hook_event_name: "SessionEnd",
  reason: "prompt_input_exit",
};

function rawEvent(payload: unknown, overrides: Partial<DriftRawEvent> = {}): DriftRawEvent {
  return { id: 1, sessionId: "s1", timestamp: 1000, payload, ...overrides };
}

suite("normalizedEvent (M5A)", () => {
  test("normalizes a known session/completion event (SessionEnd)", () => {
    const event = normalizeRawEvent(rawEvent(REAL_SESSION_END, { id: 42, sessionId: "sX", timestamp: 5000 }));

    assert.strictEqual(event.sessionId, "sX");
    assert.strictEqual(event.type, "session_end");
    assert.strictEqual(event.source, "claude");
    assert.strictEqual(event.timestamp, 5000);
    assert.strictEqual(event.hookEventName, "SessionEnd");
    assert.strictEqual(event.rawEventId, 42);
    assert.deepStrictEqual(event.data, {
      cwd: "/Users/dev/drift-scratch",
      transcriptPath: "/Users/dev/.claude/projects/proj/1597a795.jsonl",
      reason: "prompt_input_exit",
    });
  });

  test("normalizes a known turn event (UserPromptSubmit)", () => {
    const event = normalizeRawEvent(rawEvent(REAL_USER_PROMPT_SUBMIT));

    assert.strictEqual(event.type, "user_prompt");
    assert.strictEqual(event.hookEventName, "UserPromptSubmit");
    assert.deepStrictEqual(event.data, {
      cwd: "/Users/dev/drift-scratch",
      transcriptPath: "/Users/dev/.claude/projects/proj/1597a795.jsonl",
      permissionMode: "auto",
      prompt: "Read package.json and tell me the package name. Do not modify anything.",
    });
  });

  test("normalizes a known tool invocation event (PreToolUse)", () => {
    const event = normalizeRawEvent(rawEvent(REAL_PRE_TOOL_USE));

    assert.strictEqual(event.type, "tool_invocation");
    assert.deepStrictEqual(event.data, {
      cwd: "/Users/dev/drift-scratch",
      transcriptPath: "/Users/dev/.claude/projects/proj/1597a795.jsonl",
      permissionMode: "auto",
      toolName: "Read",
      toolInput: { file_path: "/Users/dev/drift-scratch/package.json" },
      toolUseId: "toolu_01XrzYcz4K91HawUJgkxZPGz",
    });
  });

  test("normalizes a known tool result event (PostToolUse)", () => {
    const event = normalizeRawEvent(rawEvent(REAL_POST_TOOL_USE));

    assert.strictEqual(event.type, "tool_result");
    assert.deepStrictEqual(event.data, {
      cwd: "/Users/dev/drift-scratch",
      toolName: "Read",
      toolInput: { file_path: "/Users/dev/drift-scratch/package.json" },
      toolUseId: "toolu_01XrzYcz4K91HawUJgkxZPGz",
      toolResponse: REAL_POST_TOOL_USE.tool_response,
      durationMs: 8,
    });
  });

  test("normalizes a PostToolBatch event's multiple tool calls", () => {
    const event = normalizeRawEvent(rawEvent(REAL_POST_TOOL_BATCH));

    assert.strictEqual(event.type, "tool_result");
    assert.deepStrictEqual(event.data, {
      cwd: "/Users/dev/drift-scratch",
      toolCalls: [
        {
          toolName: "Read",
          toolInput: { file_path: "/Users/dev/drift-scratch/package.json" },
          toolUseId: "toolu_01XrzYcz4K91HawUJgkxZPGz",
          toolResponse: "1\t{\"name\":\"x\"}\n",
        },
      ],
    });
  });

  test("normalizes a subagent lifecycle event (SubagentStop)", () => {
    const event = normalizeRawEvent(rawEvent(REAL_SUBAGENT_STOP));

    assert.strictEqual(event.type, "subagent_lifecycle");
    assert.deepStrictEqual(event.data, {
      agentId: "ae4080e2163be0ac8",
      agentType: "",
      lastAssistantMessage: "what's the version number",
    });
  });

  test("every currently installed hook event maps to a non-generic normalized type", () => {
    for (const eventName of DRIFT_HOOK_EVENTS) {
      const { type } = normalizeClaudeEvent(eventName, {});
      assert.notStrictEqual(type, "generic", `${eventName} should not fall back to generic`);
    }
  });

  test("produces a generic normalized event for an unrecognized hook_event_name, without throwing", () => {
    const payload = { session_id: "s1", hook_event_name: "SomeFutureHookType", extra: { nested: true } };

    const event = normalizeRawEvent(rawEvent(payload));

    assert.strictEqual(event.type, "generic");
    assert.strictEqual(event.hookEventName, "SomeFutureHookType");
    assert.deepStrictEqual(event.data, payload);
  });

  test("produces a generic normalized event without throwing when hook_event_name is missing", () => {
    const event = normalizeRawEvent(rawEvent({ session_id: "s1" }));

    assert.strictEqual(event.type, "generic");
    assert.strictEqual(event.hookEventName, "unknown");
  });

  test("does not mutate the raw event or its payload", () => {
    const payload = { ...REAL_PRE_TOOL_USE };
    const original = JSON.parse(JSON.stringify(payload));
    const event = rawEvent(payload);

    normalizeRawEvent(event);

    assert.deepStrictEqual(payload, original);
    assert.strictEqual(event.payload, payload);
  });

  test("normalization is deterministic for the same raw event", () => {
    const event = rawEvent(REAL_POST_TOOL_USE, { id: 7, sessionId: "s9", timestamp: 4242 });

    const first = normalizeRawEvent(event);
    const second = normalizeRawEvent(event);

    assert.deepStrictEqual(first, second);
  });

  test("keeps normalized events for one session in the same order as their raw events", () => {
    const storage = openTempStorage();
    const session = storage.createSession();

    storage.insertRawEvent(session.id, { session_id: session.id, hook_event_name: "UserPromptSubmit" }, 100);
    storage.insertRawEvent(session.id, { session_id: session.id, hook_event_name: "PreToolUse" }, 200);
    storage.insertRawEvent(session.id, { session_id: session.id, hook_event_name: "PostToolUse" }, 300);

    const result = storage.getSession(session.id)!;
    const normalized = result.events.map(normalizeRawEvent);

    assert.deepStrictEqual(
      normalized.map((e) => e.hookEventName),
      ["UserPromptSubmit", "PreToolUse", "PostToolUse"]
    );
    storage.close();
  });

  test("keeps normalized events from two sessions isolated", () => {
    const storage = openTempStorage();
    storage.ensureSession("session-A");
    storage.ensureSession("session-B");

    storage.insertRawEvent("session-A", { session_id: "session-A", hook_event_name: "UserPromptSubmit" }, 100);
    storage.insertRawEvent("session-B", { session_id: "session-B", hook_event_name: "UserPromptSubmit" }, 100);
    storage.insertRawEvent("session-A", { session_id: "session-A", hook_event_name: "PreToolUse" }, 200);
    storage.insertRawEvent("session-B", { session_id: "session-B", hook_event_name: "SessionEnd" }, 200);

    const normalizedA = storage.getSession("session-A")!.events.map(normalizeRawEvent);
    const normalizedB = storage.getSession("session-B")!.events.map(normalizeRawEvent);

    assert.deepStrictEqual(
      normalizedA.map((e) => e.hookEventName),
      ["UserPromptSubmit", "PreToolUse"]
    );
    assert.ok(normalizedA.every((e) => e.sessionId === "session-A"));

    assert.deepStrictEqual(
      normalizedB.map((e) => e.hookEventName),
      ["UserPromptSubmit", "SessionEnd"]
    );
    assert.ok(normalizedB.every((e) => e.sessionId === "session-B"));

    storage.close();
  });
});
