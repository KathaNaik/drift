import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage, DriftStorage } from "../../src/storage";
import { normalizeRawEvent } from "../../src/normalizedEvent";
import { buildTrajectory } from "../../src/trajectory";
import { attributeUsageToTrajectory } from "../../src/trajectoryUsageAttribution";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-usage-attribution-test-"));
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

function metricPayload(sessionId: string): unknown {
  return {
    name: "claude_code.token.usage",
    sum: { dataPoints: [{ attributes: [{ key: "session.id", value: { stringValue: sessionId } }] }] },
  };
}

/** Builds the trajectory for a session directly from its stored raw events, exactly as production code would. */
function trajectoryFor(sessionId: string, storage: DriftStorage) {
  const session = storage.getSession(sessionId)!;
  const normalized = session.events.map(normalizeRawEvent);
  return buildTrajectory(sessionId, normalized);
}

suite("trajectoryUsageAttribution (M7C)", () => {
  let storage: DriftStorage;

  setup(() => {
    storage = openStorage(tempDbPath());
  });

  teardown(() => {
    storage.close();
  });

  test("existing trajectory order remains byte-for-byte equivalent aside from additive usage metadata", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "SessionStart" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "hello" }, 200);
    storage.insertRawEvent("s1", { hook_event_name: "SessionEnd" }, 300);

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.sessionId, trajectory.sessionId);
    assert.strictEqual(enriched.steps.length, trajectory.steps.length);
    enriched.steps.forEach((step, i) => {
      const original = trajectory.steps[i];
      assert.strictEqual(step.index, original.index);
      assert.strictEqual(step.event, original.event);
      assert.strictEqual(step.toolUseId, original.toolUseId);
      assert.strictEqual(step.linkedStepIndex, original.linkedStepIndex);
      assert.strictEqual(step.usage, undefined, "no usage was ingested, so no step should carry usage metadata");
    });
  });

  test("exact prompt-correlated usage lands on the correct step", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", prompt_id: "p1", tool_use_id: "t1", tool_name: "Read" }, 150);
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p2" }, 200);

    storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", model: "claude-sonnet-5", input_tokens: 100, output_tokens: 50 }),
      120
    );

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.ok(enriched.steps[0].usage, "the p1 UserPromptSubmit step (index 0) must carry the attributed usage");
    assert.strictEqual(enriched.steps[0].usage!.inputTokens, 100);
    assert.strictEqual(enriched.steps[0].usage!.outputTokens, 50);
    assert.strictEqual(enriched.steps[0].usage!.modelCalls, 1);

    // The tool-use step and the unrelated p2 prompt step must not receive usage.
    assert.strictEqual(enriched.steps[1].usage, undefined);
    assert.strictEqual(enriched.steps[2].usage, undefined);
  });

  test("multiple model calls for one prompt aggregate correctly", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);

    storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", input_tokens: 100, output_tokens: 10, cost_usd: 0.01 }),
      110
    );
    storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", input_tokens: 200, output_tokens: 20, cost_usd: 0.02 }),
      120
    );

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    const usage = enriched.steps[0].usage!;
    assert.strictEqual(usage.modelCalls, 2);
    assert.strictEqual(usage.inputTokens, 300);
    assert.strictEqual(usage.outputTokens, 30);
    assert.strictEqual(usage.costUsd, 0.03);
    assert.strictEqual(usage.records.length, 2);
  });

  test("session-correlated but prompt-unmatched usage remains session-level, not guessed onto a step", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);

    // No prompt.id attribute at all on this telemetry record.
    storage.insertModelUsageEvent("s1", apiRequestPayload({ "session.id": "s1", input_tokens: 42 }), 110);

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.steps[0].usage, undefined, "must not be guessed onto the only prompt step");
    assert.strictEqual(enriched.sessionTotals.inputTokens, 42, "must still show up in session totals");
    assert.strictEqual(enriched.sessionTotals.modelCalls, 1);
  });

  test("a promptId that matches no user_prompt step in this trajectory also stays session-level", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);

    storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "no-such-prompt", input_tokens: 42 }),
      110
    );

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.steps[0].usage, undefined);
    assert.strictEqual(enriched.sessionTotals.inputTokens, 42);
  });

  test("session totals equal the sum of every included model-usage record, including metric-derived ones for modelCalls exclusion", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);

    storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", input_tokens: 10, output_tokens: 5 }),
      110
    );
    // A metric-derived record: session-correlated, but structurally not a "call" and has no extractable tokens.
    storage.insertModelUsageEvent("s1", metricPayload("s1"), 120);

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.sessionTotals.records.length, 2, "both records are preserved for auditability");
    assert.strictEqual(enriched.sessionTotals.modelCalls, 1, "the metric record must not be counted as a model call");
    assert.strictEqual(enriched.sessionTotals.inputTokens, 10);
    assert.strictEqual(enriched.sessionTotals.outputTokens, 5);
  });

  test("cross-session isolation holds", () => {
    storage.ensureSession("session-A");
    storage.ensureSession("session-B");
    storage.insertRawEvent("session-A", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertRawEvent("session-B", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);

    storage.insertModelUsageEvent(
      "session-A",
      apiRequestPayload({ "session.id": "session-A", "prompt.id": "p1", input_tokens: 999 }),
      110
    );

    const trajectoryA = trajectoryFor("session-A", storage);
    const trajectoryB = trajectoryFor("session-B", storage);
    const enrichedA = attributeUsageToTrajectory(trajectoryA, storage);
    const enrichedB = attributeUsageToTrajectory(trajectoryB, storage);

    assert.strictEqual(enrichedA.sessionTotals.inputTokens, 999);
    assert.strictEqual(enrichedB.sessionTotals.inputTokens, undefined, "session-B must not see session-A's usage");
    assert.strictEqual(enrichedB.sessionTotals.modelCalls, 0);
    assert.strictEqual(enrichedB.steps[0].usage, undefined);
  });

  test("deterministic output for the same trajectory and storage contents", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", input_tokens: 10 }),
      110
    );

    const trajectory = trajectoryFor("s1", storage);
    const first = attributeUsageToTrajectory(trajectory, storage);
    const second = attributeUsageToTrajectory(trajectory, storage);

    assert.deepStrictEqual(first, second);
  });

  test("does not mutate the trajectory it is given", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", input_tokens: 10 }),
      110
    );

    const trajectory = trajectoryFor("s1", storage);
    const snapshotBefore = JSON.stringify(trajectory);

    attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(JSON.stringify(trajectory), snapshotBefore);
    assert.strictEqual("usage" in trajectory.steps[0], false, "the original step object must not gain a usage field");
  });

  test("a session with no correlated usage at all produces an all-empty session totals summary", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.deepStrictEqual(enriched.sessionTotals, {
      modelCalls: 0,
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      costUsd: undefined,
      durationMs: undefined,
      records: [],
    });
  });
});

