import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage, DriftStorage } from "../../src/storage";
import { normalizeRawEvent } from "../../src/normalizedEvent";
import { buildTrajectory } from "../../src/trajectory";
import { attributeUsageToTrajectory, TrajectoryUsage } from "../../src/trajectoryUsageAttribution";
import { RedirectPacket, formatInjectedRedirectContext } from "../../src/redirectPacket";
import { buildInterventionRecord, InterventionMeasurementInput, LocalInferenceUsage } from "../../src/interventionMeasurement";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-intervention-measurement-test-"));
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

function loadTrajectoryUsage(sessionId: string, storage: DriftStorage): TrajectoryUsage {
  const session = storage.getSession(sessionId)!;
  const normalized = session.events.map(normalizeRawEvent);
  const trajectory = buildTrajectory(sessionId, normalized);
  return attributeUsageToTrajectory(trajectory, storage);
}

function usageEventTimestamps(sessionId: string, storage: DriftStorage): Map<number, number> {
  return new Map(storage.getModelUsageEvents(sessionId).map((e) => [e.id, e.timestamp]));
}

function packetFixture(sessionId: string, sourceStepIndexes: number[]): RedirectPacket {
  return {
    sessionId,
    sourceStepIndexes,
    reasonCodes: ["strong_deterministic_signal"],
    currentState: ["Bash (npm run migrate:prod) failed"],
    avoidRepeating: "Repeated identical failing command: Bash failed 3 times",
    suggestedNextAction: "Reassess the current approach before continuing.",
  };
}

