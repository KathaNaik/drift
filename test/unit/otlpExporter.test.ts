import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { exportTrace, buildOtlpPayload, OtlpExportConfig } from "../../src/otlpExporter";
import { OtelTrace } from "../../src/otelProjection";
import { openStorage, DriftStorage } from "../../src/storage";

function openTempStorage(): DriftStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-otlp-exporter-test-"));
  return openStorage(path.join(dir, "drift.sqlite3"));
}

function sampleTrace(traceId = "session-1"): OtelTrace {
  return {
    traceId,
    spans: [
      {
        traceId,
        spanId: "span-root",
        name: "session",
        startTimeUnixMs: 100,
        endTimeUnixMs: 300,
        attributes: { sessionId: traceId },
        events: [{ name: "SessionStart", timestampUnixMs: 100, attributes: { normalizedType: "session_start" } }],
      },
      {
        traceId,
        spanId: "span-1",
        parentSpanId: "span-root",
        name: "Read",
        startTimeUnixMs: 150,
        endTimeUnixMs: 200,
        attributes: { toolUseId: "tool-1", incomplete: false },
        events: [],
      },
    ],
  };
}

interface FakeCollector {
  port: number;
  requests: { url: string | undefined; body: unknown }[];
  close: () => Promise<void>;
}

