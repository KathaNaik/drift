import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage, DriftStorage } from "../../src/storage";
import { normalizeRawEvent } from "../../src/normalizedEvent";
import { buildTrajectory } from "../../src/trajectory";
import { attributeUsageToTrajectory } from "../../src/trajectoryUsageAttribution";
import { detectSubagentOverlap, SubagentOverlapFinding } from "../../src/subagentOverlap";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-subagent-overlap-test-"));
  return path.join(dir, "drift.sqlite3");
}

function apiRequestPayload(attrs: Record<string, unknown>): unknown {
  return {
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
    })),
  };
}

function overlapFor(sessionId: string, storage: DriftStorage): SubagentOverlapFinding[] {
  const session = storage.getSession(sessionId)!;
  const normalized = session.events.map(normalizeRawEvent);
  const trajectory = buildTrajectory(sessionId, normalized);
  const withUsage = attributeUsageToTrajectory(trajectory, storage);
  return detectSubagentOverlap(withUsage, storage);
}

function findByKind(findings: SubagentOverlapFinding[], kind: string): SubagentOverlapFinding[] {
  return findings.filter((f) => f.evidence.overlapKind === kind);
}

suite("subagentOverlap (M8B)", () => {
  let storage: DriftStorage;

  setup(() => {
    storage = openStorage(tempDbPath());
  });

  teardown(() => {
    storage.close();
  });

  test("identical file exploration across two subagents is detected", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1", tool_response: "content-A" }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r2", tool_response: "content-A-later" }, 210);

    const findings = overlapFor("s1", storage);
    const sameInput = findByKind(findings, "same_tool_input");
    assert.strictEqual(sameInput.length, 1);
    assert.deepStrictEqual(sameInput[0].agentIds, ["agent-A", "agent-B"]);
    assert.deepStrictEqual(sameInput[0].stepIndexes, [0, 1, 2, 3]);
    assert.strictEqual(sameInput[0].evidence.toolName, "Read");
  });

  test("identical commands across subagents are detected", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 210);

    const findings = overlapFor("s1", storage);
    const sameInput = findByKind(findings, "same_tool_input");
    assert.strictEqual(sameInput.length, 1);
    assert.deepStrictEqual(sameInput[0].agentIds, ["agent-A", "agent-B"]);

    // Byte-identical output too, so this also qualifies as a stronger same_result_fingerprint finding.
    const sameResult = findByKind(findings, "same_result_fingerprint");
    assert.strictEqual(sameResult.length, 1);
    assert.deepStrictEqual(sameResult[0].agentIds, ["agent-A", "agent-B"]);
  });

  test("overlapping modification targets are detected even when the edits differ", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Edit", tool_input: { file_path: "/shared.ts", old_string: "foo", new_string: "bar" }, tool_use_id: "e1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Edit", tool_input: { file_path: "/shared.ts", old_string: "foo", new_string: "bar" }, tool_use_id: "e1", tool_response: { output: "edited" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Edit", tool_input: { file_path: "/shared.ts", old_string: "baz", new_string: "qux" }, tool_use_id: "e2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Edit", tool_input: { file_path: "/shared.ts", old_string: "baz", new_string: "qux" }, tool_use_id: "e2", tool_response: { output: "edited" } }, 210);

    const findings = overlapFor("s1", storage);
    const overlapTarget = findByKind(findings, "overlapping_modification_target");
    assert.strictEqual(overlapTarget.length, 1);
    assert.deepStrictEqual(overlapTarget[0].agentIds, ["agent-A", "agent-B"]);
    assert.strictEqual(overlapTarget[0].evidence.filePath, "/shared.ts");

    // Different edit inputs, so this must NOT also register as same_tool_input.
    assert.strictEqual(findByKind(findings, "same_tool_input").length, 0);
  });

  test("unrelated subagent work is not flagged", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1", tool_response: "content-A" }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Read", tool_input: { file_path: "/b.txt" }, tool_use_id: "r2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Read", tool_input: { file_path: "/b.txt" }, tool_use_id: "r2", tool_response: "content-B" }, 210);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "c1" }, 220);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "c1", tool_response: { output: "files" } }, 230);

    const findings = overlapFor("s1", storage);
    assert.deepStrictEqual(findings, []);
  });

  test("a single subagent repeating its own work does not count as overlap (needs 2+ distinct agents)", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 210);

    const findings = overlapFor("s1", storage);
    assert.deepStrictEqual(findings, []);
  });

  test("main-thread work (no agent_id) never participates in overlap detection", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 210);

    const findings = overlapFor("s1", storage);
    assert.deepStrictEqual(findings, [], "one main-thread call plus one subagent call is still only ONE distinct agent, not overlap across subagents");
  });

  test("overlap across a PostToolBatch sub-call and a separate single tool call is detected, using the batch's own agent_id", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s1", {
      hook_event_name: "PostToolBatch",
      agent_id: "agent-B",
      tool_calls: [
        { tool_name: "Read", tool_input: { file_path: "/x.txt" }, tool_use_id: "x1", tool_response: "x" },
        { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "b1", tool_response: { output: "ok" } },
      ],
    }, 200);

    const findings = overlapFor("s1", storage);
    const sameInput = findByKind(findings, "same_tool_input");
    assert.strictEqual(sameInput.length, 1);
    assert.deepStrictEqual(sameInput[0].agentIds, ["agent-A", "agent-B"]);
    assert.deepStrictEqual(sameInput[0].stepIndexes, [0, 1, 2]);
  });

  test("cross-session isolation holds", () => {
    for (const sessionId of ["session-A", "session-B"]) {
      storage.ensureSession(sessionId);
      storage.insertRawEvent(sessionId, { hook_event_name: "PreToolUse", agent_id: "agent-1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent(sessionId, { hook_event_name: "PostToolUse", agent_id: "agent-1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
      storage.insertRawEvent(sessionId, { hook_event_name: "PreToolUse", agent_id: "agent-2", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 200);
      storage.insertRawEvent(sessionId, { hook_event_name: "PostToolUse", agent_id: "agent-2", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 210);
    }

    const findingsA = overlapFor("session-A", storage);
    const findingsB = overlapFor("session-B", storage);

    assert.ok(findingsA.length > 0);
    assert.strictEqual(findingsA.length, findingsB.length);
    findingsA.forEach((f) => assert.strictEqual(f.sessionId, "session-A"));
    findingsB.forEach((f) => assert.strictEqual(f.sessionId, "session-B"));
    findingsA.forEach((f) => f.stepIndexes.forEach((i) => assert.ok(i >= 0 && i < 4)));
    findingsB.forEach((f) => f.stepIndexes.forEach((i) => assert.ok(i >= 0 && i < 4)));
  });

  test("usage attribution is preserved for the involved work when available", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 90);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 130);

    storage.insertModelUsageEvent("s1", apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", input_tokens: 400, output_tokens: 40 }), 95);

    const findings = overlapFor("s1", storage);
    const sameInput = findByKind(findings, "same_tool_input");
    assert.strictEqual(sameInput.length, 1);
    assert.ok(sameInput[0].usage);
    assert.strictEqual(sameInput[0].usage!.inputTokens, 400);
    assert.strictEqual(sameInput[0].usage!.outputTokens, 40);
  });

  test("a finding with no attributable usage leaves usage undefined rather than fabricating zeros", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 210);

    const findings = overlapFor("s1", storage);
    findings.forEach((f) => assert.strictEqual(f.usage, undefined));
  });

  test("deterministic output for the same input", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 210);

    const session = storage.getSession("s1")!;
    const normalized = session.events.map(normalizeRawEvent);
    const trajectory = buildTrajectory("s1", normalized);
    const withUsage = attributeUsageToTrajectory(trajectory, storage);

    const first = detectSubagentOverlap(withUsage, storage);
    const second = detectSubagentOverlap(withUsage, storage);
    assert.deepStrictEqual(first, second);
  });

  test("does not mutate the trajectory usage it reads", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 210);

    const session = storage.getSession("s1")!;
    const normalized = session.events.map(normalizeRawEvent);
    const trajectory = buildTrajectory("s1", normalized);
    const withUsage = attributeUsageToTrajectory(trajectory, storage);
    const snapshotBefore = JSON.stringify(withUsage);

    detectSubagentOverlap(withUsage, storage);

    assert.strictEqual(JSON.stringify(withUsage), snapshotBefore);
  });

  test("no finding carries a confidence score or a waste/low-value classification", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 210);

    const findings = overlapFor("s1", storage);
    for (const finding of findings) {
      assert.strictEqual(finding.type, "subagent_overlap");
      assert.strictEqual(Object.keys(finding).includes("confidence"), false);
      assert.strictEqual(Object.keys(finding).includes("waste"), false);
      assert.strictEqual(Object.keys(finding).includes("isLowValue"), false);
    }
  });
});