suite("interventionMeasurement (M13A)", () => {
  let storage: DriftStorage;

  setup(() => {
    storage = openStorage(tempDbPath());
  });

  teardown(() => {
    storage.close();
  });

  test("splits usage strictly at the delivery boundary and the two halves reconcile exactly with session totals", () => {
    const sessionId = "s-split";
    storage.ensureSession(sessionId);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p2" }, 300);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p3" }, 500);

    // p1's call happened well before delivery; p2's call happened exactly at
    // the delivery instant (must land in "post", never "pre"); p3's call
    // happened after.
    storage.insertModelUsageEvent(sessionId, apiRequestPayload({ "session.id": sessionId, "prompt.id": "p1", input_tokens: 10, output_tokens: 5 }), 120);
    storage.insertModelUsageEvent(sessionId, apiRequestPayload({ "session.id": sessionId, "prompt.id": "p2", input_tokens: 20, output_tokens: 8 }), 300);
    storage.insertModelUsageEvent(sessionId, apiRequestPayload({ "session.id": sessionId, "prompt.id": "p3", input_tokens: 30, output_tokens: 12 }), 520);

    const trajectoryUsage = loadTrajectoryUsage(sessionId, storage);
    const timestamps = usageEventTimestamps(sessionId, storage);
    const packet = packetFixture(sessionId, [0]);

    const input: InterventionMeasurementInput = {
      sessionId,
      packet,
      approvedAt: 250,
      deliveredAt: 300,
      trajectoryUsage,
      usageEventTimestamps: timestamps,
      localInferenceCalls: [],
      analysisDurationMs: undefined,
    };

    const result = buildInterventionRecord(input);
    assert.strictEqual(result.success, true, result.error);
    const record = result.record!;

    assert.strictEqual(record.preRedirectUsage.modelCalls, 1, "only p1's call predates deliveredAt");
    assert.strictEqual(record.preRedirectUsage.inputTokens, 10);
    assert.strictEqual(record.postRedirectUsage.modelCalls, 2, "p2 (exactly at deliveredAt) and p3 both land in post");
    assert.strictEqual(record.postRedirectUsage.inputTokens, 50);

    // Reconciliation against the full session totals.
    assert.strictEqual(record.preRedirectUsage.modelCalls + record.postRedirectUsage.modelCalls, trajectoryUsage.sessionTotals.modelCalls);
    assert.strictEqual((record.preRedirectUsage.inputTokens ?? 0) + (record.postRedirectUsage.inputTokens ?? 0), trajectoryUsage.sessionTotals.inputTokens);
    assert.strictEqual((record.preRedirectUsage.outputTokens ?? 0) + (record.postRedirectUsage.outputTokens ?? 0), trajectoryUsage.sessionTotals.outputTokens);
  });

  test("a usage record whose own timestamp cannot be found is conservatively treated as post, and reconciliation still holds", () => {
    const sessionId = "s-unknown-ts";
    storage.ensureSession(sessionId);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent(sessionId, apiRequestPayload({ "session.id": sessionId, "prompt.id": "p1", input_tokens: 10, output_tokens: 5 }), 100);

    const trajectoryUsage = loadTrajectoryUsage(sessionId, storage);
    const packet = packetFixture(sessionId, [0]);

    const input: InterventionMeasurementInput = {
      sessionId,
      packet,
      approvedAt: 50,
      deliveredAt: 60,
      trajectoryUsage,
      usageEventTimestamps: new Map(), // deliberately empty -- simulates an unresolvable timestamp
      localInferenceCalls: [],
      analysisDurationMs: undefined,
    };

    const result = buildInterventionRecord(input);
    assert.strictEqual(result.success, true, result.error);
    const record = result.record!;

    assert.strictEqual(record.preRedirectUsage.modelCalls, 0);
    assert.strictEqual(record.postRedirectUsage.modelCalls, 1);
    assert.strictEqual(record.postRedirectUsage.inputTokens, 10);
  });

  test("preserves undefined telemetry fields rather than fabricating zeros, on both sides of the boundary", () => {
    const sessionId = "s-missing-fields";
    storage.ensureSession(sessionId);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p2" }, 300);
    // Neither payload reports cost or duration.
    storage.insertModelUsageEvent(sessionId, apiRequestPayload({ "session.id": sessionId, "prompt.id": "p1", input_tokens: 10, output_tokens: 5 }), 120);
    storage.insertModelUsageEvent(sessionId, apiRequestPayload({ "session.id": sessionId, "prompt.id": "p2", input_tokens: 20, output_tokens: 8 }), 320);

    const trajectoryUsage = loadTrajectoryUsage(sessionId, storage);
    const timestamps = usageEventTimestamps(sessionId, storage);
    const packet = packetFixture(sessionId, [0]);

    const result = buildInterventionRecord({
      sessionId,
      packet,
      approvedAt: 200,
      deliveredAt: 200,
      trajectoryUsage,
      usageEventTimestamps: timestamps,
      localInferenceCalls: [],
      analysisDurationMs: undefined,
    });

    assert.strictEqual(result.success, true, result.error);
    const record = result.record!;
    assert.strictEqual(record.preRedirectUsage.costUsd, undefined);
    assert.strictEqual(record.preRedirectUsage.durationMs, undefined);
    assert.strictEqual(record.postRedirectUsage.costUsd, undefined);
    assert.strictEqual(record.postRedirectUsage.durationMs, undefined);
    assert.strictEqual(record.driftOverhead.localInferenceDurationMs, undefined, "no inference calls were supplied, so this must stay undefined, not 0");
    assert.strictEqual(record.driftOverhead.analysisDurationMs, undefined);
  });

  test("captures Drift's own overhead completely separately from the target session's usage", () => {
    const sessionId = "s-overhead";
    storage.ensureSession(sessionId);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent(sessionId, apiRequestPayload({ "session.id": sessionId, "prompt.id": "p1", input_tokens: 1000, output_tokens: 500 }), 120);

    const trajectoryUsage = loadTrajectoryUsage(sessionId, storage);
    const timestamps = usageEventTimestamps(sessionId, storage);
    const packet = packetFixture(sessionId, [0]);
    const injectedText = formatInjectedRedirectContext(packet);

    const localInferenceCalls: LocalInferenceUsage[] = [
      { durationMs: 300, inputTokens: 400, outputTokens: 50 },
      { durationMs: 250, inputTokens: 380, outputTokens: undefined },
    ];

    const result = buildInterventionRecord({
      sessionId,
      packet,
      approvedAt: 50,
      deliveredAt: 60,
      trajectoryUsage,
      usageEventTimestamps: timestamps,
      localInferenceCalls,
      analysisDurationMs: 900,
    });

    assert.strictEqual(result.success, true, result.error);
    const overhead = result.record!.driftOverhead;
    assert.strictEqual(overhead.localInferenceCount, 2);
    assert.strictEqual(overhead.localInferenceDurationMs, 550);
    assert.strictEqual(overhead.localInferenceInputTokens, 780);
    assert.strictEqual(overhead.localInferenceOutputTokens, 50, "the undefined entry must be skipped, not treated as 0");
    assert.strictEqual(overhead.analysisDurationMs, 900);
    assert.strictEqual(overhead.redirectPacketSizeBytes, Buffer.byteLength(injectedText, "utf8"));

    // Overhead must never be folded into the session's own pre/post usage.
    assert.strictEqual(result.record!.preRedirectUsage.inputTokens, undefined);
    assert.strictEqual(result.record!.postRedirectUsage.inputTokens, 1000);
  });

  test("carries the objective outcome through unchanged from the trajectory's own final tool call and SessionEnd reason", () => {
    const sessionId = "s-outcome";
    storage.ensureSession(sessionId);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertRawEvent(sessionId, { hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name: "Bash", tool_input: { command: "npm test" } }, 110);
    storage.insertRawEvent(sessionId, { hook_event_name: "PostToolUse", tool_use_id: "t1", tool_name: "Bash", tool_response: { output: "All tests passed" } }, 120);
    storage.insertRawEvent(sessionId, { hook_event_name: "SessionEnd", reason: "clear" }, 130);

    const trajectoryUsage = loadTrajectoryUsage(sessionId, storage);
    const packet = packetFixture(sessionId, [0]);

    const result = buildInterventionRecord({
      sessionId,
      packet,
      approvedAt: 50,
      deliveredAt: 60,
      trajectoryUsage,
      usageEventTimestamps: new Map(),
      localInferenceCalls: [],
      analysisDurationMs: undefined,
    });

    assert.strictEqual(result.success, true, result.error);
    assert.deepStrictEqual(result.record!.outcome.finalToolCall, { stepIndex: 2, toolName: "Bash", inputSummary: "command=npm test", outcome: "success" });
    assert.strictEqual(result.record!.outcome.sessionEndReason, "clear");
  });

  test("rejects when the packet's session does not match the requested sessionId", () => {
    const sessionId = "s-mismatch-a";
    storage.ensureSession(sessionId);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    const trajectoryUsage = loadTrajectoryUsage(sessionId, storage);
    const packet = packetFixture("some-other-session", [0]);

    const result = buildInterventionRecord({
      sessionId,
      packet,
      approvedAt: 50,
      deliveredAt: 60,
      trajectoryUsage,
      usageEventTimestamps: new Map(),
      localInferenceCalls: [],
      analysisDurationMs: undefined,
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.record, undefined);
    assert.ok(result.error?.includes("session mismatch"));
  });

  test("rejects when the trajectory's session does not match the requested sessionId", () => {
    const sessionId = "s-mismatch-b";
    const otherSessionId = "s-mismatch-b-other";
    storage.ensureSession(otherSessionId);
    storage.insertRawEvent(otherSessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    const trajectoryUsage = loadTrajectoryUsage(otherSessionId, storage);
    const packet = packetFixture(sessionId, [0]);

    const result = buildInterventionRecord({
      sessionId,
      packet,
      approvedAt: 50,
      deliveredAt: 60,
      trajectoryUsage,
      usageEventTimestamps: new Map(),
      localInferenceCalls: [],
      analysisDurationMs: undefined,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("session mismatch"));
  });

  test("rejects when deliveredAt precedes approvedAt", () => {
    const sessionId = "s-bad-order";
    storage.ensureSession(sessionId);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    const trajectoryUsage = loadTrajectoryUsage(sessionId, storage);
    const packet = packetFixture(sessionId, [0]);

    const result = buildInterventionRecord({
      sessionId,
      packet,
      approvedAt: 500,
      deliveredAt: 100,
      trajectoryUsage,
      usageEventTimestamps: new Map(),
      localInferenceCalls: [],
      analysisDurationMs: undefined,
    });

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("precedes"));
  });

  test("is deterministic and non-mutating: identical input produces identical output and leaves trajectoryUsage/packet untouched", () => {
    const sessionId = "s-deterministic";
    storage.ensureSession(sessionId);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent(sessionId, apiRequestPayload({ "session.id": sessionId, "prompt.id": "p1", input_tokens: 10, output_tokens: 5 }), 110);

    const trajectoryUsage = loadTrajectoryUsage(sessionId, storage);
    const timestamps = usageEventTimestamps(sessionId, storage);
    const packet = packetFixture(sessionId, [0]);
    const trajectorySnapshot = JSON.stringify(trajectoryUsage);
    const packetSnapshot = JSON.stringify(packet);

    const input: InterventionMeasurementInput = {
      sessionId,
      packet,
      approvedAt: 50,
      deliveredAt: 60,
      trajectoryUsage,
      usageEventTimestamps: timestamps,
      localInferenceCalls: [{ durationMs: 100, inputTokens: 20, outputTokens: 10 }],
      analysisDurationMs: 150,
    };

    const first = buildInterventionRecord(input);
    const second = buildInterventionRecord(input);
    assert.deepStrictEqual(first, second);
    assert.strictEqual(JSON.stringify(trajectoryUsage), trajectorySnapshot);
    assert.strictEqual(JSON.stringify(packet), packetSnapshot);
  });
});