function startFakeCollector(statusCode = 200, delayMs = 0): Promise<FakeCollector> {
  const requests: FakeCollector["requests"] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        requests.push({ url: req.url, body: raw.length > 0 ? JSON.parse(raw) : undefined });
        const respond = () => {
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify({}));
        };
        if (delayMs > 0) {
          setTimeout(respond, delayMs);
        } else {
          respond();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function neverRespondingServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(() => {
      // Intentionally never responds, to exercise the export timeout.
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

suite("otlpExporter (M6B)", () => {
  test("buildOtlpPayload produces a spec-shaped OTLP/HTTP JSON body", () => {
    const trace = sampleTrace();
    const payload = buildOtlpPayload(trace) as any;

    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    assert.strictEqual(spans.length, 2);

    // Trace/span ids must be fixed-length hex, not Drift's own readable ids.
    assert.match(spans[0].traceId, /^[0-9a-f]{32}$/);
    assert.match(spans[0].spanId, /^[0-9a-f]{16}$/);
    assert.strictEqual(spans[0].traceId, spans[1].traceId, "both spans share one trace id");
    assert.strictEqual(spans[1].parentSpanId, spans[0].spanId, "child span's parentSpanId resolves to the root span's id");

    // Timestamps are correctly rescaled to nanoseconds, as strings.
    assert.strictEqual(spans[1].startTimeUnixNano, "150000000");
    assert.strictEqual(spans[1].endTimeUnixNano, "200000000");

    // Attributes and span events are preserved.
    assert.deepStrictEqual(spans[1].attributes, [
      { key: "toolUseId", value: { stringValue: "tool-1" } },
      { key: "incomplete", value: { boolValue: false } },
    ]);
    assert.strictEqual(spans[0].events[0].name, "SessionStart");
  });

  test("buildOtlpPayload is deterministic", () => {
    const trace = sampleTrace();
    assert.deepStrictEqual(buildOtlpPayload(trace), buildOtlpPayload(trace));
  });

  test("SUCCESS: exports to a real listening collector and marks the trace exported in storage", async () => {
    const collector = await startFakeCollector(200);
    const storage = openTempStorage();
    try {
      storage.ensureSession("session-success");
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      const result = await exportTrace(sampleTrace("session-success"), config, storage);

      assert.strictEqual(result.attempted, true);
      assert.strictEqual(result.success, true);
      assert.strictEqual(collector.requests.length, 1);
      assert.strictEqual(storage.hasExportedTrace("session-success"), true);
    } finally {
      storage.close();
      await collector.close();
    }
  });

  test("ENDPOINT FAILURE: connection refused is contained and reported, without marking the trace exported", async () => {
    const storage = openTempStorage();
    try {
      storage.ensureSession("session-refused");
      const config: OtlpExportConfig = { enabled: true, endpoint: "http://127.0.0.1:1/v1/traces" };

      const result = await exportTrace(sampleTrace("session-refused"), config, storage);

      assert.strictEqual(result.attempted, true);
      assert.strictEqual(result.success, false);
      assert.ok(result.error, "a connection failure should be reported, not thrown");
      assert.strictEqual(storage.hasExportedTrace("session-refused"), false);
    } finally {
      storage.close();
    }
  });

  test("ENDPOINT FAILURE: a non-2xx response is contained and reported, without marking the trace exported", async () => {
    const collector = await startFakeCollector(500);
    const storage = openTempStorage();
    try {
      storage.ensureSession("session-500");
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      const result = await exportTrace(sampleTrace("session-500"), config, storage);

      assert.strictEqual(result.attempted, true);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, "HTTP 500");
      assert.strictEqual(storage.hasExportedTrace("session-500"), false);
    } finally {
      storage.close();
      await collector.close();
    }
  });

  test("ENDPOINT FAILURE: a hanging collector times out instead of blocking forever", async () => {
    const server = await neverRespondingServer();
    const storage = openTempStorage();
    try {
      storage.ensureSession("session-hang");
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${server.port}/v1/traces` };

      const result = await exportTrace(sampleTrace("session-hang"), config, storage, 100);

      assert.strictEqual(result.attempted, true);
      assert.strictEqual(result.success, false);
      assert.ok(result.error, "a timeout should be reported, not thrown or hung");
    } finally {
      storage.close();
      await server.close();
    }
  });

  test("DISABLED MODE: no network request is made and nothing is marked exported", async () => {
    const collector = await startFakeCollector(200);
    const storage = openTempStorage();
    try {
      storage.ensureSession("session-disabled");
      const config: OtlpExportConfig = { enabled: false, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      const result = await exportTrace(sampleTrace("session-disabled"), config, storage);

      assert.strictEqual(result.attempted, false);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.skippedReason, "disabled");
      assert.strictEqual(collector.requests.length, 0, "a disabled exporter must never reach the network");
      assert.strictEqual(storage.hasExportedTrace("session-disabled"), false);
    } finally {
      storage.close();
      await collector.close();
    }
  });

  test("enabled with no endpoint configured is also a safe no-op", async () => {
    const storage = openTempStorage();
    try {
      storage.ensureSession("session-no-endpoint");
      const config: OtlpExportConfig = { enabled: true };

      const result = await exportTrace(sampleTrace("session-no-endpoint"), config, storage);

      assert.strictEqual(result.attempted, false);
      assert.strictEqual(result.skippedReason, "no_endpoint");
    } finally {
      storage.close();
    }
  });

  test("DUPLICATE PREVENTION: exporting the same session twice only reaches the network once", async () => {
    const collector = await startFakeCollector(200);
    const storage = openTempStorage();
    try {
      storage.ensureSession("session-dup");
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      const first = await exportTrace(sampleTrace("session-dup"), config, storage);
      const second = await exportTrace(sampleTrace("session-dup"), config, storage);

      assert.strictEqual(first.success, true);
      assert.strictEqual(second.attempted, false);
      assert.strictEqual(second.skippedReason, "already_exported");
      assert.strictEqual(collector.requests.length, 1, "the collector must receive exactly one request");
    } finally {
      storage.close();
      await collector.close();
    }
  });

  test("a failed export is not marked as exported, so a later retry is still allowed", async () => {
    const storage = openTempStorage();
    let collector: FakeCollector | undefined;
    try {
      storage.ensureSession("session-retry");
      const refusedConfig: OtlpExportConfig = { enabled: true, endpoint: "http://127.0.0.1:1/v1/traces" };

      const failed = await exportTrace(sampleTrace("session-retry"), refusedConfig, storage);
      assert.strictEqual(failed.success, false);

      collector = await startFakeCollector(200);
      const workingConfig: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };
      const retried = await exportTrace(sampleTrace("session-retry"), workingConfig, storage);

      assert.strictEqual(retried.attempted, true);
      assert.strictEqual(retried.success, true);
      assert.strictEqual(collector.requests.length, 1);
    } finally {
      storage.close();
      await collector?.close();
    }
  });

  test("duplicate prevention is tracked per session, not globally", async () => {
    const collector = await startFakeCollector(200);
    const storage = openTempStorage();
    try {
      storage.ensureSession("session-x");
      storage.ensureSession("session-y");
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      await exportTrace(sampleTrace("session-x"), config, storage);
      const other = await exportTrace(sampleTrace("session-y"), config, storage);

      assert.strictEqual(other.attempted, true);
      assert.strictEqual(other.success, true);
      assert.strictEqual(collector.requests.length, 2);
    } finally {
      storage.close();
      await collector.close();
    }
  });

  test("ATOMIC CLAIM (M6B.1): two concurrent exports for the same session produce exactly one collector request, and both resolve safely", async () => {
    // Delay the response so both concurrent calls are genuinely in flight
    // at once — this is what exposed the original race.
    const collector = await startFakeCollector(200, 50);
    const storage = openTempStorage();
    try {
      storage.ensureSession("session-concurrent");
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };
      const trace = sampleTrace("session-concurrent");

      const [first, second] = await Promise.all([
        exportTrace(trace, config, storage),
        exportTrace(trace, config, storage),
      ]);

      assert.strictEqual(collector.requests.length, 1, "only one caller should ever reach the network");

      const results = [first, second];
      const winners = results.filter((r) => r.attempted);
      const losers = results.filter((r) => !r.attempted);
      assert.strictEqual(winners.length, 1, "exactly one caller wins the claim");
      assert.strictEqual(winners[0].success, true);
      assert.strictEqual(losers.length, 1, "the other caller returns without exporting");
      assert.strictEqual(losers[0].skippedReason, "already_exporting");

      assert.strictEqual(storage.hasExportedTrace("session-concurrent"), true);
    } finally {
      storage.close();
      await collector.close();
    }
  });

  test("ATOMIC CLAIM (M6B.1): different sessions may export concurrently without interfering", async () => {
    const collector = await startFakeCollector(200, 50);
    const storage = openTempStorage();
    try {
      storage.ensureSession("session-concurrent-a");
      storage.ensureSession("session-concurrent-b");
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      const [a, b] = await Promise.all([
        exportTrace(sampleTrace("session-concurrent-a"), config, storage),
        exportTrace(sampleTrace("session-concurrent-b"), config, storage),
      ]);

      assert.strictEqual(a.attempted, true);
      assert.strictEqual(a.success, true);
      assert.strictEqual(b.attempted, true);
      assert.strictEqual(b.success, true);
      assert.strictEqual(collector.requests.length, 2, "both independent sessions should reach the network");
    } finally {
      storage.close();
      await collector.close();
    }
  });

  test("ATOMIC CLAIM (M6B.1): a claimed export that fails releases its claim so a later retry is allowed", async () => {
    const storage = openTempStorage();
    let collector: FakeCollector | undefined;
    try {
      storage.ensureSession("session-claim-retry");
      const refusedConfig: OtlpExportConfig = { enabled: true, endpoint: "http://127.0.0.1:1/v1/traces" };

      const failed = await exportTrace(sampleTrace("session-claim-retry"), refusedConfig, storage);
      assert.strictEqual(failed.attempted, true);
      assert.strictEqual(failed.success, false);

      // If the claim weren't released, this retry would incorrectly be
      // skipped as "already_exporting" instead of actually attempting.
      collector = await startFakeCollector(200);
      const workingConfig: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };
      const retried = await exportTrace(sampleTrace("session-claim-retry"), workingConfig, storage);

      assert.strictEqual(retried.attempted, true);
      assert.strictEqual(retried.success, true);
      assert.notStrictEqual(retried.skippedReason, "already_exporting");
    } finally {
      storage.close();
      await collector?.close();
    }
  });

  test("DURABILITY (M6B.1): successful export state survives closing and reopening storage", async () => {
    const collector = await startFakeCollector(200);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-otlp-durability-test-"));
    const dbPath = path.join(dir, "drift.sqlite3");
    try {
      let storage = openStorage(dbPath);
      storage.ensureSession("session-durable");
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      const result = await exportTrace(sampleTrace("session-durable"), config, storage);
      assert.strictEqual(result.success, true);
      storage.close();

      // Reopen at the same path, as a fresh process/connection would.
      storage = openStorage(dbPath);
      assert.strictEqual(storage.hasExportedTrace("session-durable"), true);

      const secondAttempt = await exportTrace(sampleTrace("session-durable"), config, storage);
      assert.strictEqual(secondAttempt.attempted, false);
      assert.strictEqual(secondAttempt.skippedReason, "already_exported");
      assert.strictEqual(collector.requests.length, 1, "the reopened storage must not allow re-exporting");

      storage.close();
    } finally {
      await collector.close();
    }
  });

  test("REGRESSION (M6B.2): an abandoned lease from a simulated crash expires and becomes reclaimable, instead of blocking exports forever", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-otlp-crash-test-"));
    const dbPath = path.join(dir, "drift.sqlite3");
    let collector: FakeCollector | undefined;
    try {
      let storage = openStorage(dbPath);
      storage.ensureSession("session-crash");

      // Simulate a crash mid-export: a very short timeoutMs yields a very
      // short lease, and the process is torn down (storage closed) before
      // any success/failure handling ever runs to release it.
      storage.claimExport("session-crash", "dead-process", 20);
      storage.close();

      await new Promise((resolve) => setTimeout(resolve, 60));

      // A fresh process/connection retries the same session.
      storage = openStorage(dbPath);
      collector = await startFakeCollector(200);
      const config: OtlpExportConfig = { enabled: true, endpoint: `http://127.0.0.1:${collector.port}/v1/traces` };

      const result = await exportTrace(sampleTrace("session-crash"), config, storage, 2000);

      assert.strictEqual(result.attempted, true);
      assert.strictEqual(result.success, true, "the abandoned lease must not permanently block this session");
      assert.strictEqual(storage.hasExportedTrace("session-crash"), true);

      storage.close();
    } finally {
      await collector?.close();
    }
  });
});