// Shapes below are transcribed verbatim from genuine OTLP bodies captured
// live from the real, installed Claude Code CLI running `claude -p`, which
// was confirmed (M13D-LIVE) to emit no claude_code.api_request log record
// at all -- only these two metrics.
function realCostUsageMetric(sessionId: string, costUsd: number, startTime: string, endTime: string) {
  return {
    name: "claude_code.cost.usage",
    sum: {
      aggregationTemporality: 1,
      isMonotonic: true,
      dataPoints: [{ attributes: [{ key: "session.id", value: { stringValue: sessionId } }, { key: "model", value: { stringValue: "claude-sonnet-5" } }], startTimeUnixNano: startTime, timeUnixNano: endTime, asDouble: costUsd }],
    },
  };
}

function realTokenUsageMetric(sessionId: string, tokens: { input: number; output: number; cacheRead: number; cacheCreation: number }, startTime: string, endTime: string) {
  const typeMap: [string, number][] = [
    ["input", tokens.input],
    ["output", tokens.output],
    ["cacheRead", tokens.cacheRead],
    ["cacheCreation", tokens.cacheCreation],
  ];
  return {
    name: "claude_code.token.usage",
    sum: {
      aggregationTemporality: 1,
      isMonotonic: true,
      dataPoints: typeMap.map(([type, value]) => ({
        attributes: [{ key: "session.id", value: { stringValue: sessionId } }, { key: "model", value: { stringValue: "claude-sonnet-5" } }, { key: "type", value: { stringValue: type } }],
        startTimeUnixNano: startTime,
        timeUnixNano: endTime,
        asDouble: value,
      })),
    },
  };
}

