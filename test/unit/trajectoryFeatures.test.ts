import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage, DriftStorage } from "../../src/storage";
import { normalizeRawEvent } from "../../src/normalizedEvent";
import { buildTrajectory } from "../../src/trajectory";
import { attributeUsageToTrajectory } from "../../src/trajectoryUsageAttribution";
import { extractTrajectoryFeatures, TrajectoryFeatureFinding } from "../../src/trajectoryFeatures";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-features-test-"));
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

function featuresFor(sessionId: string, storage: DriftStorage): TrajectoryFeatureFinding[] {
  const session = storage.getSession(sessionId)!;
  const normalized = session.events.map(normalizeRawEvent);
  const trajectory = buildTrajectory(sessionId, normalized);
  const withUsage = attributeUsageToTrajectory(trajectory, storage);
  return extractTrajectoryFeatures(withUsage);
}

function findByType(findings: TrajectoryFeatureFinding[], type: string): TrajectoryFeatureFinding[] {
  return findings.filter((f) => f.type === type);
}

suite("trajectoryFeatures (M8A)", () => {
  let storage: DriftStorage;

  setup(() => {
    storage = openStorage(tempDbPath());
  });

  teardown(() => {
    storage.close();
  });

  test("unchanged_file_reread: same file read twice with identical content triggers a finding", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1", tool_response: "content-A" }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r2", tool_response: "content-A" }, 210);

    const findings = featuresFor("s1", storage);
    const rereads = findByType(findings, "unchanged_file_reread");
    assert.strictEqual(rereads.length, 1);
    assert.deepStrictEqual(rereads[0].stepIndexes, [0, 1, 2, 3]);
    assert.strictEqual(rereads[0].evidence.filePath, "/a.txt");
    assert.strictEqual(rereads[0].sessionId, "s1");
  });

  test("a reread after the file changed does not trigger unchanged_file_reread", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1", tool_response: "content-A" }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r2", tool_response: "content-B (changed)" }, 210);

    const findings = featuresFor("s1", storage);
    assert.strictEqual(findByType(findings, "unchanged_file_reread").length, 0);
  });

  test("repeated_command: same normalized command executed again, non-adjacent, is detected", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm  test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm  test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/b.txt" }, tool_use_id: "r1" }, 150);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/b.txt" }, tool_use_id: "r1", tool_response: "b" }, 160);
    // Same command, different whitespace, run again later.
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok again" } }, 210);

    const findings = featuresFor("s1", storage);
    const repeats = findByType(findings, "repeated_command");
    assert.strictEqual(repeats.length, 1);
    assert.strictEqual(repeats[0].evidence.normalizedCommand, "npm test");
    assert.deepStrictEqual(repeats[0].stepIndexes, [0, 1, 4, 5]);
  });

  test("repeated_failure: same tool/input produces the same failure signature again", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/c.txt" }, tool_use_id: "r1" }, 150);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/c.txt" }, tool_use_id: "r1", tool_response: "c" }, 160);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 210);

    const findings = featuresFor("s1", storage);
    const failures = findByType(findings, "repeated_failure");
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].evidence.toolName, "Bash");
    assert.deepStrictEqual(failures[0].stepIndexes, [0, 1, 4, 5]);
  });

  test("productive non-identical retries do not trigger identical-failure findings", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm buld" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm buld" }, tool_use_id: "c1", tool_response: { error: "unknown command buld" } }, 110);
    // A DIFFERENT (corrected) command succeeds immediately after.
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm build" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm build" }, tool_use_id: "c2", tool_response: { output: "built" } }, 130);

    const findings = featuresFor("s1", storage);
    assert.strictEqual(findByType(findings, "repeated_failure").length, 0);
    assert.strictEqual(findByType(findings, "retry_without_state_change").length, 0);
    assert.strictEqual(findByType(findings, "repeated_command").length, 0);
  });

  test("retry_without_state_change: identical failed call retried immediately with nothing in between", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "timeout" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { output: "worked this time" } }, 130);

    const findings = featuresFor("s1", storage);
    const retries = findByType(findings, "retry_without_state_change");
    assert.strictEqual(retries.length, 1);
    assert.deepStrictEqual(retries[0].stepIndexes, [0, 1, 2, 3]);
  });

  // M8A.1 regression case 1: failure -> read-only unrelated command -> same retry => SHOULD fire.
  test("retry_without_state_change: a read-only/unrelated intervening command does not suppress the finding", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "timeout" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/d.txt" }, tool_use_id: "r1" }, 115);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/d.txt" }, tool_use_id: "r1", tool_response: "d" }, 118);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { output: "worked" } }, 130);

    const findings = featuresFor("s1", storage);
    assert.strictEqual(findByType(findings, "retry_without_state_change").length, 1);
  });

  // M8A.1 regression case 2: failure -> relevant Write/Edit -> same retry => SHOULD NOT fire.
  test("retry_without_state_change: a relevant Write between attempts (separate steps) suppresses the finding", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "ENOENT: config.json missing" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/config.json", content: "{}" }, tool_use_id: "w1" }, 115);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/config.json", content: "{}" }, tool_use_id: "w1", tool_response: { output: "written" } }, 118);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { output: "worked" } }, 130);

    const findings = featuresFor("s1", storage);
    assert.strictEqual(findByType(findings, "retry_without_state_change").length, 0);
  });

  // M8A.1 regression case 3 (the core bug fix): failure -> PostToolBatch [relevant Write/Edit, same retry] => SHOULD NOT fire.
  test("retry_without_state_change: a relevant Write earlier in the SAME PostToolBatch as the retry suppresses the finding", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "ENOENT: config.json missing" } }, 110);
    storage.insertRawEvent("s1", {
      hook_event_name: "PostToolBatch",
      tool_calls: [
        { tool_name: "Write", tool_input: { file_path: "/config.json", content: "{}" }, tool_use_id: "w1", tool_response: { output: "written" } },
        { tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "b2", tool_response: { output: "worked" } },
      ],
    }, 200);

    const findings = featuresFor("s1", storage);
    assert.strictEqual(findByType(findings, "retry_without_state_change").length, 0, "the Write earlier in the same batch, before the retry sub-call, must be seen and must suppress this");
  });

  // M8A.1 regression case 4: failure -> PostToolBatch [read-only unrelated call, same retry] => SHOULD fire.
  test("retry_without_state_change: a read-only unrelated call earlier in the SAME PostToolBatch does not suppress the finding", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s1", {
      hook_event_name: "PostToolBatch",
      tool_calls: [
        { tool_name: "Bash", tool_input: { command: "unrelated-ls" }, tool_use_id: "b1", tool_response: { output: "files" } },
        { tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "b2", tool_response: { output: "worked" } },
      ],
    }, 200);

    const findings = featuresFor("s1", storage);
    assert.strictEqual(findByType(findings, "retry_without_state_change").length, 1, "a read-only unrelated sub-call in the same batch must not suppress this");
  });

  test("retry_without_state_change: a Write/Edit that itself failed does not suppress the finding (it never actually changed anything)", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/config.json", content: "{}" }, tool_use_id: "w1" }, 115);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Write", tool_input: { file_path: "/config.json", content: "{}" }, tool_use_id: "w1", tool_response: { error: "permission denied" } }, 118);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { output: "worked" } }, 130);

    const findings = featuresFor("s1", storage);
    assert.strictEqual(findByType(findings, "retry_without_state_change").length, 1);
  });

  test("repeated_context: identical (tool, input, result) consumed again for a non-Read tool", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "TODO" }, tool_use_id: "g1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Grep", tool_input: { pattern: "TODO" }, tool_use_id: "g1", tool_response: "3 matches" }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "b1" }, 150);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "b1", tool_response: { output: "files" } }, 160);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "TODO" }, tool_use_id: "g2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Grep", tool_input: { pattern: "TODO" }, tool_use_id: "g2", tool_response: "3 matches" }, 210);

    const findings = featuresFor("s1", storage);
    const repeatedContext = findByType(findings, "repeated_context");
    assert.strictEqual(repeatedContext.length, 1);
    assert.strictEqual(repeatedContext[0].evidence.toolName, "Grep");
    assert.deepStrictEqual(repeatedContext[0].stepIndexes, [0, 1, 4, 5]);
  });

  test("repeated_context does not fire for the Read tool (owned by unchanged_file_reread instead)", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1", tool_response: "content-A" }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r2" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r2", tool_response: "content-A" }, 210);

    const findings = featuresFor("s1", storage);
    assert.strictEqual(findByType(findings, "repeated_context").length, 0);
    assert.strictEqual(findByType(findings, "unchanged_file_reread").length, 1);
  });

  test("findings point to the correct original trajectory steps, and involved steps are unaffected by the extraction", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "SessionStart" }, 50);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

    const session = storage.getSession("s1")!;
    const normalized = session.events.map(normalizeRawEvent);
    const trajectory = buildTrajectory("s1", normalized);
    const withUsage = attributeUsageToTrajectory(trajectory, storage);
    const findings = extractTrajectoryFeatures(withUsage);

    // Index 0 is SessionStart, so the tool calls occupy indexes 1-4.
    const failures = findByType(findings, "repeated_failure");
    assert.strictEqual(failures.length, 1);
    assert.deepStrictEqual(failures[0].stepIndexes, [1, 2, 3, 4]);
    failures[0].stepIndexes.forEach((i) => {
      assert.ok(withUsage.steps[i], `step ${i} must exist in the original trajectory`);
    });
  });

  test("usage attribution is preserved in evidence when available", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 90);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

    storage.insertModelUsageEvent("s1", apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", input_tokens: 500, output_tokens: 50 }), 95);

    const findings = featuresFor("s1", storage);
    const failures = findByType(findings, "repeated_failure");
    assert.strictEqual(failures.length, 1);
    assert.ok(failures[0].usage, "the finding must carry the usage attributed to its involved steps (via the shared UserPromptSubmit step)");
    assert.strictEqual(failures[0].usage!.inputTokens, 500);
    assert.strictEqual(failures[0].usage!.outputTokens, 50);
  });

  test("a finding with no attributable usage leaves usage undefined rather than fabricating zeros", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

    const findings = featuresFor("s1", storage);
    assert.strictEqual(findByType(findings, "repeated_failure")[0].usage, undefined);
  });

  test("cross-session isolation holds", () => {
    for (const sessionId of ["session-A", "session-B"]) {
      storage.ensureSession(sessionId);
      storage.insertRawEvent(sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent(sessionId, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
      storage.insertRawEvent(sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
      storage.insertRawEvent(sessionId, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);
    }

    const findingsA = featuresFor("session-A", storage);
    const findingsB = featuresFor("session-B", storage);

    assert.ok(findingsA.length > 0, "session-A must produce findings from its own identical fixture");
    assert.strictEqual(findingsA.length, findingsB.length, "both sessions have identical fixtures, so identical finding counts");
    findingsA.forEach((f) => assert.strictEqual(f.sessionId, "session-A"));
    findingsB.forEach((f) => assert.strictEqual(f.sessionId, "session-B"));
    findingsA.forEach((f) => f.stepIndexes.forEach((i) => assert.ok(i >= 0 && i < 4, "session-A's stepIndexes must stay within its own 4 raw events")));
    findingsB.forEach((f) => f.stepIndexes.forEach((i) => assert.ok(i >= 0 && i < 4, "session-B's stepIndexes must stay within its own 4 raw events")));
  });

  test("deterministic output for the same input", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

    const session = storage.getSession("s1")!;
    const normalized = session.events.map(normalizeRawEvent);
    const trajectory = buildTrajectory("s1", normalized);
    const withUsage = attributeUsageToTrajectory(trajectory, storage);

    const first = extractTrajectoryFeatures(withUsage);
    const second = extractTrajectoryFeatures(withUsage);
    assert.deepStrictEqual(first, second);
  });

  test("does not mutate the trajectory usage it reads", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);

    const session = storage.getSession("s1")!;
    const normalized = session.events.map(normalizeRawEvent);
    const trajectory = buildTrajectory("s1", normalized);
    const withUsage = attributeUsageToTrajectory(trajectory, storage);
    const snapshotBefore = JSON.stringify(withUsage);

    extractTrajectoryFeatures(withUsage);

    assert.strictEqual(JSON.stringify(withUsage), snapshotBefore);
  });

  test("no finding carries a confidence score or a waste/low-value classification", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

    const findings = featuresFor("s1", storage);
    for (const finding of findings) {
      assert.strictEqual(Object.keys(finding).includes("confidence"), false);
      assert.strictEqual(Object.keys(finding).includes("waste"), false);
      assert.strictEqual(Object.keys(finding).includes("isLowValue"), false);
      assert.strictEqual(Object.keys(finding).includes("severity"), false);
    }
  });
});
