import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { exportSessionOnEnd } from "../../src/sessionExportPipeline";
import { openStorage, DriftStorage } from "../../src/storage";
import { OtlpExportConfig } from "../../src/otlpExporter";

function openTempStorage(): DriftStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-session-export-pipeline-test-"));
  return openStorage(path.join(dir, "drift.sqlite3"));
}

interface FakeCollector {
  port: number;
  requests: unknown[];
  close: () => Promise<void>;
}

function startFakeCollector(statusCode = 200): Promise<FakeCollector> {
  const requests: unknown[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        requests.push(raw.length > 0 ? JSON.parse(raw) : undefined);
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ port, requests, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

function seedSession(storage: DriftStorage, sessionId: string): void {
  storage.ensureSession(sessionId);
  storage.insertRawEvent(sessionId, { session_id: sessionId, hook_event_name: "SessionStart" }, 100);
  storage.insertRawEvent(
    sessionId,
    { session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "do the thing" },
    200
  );
  storage.insertRawEvent(
    sessionId,
    {
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_use_id: "toolu_1",
    },
    300
  );
  storage.insertRawEvent(
    sessionId,
    {
      session_id: sessionId,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_response: "hi",
    },
    400
  );
  storage.insertRawEvent(sessionId, { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" }, 500);
}

suite("sessionExportPipeline (M6C)", () => {
  test("runs a real persisted session through the full pipeline and exports it", async () => {
    const collector = await startFakeCollector(200);
    const storage = openTempStorage();
    try {
      seedSession(storage, "pipeline-session-1");
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      const result = await exportSessionOnEnd("pipeline-session-1", storage, config);

      assert.ok(result);
      assert.strictEqual(result!.success, true);
      assert.strictEqual(collector.requests.length, 1);

      const payload = collector.requests[0] as any;
      const spans = payload.resourceSpans[0].scopeSpans[0].spans;
      // Root span + one tool_call span for the paired PreToolUse/PostToolUse.
      assert.strictEqual(spans.length, 2);
      assert.strictEqual(storage.hasExportedTrace("pipeline-session-1"), true);
    } finally {
      storage.close();
      await collector.close();
    }
  });

  test("returns undefined for a session that has no stored events", async () => {
    const storage = openTempStorage();
    try {
      const config: OtlpExportConfig = { enabled: true, endpoint: "http://127.0.0.1:1/v1/traces" };
      const result = await exportSessionOnEnd("does-not-exist", storage, config);
      assert.strictEqual(result, undefined);
    } finally {
      storage.close();
    }
  });

  test("disabled config makes no network request", async () => {
    const collector = await startFakeCollector(200);
    const storage = openTempStorage();
    try {
      seedSession(storage, "pipeline-session-disabled");
      const config: OtlpExportConfig = { enabled: false, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      const result = await exportSessionOnEnd("pipeline-session-disabled", storage, config);

      assert.strictEqual(result?.attempted, false);
      assert.strictEqual(collector.requests.length, 0);
      assert.strictEqual(storage.hasExportedTrace("pipeline-session-disabled"), false);
    } finally {
      storage.close();
      await collector.close();
    }
  });

  test("export failure does not throw and does not affect the stored raw events", async () => {
    const storage = openTempStorage();
    try {
      seedSession(storage, "pipeline-session-failure");
      const before = storage.getSession("pipeline-session-failure")!.events;
      const config: OtlpExportConfig = { enabled: true, endpoint: "http://127.0.0.1:1/v1/traces" };

      const result = await exportSessionOnEnd("pipeline-session-failure", storage, config);

      assert.strictEqual(result?.success, false);
      const after = storage.getSession("pipeline-session-failure")!.events;
      assert.deepStrictEqual(after, before, "the stored raw events must be untouched by a failed export");
    } finally {
      storage.close();
    }
  });

  test("duplicate calls for the same session do not duplicate the export", async () => {
    const collector = await startFakeCollector(200);
    const storage = openTempStorage();
    try {
      seedSession(storage, "pipeline-session-dup");
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      const first = await exportSessionOnEnd("pipeline-session-dup", storage, config);
      const second = await exportSessionOnEnd("pipeline-session-dup", storage, config);

      assert.strictEqual(first?.success, true);
      assert.strictEqual(second?.attempted, false);
      assert.strictEqual(second?.skippedReason, "already_exported");
      assert.strictEqual(collector.requests.length, 1);
    } finally {
      storage.close();
      await collector.close();
    }
  });
});