suite("trajectoryUsageAttribution real CLI metric telemetry (M13D)", () => {
  let storage: DriftStorage;

  setup(() => {
    storage = openStorage(tempDbPath());
  });

  teardown(() => {
    storage.close();
  });

  test("a genuine claude_code.cost.usage occurrence is counted as one real model call", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent("s1", realCostUsageMetric("s1", 0.05, "1000", "2000"), 110);

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.sessionTotals.modelCalls, 1);
    assert.ok(Math.abs(enriched.sessionTotals.costUsd! - 0.05) < 1e-9);
  });

  test("a genuine claude_code.token.usage occurrence contributes its four token fields but is never itself counted as a model call", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent("s1", realTokenUsageMetric("s1", { input: 2, output: 126, cacheRead: 29433, cacheCreation: 10850 }, "1000", "2000"), 110);

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.sessionTotals.modelCalls, 0, "no cost.usage occurrence exists in this fixture -- token.usage alone must never manufacture a call");
    assert.strictEqual(enriched.sessionTotals.inputTokens, 2);
    assert.strictEqual(enriched.sessionTotals.outputTokens, 126);
    assert.strictEqual(enriched.sessionTotals.cacheReadTokens, 29433);
    assert.strictEqual(enriched.sessionTotals.cacheWriteTokens, 10850);
  });

  test("one real call's cost.usage + token.usage pair is counted as exactly one model call with complete usage, matching what one real claude -p turn actually emits", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent("s1", realCostUsageMetric("s1", 0.0505506, "1000", "2000"), 110);
    storage.insertModelUsageEvent("s1", realTokenUsageMetric("s1", { input: 2, output: 126, cacheRead: 29433, cacheCreation: 10850 }, "1000", "2000"), 110);

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.sessionTotals.modelCalls, 1);
    assert.strictEqual(enriched.sessionTotals.inputTokens, 2);
    assert.strictEqual(enriched.sessionTotals.outputTokens, 126);
    assert.ok(Math.abs(enriched.sessionTotals.costUsd! - 0.0505506) < 1e-9);
  });

  test("the real CLI's periodic re-export of the identical delta window is deduplicated -- never counted as additional calls or additional tokens", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    // The exact same occurrence, stored 5 times -- reproducing the real,
    // live-observed behavior of Claude Code's periodic OTEL exporter
    // re-sending an unchanged delta window on later ticks.
    for (let i = 0; i < 5; i++) {
      storage.insertModelUsageEvent("s1", realCostUsageMetric("s1", 0.05, "1000", "2000"), 110 + i);
      storage.insertModelUsageEvent("s1", realTokenUsageMetric("s1", { input: 2, output: 14, cacheRead: 100, cacheCreation: 50 }, "1000", "2000"), 110 + i);
    }

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.sessionTotals.modelCalls, 1, "5 repeated exports of the same occurrence must count as exactly 1 call");
    assert.strictEqual(enriched.sessionTotals.inputTokens, 2, "must not be 5x inflated");
    assert.strictEqual(enriched.sessionTotals.outputTokens, 14);
    assert.ok(Math.abs(enriched.sessionTotals.costUsd! - 0.05) < 1e-9);
    assert.strictEqual(enriched.sessionTotals.records.length, 10, "every stored row is still preserved for auditability, even the deduplicated ones");
  });

  test("a genuinely later, distinct call (different time window) after a repeated one is still counted separately", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    // First call, re-exported twice (duplicate).
    storage.insertModelUsageEvent("s1", realCostUsageMetric("s1", 0.05, "1000", "2000"), 110);
    storage.insertModelUsageEvent("s1", realCostUsageMetric("s1", 0.05, "1000", "2000"), 111);
    // A second, genuinely distinct call.
    storage.insertModelUsageEvent("s1", realCostUsageMetric("s1", 0.09, "3000", "4000"), 120);

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.sessionTotals.modelCalls, 2);
    assert.ok(Math.abs(enriched.sessionTotals.costUsd! - 0.14) < 1e-9);
  });

  test("real metric telemetry stays session-correlated: an identical-looking occurrence in a different session is never deduplicated against or attributed to this one", () => {
    storage.ensureSession("session-A");
    storage.ensureSession("session-B");
    storage.insertRawEvent("session-A", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertRawEvent("session-B", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);

    storage.insertModelUsageEvent("session-A", realCostUsageMetric("session-A", 0.05, "1000", "2000"), 110);
    storage.insertModelUsageEvent("session-B", realCostUsageMetric("session-B", 0.05, "1000", "2000"), 110);

    const enrichedA = attributeUsageToTrajectory(trajectoryFor("session-A", storage), storage);
    const enrichedB = attributeUsageToTrajectory(trajectoryFor("session-B", storage), storage);

    assert.strictEqual(enrichedA.sessionTotals.modelCalls, 1);
    assert.strictEqual(enrichedB.sessionTotals.modelCalls, 1, "session-B's own genuine call must not be suppressed as if it were session-A's duplicate");
  });

  test("real metric-derived usage that has no matching prompt.id stays session-level, not guessed onto a step (unchanged M7C attribution rule)", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent("s1", realCostUsageMetric("s1", 0.05, "1000", "2000"), 110);

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.steps[0].usage, undefined, "a metric never carries prompt.id, so it can never land on a step -- unchanged from before M13D");
    assert.strictEqual(enriched.sessionTotals.modelCalls, 1);
  });

  test("durationMs stays undefined for real metric-derived usage -- never reconstructed from an unrelated CLI-wide activity metric", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent("s1", realCostUsageMetric("s1", 0.05, "1000", "2000"), 110);
    storage.insertModelUsageEvent("s1", realTokenUsageMetric("s1", { input: 2, output: 14, cacheRead: 1, cacheCreation: 1 }, "1000", "2000"), 110);

    const trajectory = trajectoryFor("s1", storage);
    const enriched = attributeUsageToTrajectory(trajectory, storage);

    assert.strictEqual(enriched.sessionTotals.durationMs, undefined);
  });

  test("deterministic and non-mutating for real metric telemetry, including the repeated-export case", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent("s1", realCostUsageMetric("s1", 0.05, "1000", "2000"), 110);
    storage.insertModelUsageEvent("s1", realCostUsageMetric("s1", 0.05, "1000", "2000"), 111);

    const trajectory = trajectoryFor("s1", storage);
    const snapshotBefore = JSON.stringify(trajectory);
    const first = attributeUsageToTrajectory(trajectory, storage);
    const second = attributeUsageToTrajectory(trajectory, storage);

    assert.deepStrictEqual(first, second);
    assert.strictEqual(JSON.stringify(trajectory), snapshotBefore);
  });
});
