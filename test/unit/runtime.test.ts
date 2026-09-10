import * as assert from "assert";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { startRuntime, checkHealth, DriftRuntime, RedirectInjectionHook } from "../../src/runtime";
import { openStorage, DriftStorage } from "../../src/storage";

function openTempStorage(): DriftStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-runtime-test-"));
  return openStorage(path.join(dir, "drift.sqlite3"));
}

function postJson(port: number, path: string, body: unknown): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

suite("runtime (M2)", () => {
  test("GET /health returns 200 while running, and stop() shuts it down cleanly", async () => {
    const storage = openTempStorage();
    const runtime = await startRuntime(storage);
    assert.ok(runtime.port > 0);

    const healthy = await checkHealth(runtime.port);
    assert.strictEqual(healthy, true);

    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port: runtime.port, path: "/health" }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on("error", reject);
    });
    assert.strictEqual(statusCode, 200);

    await runtime.stop();

    const afterStop = await checkHealth(runtime.port);
    assert.strictEqual(afterStop, false, "runtime should be unreachable after stop()");
    storage.close();
  });
});

suite("runtime hooks endpoint (M4A)", () => {
  let storage: DriftStorage;
  let runtime: DriftRuntime;

  setup(async () => {
    storage = openTempStorage();
    runtime = await startRuntime(storage);
  });

  teardown(async () => {
    await runtime.stop();
    storage.close();
  });

  test("a valid hook payload persists as a raw event under its session", async () => {
    const payload = { session_id: "session-1", hook_event_name: "PreToolUse", tool_name: "Bash" };

    const { statusCode } = await postJson(runtime.port, "/hooks/claude", payload);
    assert.strictEqual(statusCode, 200);

    const result = storage.getSession("session-1");
    assert.ok(result, "session was not created");
    assert.strictEqual(result!.events.length, 1);
    assert.deepStrictEqual(result!.events[0].payload, payload);
  });

  test("multiple events persist under one session in order", async () => {
    await postJson(runtime.port, "/hooks/claude", {
      session_id: "session-2",
      hook_event_name: "UserPromptSubmit",
      seq: 1,
    });
    await postJson(runtime.port, "/hooks/claude", {
      session_id: "session-2",
      hook_event_name: "PreToolUse",
      seq: 2,
    });
    await postJson(runtime.port, "/hooks/claude", {
      session_id: "session-2",
      hook_event_name: "PostToolUse",
      seq: 3,
    });

    const result = storage.getSession("session-2")!;
    assert.strictEqual(result.events.length, 3);
    assert.deepStrictEqual(
      result.events.map((e) => (e.payload as { seq: number }).seq),
      [1, 2, 3]
    );
  });

  test("repeated hooks for the same session_id reuse one session rather than creating another", async () => {
    await postJson(runtime.port, "/hooks/claude", { session_id: "session-3", hook_event_name: "Stop" });
    const firstResult = storage.getSession("session-3")!;
    const createdAt = firstResult.session.createdAt;

    await postJson(runtime.port, "/hooks/claude", { session_id: "session-3", hook_event_name: "Stop" });
    const secondResult = storage.getSession("session-3")!;

    assert.strictEqual(secondResult.session.createdAt, createdAt);
    assert.strictEqual(secondResult.events.length, 2);
  });

  test("unknown or new hook_event_name values are still stored raw", async () => {
    const payload = { session_id: "session-4", hook_event_name: "SomeFutureHookType", extra: { nested: true } };

    const { statusCode } = await postJson(runtime.port, "/hooks/claude", payload);
    assert.strictEqual(statusCode, 200);

    const result = storage.getSession("session-4")!;
    assert.deepStrictEqual(result.events[0].payload, payload);
  });

  test("invalid JSON body returns 400 and persists nothing", async () => {
    const { statusCode } = await postJson(runtime.port, "/hooks/claude", "{not valid json");
    assert.strictEqual(statusCode, 400);
  });

  test("missing session_id returns 400", async () => {
    const { statusCode } = await postJson(runtime.port, "/hooks/claude", { hook_event_name: "Stop" });
    assert.strictEqual(statusCode, 400);
  });

  test("missing hook_event_name returns 400", async () => {
    const { statusCode } = await postJson(runtime.port, "/hooks/claude", { session_id: "session-5" });
    assert.strictEqual(statusCode, 400);
    assert.strictEqual(storage.getSession("session-5"), undefined);
  });

  test("events from different sessions are isolated and each keeps its own order", async () => {
    await postJson(runtime.port, "/hooks/claude", {
      session_id: "session-A",
      hook_event_name: "UserPromptSubmit",
      seq: "A1",
    });
    await postJson(runtime.port, "/hooks/claude", {
      session_id: "session-B",
      hook_event_name: "UserPromptSubmit",
      seq: "B1",
    });
    await postJson(runtime.port, "/hooks/claude", {
      session_id: "session-A",
      hook_event_name: "PreToolUse",
      seq: "A2",
    });
    await postJson(runtime.port, "/hooks/claude", {
      session_id: "session-B",
      hook_event_name: "PreToolUse",
      seq: "B2",
    });

    const resultA = storage.getSession("session-A")!;
    const resultB = storage.getSession("session-B")!;

    assert.strictEqual(resultA.session.id, "session-A");
    assert.strictEqual(resultB.session.id, "session-B");

    assert.deepStrictEqual(
      resultA.events.map((e) => (e.payload as { seq: string }).seq),
      ["A1", "A2"],
      "session-A should contain only its own events, in order"
    );
    assert.deepStrictEqual(
      resultB.events.map((e) => (e.payload as { seq: string }).seq),
      ["B1", "B2"],
      "session-B should contain only its own events, in order"
    );
  });

  test("success response contains no decision or context fields for Claude", async () => {
    const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", {
      session_id: "session-6",
      hook_event_name: "Stop",
    });
    assert.strictEqual(statusCode, 200);
    const parsed = JSON.parse(body);
    assert.deepStrictEqual(parsed, { status: "ok" });
  });
});

