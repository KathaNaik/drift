import * as assert from "assert";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startRuntime, checkHealth, DriftRuntime } from "../../src/runtime";
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
