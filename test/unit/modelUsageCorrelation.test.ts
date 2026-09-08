import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage, DriftStorage } from "../../src/storage";
import { correlateModelUsageEvent, correlateModelUsageForSession } from "../../src/modelUsageCorrelation";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-correlation-test-"));
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

function hookEvent(promptId: string): unknown {
  return { prompt_id: promptId, hook_event_name: "UserPromptSubmit" };
}

suite("modelUsageCorrelation (M7B)", () => {
  let storage: DriftStorage;

  setup(() => {
    storage = openStorage(tempDbPath());
  });

  teardown(() => {
    storage.close();
  });

  test("correlates sessionId when the session has real hook events", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", hookEvent("p1"), 50);
    const event = storage.insertModelUsageEvent("s1", apiRequestPayload({ "session.id": "s1" }), 100);

    const result = correlateModelUsageEvent(event, storage);
    assert.strictEqual(result.sessionId, "s1");
  });

  test("does not correlate sessionId when the session has no hook events (telemetry-only stub session)", () => {
    storage.ensureSession("s1");
    const event = storage.insertModelUsageEvent("s1", apiRequestPayload({ "session.id": "s1" }), 100);

    const result = correlateModelUsageEvent(event, storage);
    assert.strictEqual(result.sessionId, undefined);
  });

  test("does not correlate sessionId when no session exists at all", () => {
    const event = storage.insertModelUsageEvent(null, apiRequestPayload({}), 100);

    const result = correlateModelUsageEvent(event, storage);
    assert.strictEqual(result.sessionId, undefined);
  });

  test("correlates promptId when it matches a known prompt_id from that session's hook events", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", hookEvent("p1"), 50);
    const event = storage.insertModelUsageEvent("s1", apiRequestPayload({ "session.id": "s1", "prompt.id": "p1" }), 100);

    const result = correlateModelUsageEvent(event, storage);
    assert.strictEqual(result.promptId, "p1");
  });

  test("does not correlate promptId when it doesn't match any known hook-derived prompt_id", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", hookEvent("p1"), 50);
    const event = storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "unknown-prompt" }),
      100
    );

    const result = correlateModelUsageEvent(event, storage);
    assert.strictEqual(result.promptId, undefined);
  });

  test("correlates requestId/clientRequestId when present, without hook-side validation", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", hookEvent("p1"), 50);
    const event = storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", request_id: "req-1", client_request_id: "creq-1" }),
      100
    );

    const result = correlateModelUsageEvent(event, storage);
    assert.strictEqual(result.requestId, "req-1");
    assert.strictEqual(result.clientRequestId, "creq-1");
  });

  test("requestId/clientRequestId are undefined when absent", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", hookEvent("p1"), 50);
    const event = storage.insertModelUsageEvent("s1", apiRequestPayload({ "session.id": "s1" }), 100);

    const result = correlateModelUsageEvent(event, storage);
    assert.strictEqual(result.requestId, undefined);
    assert.strictEqual(result.clientRequestId, undefined);
  });

  test("metrics-derived telemetry has no promptId/requestId/clientRequestId but session correlation still works", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", hookEvent("p1"), 50);
    // A verbatim metric object (per M7A.1) has no top-level `attributes` field.
    const metricPayload = {
      name: "claude_code.token.usage",
      sum: { dataPoints: [{ attributes: [{ key: "session.id", value: { stringValue: "s1" } }] }] },
    };
    const event = storage.insertModelUsageEvent("s1", metricPayload, 100);

    const result = correlateModelUsageEvent(event, storage);
    assert.strictEqual(result.sessionId, "s1");
    assert.strictEqual(result.promptId, undefined);
    assert.strictEqual(result.requestId, undefined);
    assert.strictEqual(result.clientRequestId, undefined);
  });

  test("preserves unmatched telemetry as an undefined-fields correlation result (batch length matches input length)", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", hookEvent("p1"), 50);
    storage.insertModelUsageEvent("s1", apiRequestPayload({ "session.id": "s1" }), 100);
    storage.insertModelUsageEvent(null, apiRequestPayload({}), 200);

    const results = correlateModelUsageForSession("s1", storage);
    // getModelUsageEvents is scoped to "s1", so the null-session event is
    // simply not in this list — not silently dropped from the system,
    // just outside the query's own scope, same as storage.getModelUsageEvents.
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].sessionId, "s1");
  });

  test("multiple model calls under one prompt remain individually represented", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", hookEvent("p1"), 50);
    storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", request_id: "req-1" }),
      100
    );
    storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", request_id: "req-2" }),
      150
    );

    const results = correlateModelUsageForSession("s1", storage);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].promptId, "p1");
    assert.strictEqual(results[1].promptId, "p1");
    assert.strictEqual(results[0].requestId, "req-1");
    assert.strictEqual(results[1].requestId, "req-2");
    assert.notStrictEqual(results[0].modelUsageEventId, results[1].modelUsageEventId);
  });

  test("cross-session isolation: telemetry from session A never affects session B's correlation", () => {
    storage.ensureSession("session-A");
    storage.ensureSession("session-B");
    storage.insertRawEvent("session-A", hookEvent("p1"), 50);
    // session-B deliberately has NO hook events.
    storage.insertModelUsageEvent("session-A", apiRequestPayload({ "session.id": "session-A", "prompt.id": "p1" }), 100);
    storage.insertModelUsageEvent("session-B", apiRequestPayload({ "session.id": "session-B", "prompt.id": "p1" }), 100);

    const resultsA = correlateModelUsageForSession("session-A", storage);
    const resultsB = correlateModelUsageForSession("session-B", storage);

    assert.strictEqual(resultsA[0].sessionId, "session-A");
    assert.strictEqual(resultsA[0].promptId, "p1");
    assert.strictEqual(resultsB[0].sessionId, undefined, "session-B has no hook events, so it must not correlate");
    assert.strictEqual(resultsB[0].promptId, undefined);
  });

  test("correlation is deterministic", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", hookEvent("p1"), 50);
    const event = storage.insertModelUsageEvent(
      "s1",
      apiRequestPayload({ "session.id": "s1", "prompt.id": "p1", request_id: "req-1" }),
      100
    );

    const first = correlateModelUsageEvent(event, storage);
    const second = correlateModelUsageEvent(event, storage);
    assert.deepStrictEqual(first, second);
  });

  test("does not mutate its inputs", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", hookEvent("p1"), 50);
    const payload = apiRequestPayload({ "session.id": "s1", "prompt.id": "p1" });
    const event = storage.insertModelUsageEvent("s1", payload, 100);
    const snapshotBefore = JSON.stringify(event);

    correlateModelUsageEvent(event, storage);

    assert.strictEqual(JSON.stringify(event), snapshotBefore);
  });
});