suite("runtime SessionEnd wiring (M6C)", () => {
  test("invokes onSessionEnd with the session_id for SessionEnd hooks, after the response is already sent", async () => {
    const storage = openTempStorage();
    let received: string | undefined;
    let notifyReceived: () => void = () => {};
    const receivedPromise = new Promise<void>((resolve) => {
      notifyReceived = resolve;
    });

    const runtime = await startRuntime(storage, (sessionId) => {
      received = sessionId;
      notifyReceived();
    });

    try {
      const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", {
        session_id: "session-end-1",
        hook_event_name: "SessionEnd",
      });
      assert.strictEqual(statusCode, 200);
      assert.deepStrictEqual(JSON.parse(body), { status: "ok" });

      await receivedPromise;
      assert.strictEqual(received, "session-end-1");
    } finally {
      await runtime.stop();
      storage.close();
    }
  });

  test("does not invoke onSessionEnd for non-SessionEnd hooks", async () => {
    const storage = openTempStorage();
    let invoked = false;
    const runtime = await startRuntime(storage, () => {
      invoked = true;
    });

    try {
      await postJson(runtime.port, "/hooks/claude", { session_id: "s1", hook_event_name: "PreToolUse" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(invoked, false);
    } finally {
      await runtime.stop();
      storage.close();
    }
  });

  test("a listener that throws synchronously does not affect the hook response", async () => {
    const storage = openTempStorage();
    const runtime = await startRuntime(storage, () => {
      throw new Error("boom");
    });

    try {
      const { statusCode } = await postJson(runtime.port, "/hooks/claude", {
        session_id: "s1",
        hook_event_name: "SessionEnd",
      });
      assert.strictEqual(statusCode, 200);
    } finally {
      await runtime.stop();
      storage.close();
    }
  });

  test("a listener whose returned promise rejects does not crash the process or affect the hook response", async () => {
    const storage = openTempStorage();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    const runtime = await startRuntime(storage, async () => {
      throw new Error("async boom");
    });

    try {
      const { statusCode } = await postJson(runtime.port, "/hooks/claude", {
        session_id: "s1",
        hook_event_name: "SessionEnd",
      });
      assert.strictEqual(statusCode, 200);

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepStrictEqual(
        unhandledRejections,
        [],
        "the rejection must be contained, never surfacing as an unhandled rejection"
      );
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
      await runtime.stop();
      storage.close();
    }
  });
});

suite("runtime OTLP telemetry ingestion (M7A)", () => {
  let storage: DriftStorage;
  let runtime: DriftRuntime;
  let dbPath: string;

  setup(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-runtime-test-"));
    dbPath = path.join(dir, "drift.sqlite3");
    storage = openStorage(dbPath);
    runtime = await startRuntime(storage);
  });

  teardown(async () => {
    await runtime.stop();
    storage.close();
  });

  function apiRequestLogsPayload(sessionId: string, extraAttributes: { key: string; value: unknown }[] = []) {
    return {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "claude_code.api_request",
                  attributes: [
                    { key: "model", value: { stringValue: "claude-sonnet-5" } },
                    { key: "session.id", value: { stringValue: sessionId } },
                    { key: "input_tokens", value: { intValue: "10" } },
                    { key: "output_tokens", value: { intValue: "5" } },
                    ...extraAttributes,
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  test("a valid claude_code.api_request OTLP logs payload persists locally, associated with the session", async () => {
    const { statusCode } = await postJson(runtime.port, "/v1/logs", apiRequestLogsPayload("session-t1"));
    assert.strictEqual(statusCode, 200);

    const events = storage.getModelUsageEvents("session-t1");
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].sessionId, "session-t1");
  });

  test("multiple model calls for one session remain ordered", async () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "claude_code.api_request",
                  attributes: [
                    { key: "session.id", value: { stringValue: "session-t2" } },
                    { key: "request_id", value: { stringValue: "req-1" } },
                  ],
                },
                {
                  eventName: "claude_code.api_request",
                  attributes: [
                    { key: "session.id", value: { stringValue: "session-t2" } },
                    { key: "request_id", value: { stringValue: "req-2" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    await postJson(runtime.port, "/v1/logs", payload);
    await postJson(runtime.port, "/v1/logs", apiRequestLogsPayload("session-t2"));

    const events = storage.getModelUsageEvents("session-t2");
    assert.strictEqual(events.length, 3);
    const requestIds = events.map((e) => {
      const attrs = (e.payload as any).attributes as { key: string; value: any }[];
      return attrs.find((a) => a.key === "request_id")?.value?.stringValue;
    });
    assert.deepStrictEqual(requestIds, ["req-1", "req-2", undefined]);
  });

  test("different sessions' telemetry remains isolated", async () => {
    await postJson(runtime.port, "/v1/logs", apiRequestLogsPayload("session-tA"));
    await postJson(runtime.port, "/v1/logs", apiRequestLogsPayload("session-tB"));

    assert.strictEqual(storage.getModelUsageEvents("session-tA").length, 1);
    assert.strictEqual(storage.getModelUsageEvents("session-tB").length, 1);
  });

  test("missing optional usage fields do not break ingestion", async () => {
    // Only "model" is present -- no tokens, no cost, no request id, no session.
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { eventName: "claude_code.api_request", attributes: [{ key: "model", value: { stringValue: "x" } }] },
              ],
            },
          ],
        },
      ],
    };

    const { statusCode, body } = await postJson(runtime.port, "/v1/logs", payload);
    assert.strictEqual(statusCode, 200);
    assert.deepStrictEqual(JSON.parse(body), { status: "ok" });
  });

  test("unknown telemetry fields are preserved raw", async () => {
    await postJson(
      runtime.port,
      "/v1/logs",
      apiRequestLogsPayload("session-t3", [{ key: "some_future_field", value: { stringValue: "unexpected" } }])
    );

    const events = storage.getModelUsageEvents("session-t3");
    const attrs = (events[0].payload as any).attributes as { key: string; value: any }[];
    assert.ok(attrs.some((a) => a.key === "some_future_field" && a.value.stringValue === "unexpected"));
  });

  test("telemetry with no session.id is still persisted, with a null session association", async () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { eventName: "claude_code.api_request", attributes: [{ key: "model", value: { stringValue: "x" } }] },
              ],
            },
          ],
        },
      ],
    };

    const { statusCode } = await postJson(runtime.port, "/v1/logs", payload);
    assert.strictEqual(statusCode, 200);

    // No session id to look up by via the DriftStorage API, so verify the
    // row landed correctly by reading the database directly.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT session_id, payload FROM model_usage_events WHERE session_id IS NULL").all();
    db.close();

    assert.strictEqual(rows.length, 1);
    const persistedPayload = JSON.parse(rows[0].payload as string);
    assert.strictEqual(persistedPayload.eventName, "claude_code.api_request");
  });

  test("a claude_code.token.usage OTLP metrics payload persists and is associated with the session", async () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  unit: "tokens",
                  sum: {
                    dataPoints: [
                      {
                        asInt: "42",
                        attributes: [
                          { key: "type", value: { stringValue: "input" } },
                          { key: "session.id", value: { stringValue: "session-t4" } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const { statusCode } = await postJson(runtime.port, "/v1/metrics", payload);
    assert.strictEqual(statusCode, 200);

    const events = storage.getModelUsageEvents("session-t4");
    assert.strictEqual(events.length, 1);
  });

  test("invalid JSON body returns 400 on both telemetry endpoints", async () => {
    const logsResult = await postJson(runtime.port, "/v1/logs", "{not valid json");
    assert.strictEqual(logsResult.statusCode, 400);

    const metricsResult = await postJson(runtime.port, "/v1/metrics", "{not valid json");
    assert.strictEqual(metricsResult.statusCode, 400);
  });

  test("a batch with no recognizable Claude Code telemetry is a harmless no-op", async () => {
    const { statusCode } = await postJson(runtime.port, "/v1/logs", { resourceLogs: [] });
    assert.strictEqual(statusCode, 200);
  });
});

suite("runtime UserPromptSubmit redirect injection (M12B)", () => {
  function fakeInjectionHook(overrides: Partial<RedirectInjectionHook> = {}): RedirectInjectionHook & { getCalls: string[]; consumedCalls: string[] } {
    const getCalls: string[] = [];
    const consumedCalls: string[] = [];
    return {
      getCalls,
      consumedCalls,
      getInjectableContext: (sessionId) => {
        getCalls.push(sessionId);
        return overrides.getInjectableContext ? overrides.getInjectableContext(sessionId) : undefined;
      },
      markConsumed: (sessionId) => {
        consumedCalls.push(sessionId);
        overrides.markConsumed?.(sessionId);
      },
    };
  }

  test("no injection hook provided: UserPromptSubmit still gets the plain ack, unaffected", async () => {
    const storage = openTempStorage();
    const runtime = await startRuntime(storage);
    try {
      const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "hi" });
      assert.strictEqual(statusCode, 200);
      assert.deepStrictEqual(JSON.parse(body), { status: "ok" });
    } finally {
      await runtime.stop();
      storage.close();
    }
  });

  test("injection hook returns undefined (nothing eligible): plain ack, markConsumed never called", async () => {
    const storage = openTempStorage();
    const hook = fakeInjectionHook();
    const runtime = await startRuntime(storage, undefined, hook);
    try {
      const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", { session_id: "s2", hook_event_name: "UserPromptSubmit", prompt: "hi" });
      assert.strictEqual(statusCode, 200);
      assert.deepStrictEqual(JSON.parse(body), { status: "ok" });
      assert.deepStrictEqual(hook.getCalls, ["s2"]);
      assert.deepStrictEqual(hook.consumedCalls, []);
    } finally {
      await runtime.stop();
      storage.close();
    }
  });

  test("injection hook returns context: response carries the exact real Claude Code hookSpecificOutput.additionalContext shape, and markConsumed is called for the same session", async () => {
    const storage = openTempStorage();
    const hook = fakeInjectionHook({ getInjectableContext: (sessionId) => (sessionId === "s3" ? "DRIFT REDIRECT\n\nCurrent state:\n- x failed" : undefined) });
    const runtime = await startRuntime(storage, undefined, hook);
    try {
      const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", { session_id: "s3", hook_event_name: "UserPromptSubmit", prompt: "hi" });
      assert.strictEqual(statusCode, 200);
      const parsed = JSON.parse(body);
      assert.deepStrictEqual(parsed, {
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ["DRIFT REDIRECT\n\nCurrent state:\n- x failed"] },
      });
      assert.deepStrictEqual(hook.consumedCalls, ["s3"]);
    } finally {
      await runtime.stop();
      storage.close();
    }
  });

  test("getInjectableContext throwing falls back to the plain ack -- never corrupts the hook response, and markConsumed is never called", async () => {
    const storage = openTempStorage();
    const hook = fakeInjectionHook({
      getInjectableContext: () => {
        throw new Error("boom");
      },
    });
    const runtime = await startRuntime(storage, undefined, hook);
    try {
      const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", { session_id: "s4", hook_event_name: "UserPromptSubmit", prompt: "hi" });
      assert.strictEqual(statusCode, 200, "Claude's session must continue normally even when injection lookup fails");
      assert.deepStrictEqual(JSON.parse(body), { status: "ok" });
      assert.deepStrictEqual(hook.consumedCalls, [], "a failed lookup must never be marked consumed -- it must remain retryable");
    } finally {
      await runtime.stop();
      storage.close();
    }
  });

  test("markConsumed throwing does not affect the already-sent response or crash the server", async () => {
    const storage = openTempStorage();
    const hook = fakeInjectionHook({
      getInjectableContext: () => "some guidance",
      markConsumed: () => {
        throw new Error("bookkeeping failure");
      },
    });
    const runtime = await startRuntime(storage, undefined, hook);
    try {
      const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", { session_id: "s5", hook_event_name: "UserPromptSubmit", prompt: "hi" });
      assert.strictEqual(statusCode, 200);
      const parsed = JSON.parse(body);
      assert.deepStrictEqual(parsed.hookSpecificOutput.additionalContext, ["some guidance"]);

      // The server must still be alive and answering after a markConsumed failure.
      const healthy = await checkHealth(runtime.port);
      assert.strictEqual(healthy, true);
    } finally {
      await runtime.stop();
      storage.close();
    }
  });

  test("injection is only ever attempted for UserPromptSubmit -- other hook events never call getInjectableContext, even when eligible", async () => {
    const storage = openTempStorage();
    const hook = fakeInjectionHook({ getInjectableContext: () => "should never be used here" });
    const runtime = await startRuntime(storage, undefined, hook);
    try {
      for (const eventName of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop", "Stop"]) {
        const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", { session_id: "s6", hook_event_name: eventName });
        assert.strictEqual(statusCode, 200);
        assert.deepStrictEqual(JSON.parse(body), { status: "ok" }, `${eventName} must never receive injected context`);
      }
      assert.deepStrictEqual(hook.getCalls, [], "getInjectableContext must only ever be called for UserPromptSubmit");
    } finally {
      await runtime.stop();
      storage.close();
    }
  });

  test("getInjectableContext is called with the exact session_id from the hook payload, isolating sessions from each other", async () => {
    const storage = openTempStorage();
    const hook = fakeInjectionHook({ getInjectableContext: (sessionId) => (sessionId === "session-only-one" ? "guidance for one" : undefined) });
    const runtime = await startRuntime(storage, undefined, hook);
    try {
      const other = await postJson(runtime.port, "/hooks/claude", { session_id: "session-other", hook_event_name: "UserPromptSubmit" });
      assert.deepStrictEqual(JSON.parse(other.body), { status: "ok" }, "a different session must never receive another session's injection");

      const target = await postJson(runtime.port, "/hooks/claude", { session_id: "session-only-one", hook_event_name: "UserPromptSubmit" });
      assert.deepStrictEqual(JSON.parse(target.body).hookSpecificOutput.additionalContext, ["guidance for one"]);

      assert.deepStrictEqual(hook.consumedCalls, ["session-only-one"]);
    } finally {
      await runtime.stop();
      storage.close();
    }
  });
});
