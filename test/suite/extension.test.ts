import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as driftExtension from "../../src/extension";
import { DriftSidebarProvider } from "../../src/driftSidebarProvider";
import { checkHealth, DriftRuntime } from "../../src/runtime";
import { openStorage } from "../../src/storage";
import { DRIFT_HOOK_EVENTS } from "../../src/hookInstaller";
import { normalizeRawEvent } from "../../src/normalizedEvent";

function getStatusCode(port: number, path: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on("error", reject);
  });
}

function postJson(port: number, path: string, body: unknown): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function openTempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-extension-test-"));
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

async function setDriftOtlpConfig(enabled: boolean, endpoint: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("drift");
  await config.update("otlp.enabled", enabled, vscode.ConfigurationTarget.Global);
  await config.update("otlp.endpoint", endpoint, vscode.ConfigurationTarget.Global);
}

async function resetDriftOtlpConfig(): Promise<void> {
  const config = vscode.workspace.getConfiguration("drift");
  await config.update("otlp.enabled", undefined, vscode.ConfigurationTarget.Global);
  await config.update("otlp.endpoint", undefined, vscode.ConfigurationTarget.Global);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function postFullSession(port: number, sessionId: string): Promise<void> {
  await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionStart" });
  await postJson(port, "/hooks/claude", {
    session_id: sessionId,
    hook_event_name: "UserPromptSubmit",
    prompt: "say hi",
  });
  await postJson(port, "/hooks/claude", {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    tool_use_id: "toolu_e2e_1",
  });
  await postJson(port, "/hooks/claude", {
    session_id: sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_e2e_1",
    tool_response: "hi",
  });
  await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" });
}

suite("Drift extension scaffold (M1 + M2 + M3)", () => {
  test("extension activates and starts the local runtime", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor");
    assert.ok(ext, "Drift extension not found");
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);
  });

  test("contributes an activity bar container named Drift", () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const containers = ext.packageJSON.contributes.viewsContainers.activitybar;
    assert.ok(
      containers.some((c: { id: string; title: string }) => c.id === "drift" && c.title === "Drift"),
      "Drift activity bar container not contributed"
    );
  });

  test("contributes a sidebar view inside the Drift container", () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const views = ext.packageJSON.contributes.views.drift;
    assert.ok(
      views.some((v: { id: string }) => v.id === "drift.sidebar"),
      "drift.sidebar view not contributed"
    );
  });

  test("GET /health returns 200 against the runtime the extension started", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    assert.ok(runtime, "extension did not start a runtime");

    const statusCode = await getStatusCode(runtime.port, "/health");
    assert.strictEqual(statusCode, 200);
  });

  test("contributes the drift.installClaudeHooks command", () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const commands: { command: string }[] = ext.packageJSON.contributes.commands;
    assert.ok(
      commands.some((c) => c.command === "drift.installClaudeHooks"),
      "drift.installClaudeHooks command not contributed"
    );
  });

  test("running drift.installClaudeHooks writes a real Claude hook config for the open workspace, using the running runtime's port", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    assert.ok(runtime, "extension did not start a runtime");

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "test harness did not open a workspace folder");

    const settingsPath = path.join(workspaceFolder!.uri.fsPath, ".claude", "settings.local.json");

    const registeredCommands = await vscode.commands.getCommands(true);
    assert.ok(registeredCommands.includes("drift.installClaudeHooks"), "command was not registered");

    await vscode.commands.executeCommand("drift.installClaudeHooks");

    assert.ok(fs.existsSync(settingsPath), "settings.local.json was not written");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    for (const eventName of DRIFT_HOOK_EVENTS) {
      const groups = settings.hooks[eventName];
      assert.strictEqual(groups.length, 1);
      if (eventName === "SessionStart" || eventName === "UserPromptSubmit") {
        // Claude Code does not support the "http" transport for SessionStart,
        // and does not honor an http UserPromptSubmit hook's
        // hookSpecificOutput.additionalContext the way it honors a command
        // hook's stdout (confirmed live in M12B-LIVE) -- both are delivered
        // via the command bridge instead (M4B.1, M12B.1).
        assert.strictEqual(groups[0].hooks[0].type, "command");
        assert.ok(groups[0].hooks[0].command.includes(String(runtime.port)));
      } else {
        assert.strictEqual(groups[0].hooks[0].url, `http://127.0.0.1:${runtime.port}/hooks/claude`);
      }
    }
  });

  test("opens SQLite storage under the extension's Drift-managed global storage path", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();

    const storagePath = exports.getStoragePath();
    assert.ok(storagePath, "extension did not report a storage path");
    assert.ok(
      storagePath.split(path.sep).includes("globalStorage") && storagePath.includes("kathanaik.drift-agent-monitor"),
      `storage should live under VS Code's per-extension global storage directory, got: ${storagePath}`
    );
    assert.ok(fs.existsSync(storagePath), "SQLite database file was not created");

    const storage = exports.getStorage();
    assert.ok(storage, "extension did not open storage");
  });

  test("persists a session and its ordered raw events through the running extension's storage", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const storage = exports.getStorage()!;

    const session = storage.createSession();
    storage.insertRawEvent(session.id, { kind: "second" }, 200);
    storage.insertRawEvent(session.id, { kind: "first" }, 100);

    const result = storage.getSession(session.id)!;
    assert.ok(result, "session was not persisted");
    assert.deepStrictEqual(
      result.events.map((e: { payload: unknown }) => e.payload),
      [{ kind: "first" }, { kind: "second" }]
    );
  });

  test("a real hook posted to the running extension's /hooks/claude endpoint can be read back and normalized (M5A)", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    assert.ok(runtime, "extension did not start a runtime");

    // A fresh id per run: the extension's global storage genuinely persists
    // across separate `npm test` invocations (that's real, correct behavior
    // from M3 onward), so a hardcoded session_id would accumulate events
    // across runs instead of proving this one exchange in isolation.
    const sessionId = `m5a-integration-session-${crypto.randomUUID()}`;
    const payload = {
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      cwd: "/some/project",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_use_id: "toolu_m5a_1",
    };

    const statusCode = await postJson(runtime.port, "/hooks/claude", payload);
    assert.strictEqual(statusCode, 200);

    const storage = exports.getStorage()!;
    const result = storage.getSession(sessionId);
    assert.ok(result, "hook did not create/reach a session");
    assert.strictEqual(result!.events.length, 1);

    const normalized = normalizeRawEvent(result!.events[0]);
    assert.strictEqual(normalized.sessionId, sessionId);
    assert.strictEqual(normalized.type, "tool_invocation");
    assert.strictEqual(normalized.source, "claude");
    assert.strictEqual(normalized.hookEventName, "PreToolUse");
    assert.deepStrictEqual(normalized.data, {
      cwd: "/some/project",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolUseId: "toolu_m5a_1",
    });

    // Raw persistence must be completely unaffected by normalization.
    assert.deepStrictEqual(result!.events[0].payload, payload);
  });

  test("contributes the drift.otlp.enabled and drift.otlp.endpoint settings, disabled by default (M6C)", () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const properties = ext.packageJSON.contributes.configuration.properties;
    assert.strictEqual(properties["drift.otlp.enabled"].type, "boolean");
    assert.strictEqual(properties["drift.otlp.enabled"].default, false);
    assert.strictEqual(properties["drift.otlp.endpoint"].type, "string");
  });

  test("M6C END-TO-END: a completed real session flows through normalization, trajectory, OTel projection, and OTLP export", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    assert.ok(runtime, "extension did not start a runtime");
    const storage = exports.getStorage()!;

    const collector = await startFakeCollector(200);
    try {
      await setDriftOtlpConfig(true, `http://127.0.0.1:${collector.port}/v1/traces`);

      const sessionId = `m6c-e2e-${crypto.randomUUID()}`;
      await postFullSession(runtime.port, sessionId);

      await waitUntil(() => storage.hasExportedTrace(sessionId), 3000);

      assert.strictEqual(collector.requests.length, 1);
      const payload = collector.requests[0] as any;
      const spans = payload.resourceSpans[0].scopeSpans[0].spans;
      // Root span (session lifecycle + prompt as span events) + one paired
      // tool_call span for PreToolUse/PostToolUse.
      assert.strictEqual(spans.length, 2);
    } finally {
      await resetDriftOtlpConfig();
      await collector.close();
    }
  });

  test("M6C DISABLED MODE: a completed real session makes no network request when drift.otlp.enabled is left at its default", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    assert.ok(runtime, "extension did not start a runtime");
    const storage = exports.getStorage()!;

    const collector = await startFakeCollector(200);
    try {
      // drift.otlp.enabled defaults to false; only point the endpoint at a
      // real, live collector to prove a miswired endpoint still can't leak
      // a request out while disabled.
      await setDriftOtlpConfig(false, `http://127.0.0.1:${collector.port}/v1/traces`);

      const sessionId = `m6c-disabled-${crypto.randomUUID()}`;
      await postFullSession(runtime.port, sessionId);

      // Give the fire-and-forget path a chance to run if it were (wrongly) going to.
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.strictEqual(collector.requests.length, 0, "disabled export must never reach the network");
      assert.strictEqual(storage.hasExportedTrace(sessionId), false);
      assert.ok(storage.getSession(sessionId), "the session's raw events must still be stored regardless of export");
    } finally {
      await resetDriftOtlpConfig();
      await collector.close();
    }
  });

  test("M6C: an export failure does not affect the SessionEnd hook response or the stored session data", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    assert.ok(runtime, "extension did not start a runtime");
    const storage = exports.getStorage()!;

    try {
      await setDriftOtlpConfig(true, "http://127.0.0.1:1/v1/traces");

      const sessionId = `m6c-failure-${crypto.randomUUID()}`;
      const statusCode = await postJson(runtime.port, "/hooks/claude", {
        session_id: sessionId,
        hook_event_name: "SessionEnd",
        reason: "other",
      });
      assert.strictEqual(statusCode, 200, "the hook response must succeed regardless of export outcome");

      const stored = storage.getSession(sessionId);
      assert.ok(stored, "the raw SessionEnd event must still be persisted");
      assert.strictEqual(stored!.events.length, 1);
      assert.strictEqual(storage.hasExportedTrace(sessionId), false);
    } finally {
      await resetDriftOtlpConfig();
    }
  });

  test("M6C: a duplicate SessionEnd for the same session does not duplicate the export", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    assert.ok(runtime, "extension did not start a runtime");
    const storage = exports.getStorage()!;

    const collector = await startFakeCollector(200);
    try {
      await setDriftOtlpConfig(true, `http://127.0.0.1:${collector.port}/v1/traces`);

      const sessionId = `m6c-dup-${crypto.randomUUID()}`;
      await postJson(runtime.port, "/hooks/claude", {
        session_id: sessionId,
        hook_event_name: "SessionEnd",
        reason: "other",
      });
      await waitUntil(() => storage.hasExportedTrace(sessionId), 3000);

      await postJson(runtime.port, "/hooks/claude", {
        session_id: sessionId,
        hook_event_name: "SessionEnd",
        reason: "other",
      });
      // Give a second (incorrect) export a chance to fire if it were going to.
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.strictEqual(collector.requests.length, 1, "a duplicate SessionEnd must not duplicate the export");
    } finally {
      await resetDriftOtlpConfig();
      await collector.close();
    }
  });

  test("opening the Drift sidebar shows Runtime: Online while the runtime is up", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();

    await vscode.commands.executeCommand("workbench.view.extension.drift");

    const children = exports.provider.getChildren();
    // M16: the sidebar now also surfaces model/runtime and Claude-hooks
    // setup status (see driftSidebarProvider.ts) -- the runtime row remains
    // first, but the row count grew from 1 to 3.
    assert.strictEqual(children.length, 3);
    assert.strictEqual(children[0].label, "Runtime: Online");
  });

  test("deactivate stops the runtime and sets Offline through extension logic, without a manual setStatus call", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    assert.ok(runtime, "extension did not start a runtime");

    await driftExtension.deactivate();

    const healthyAfterDeactivate = await checkHealth(runtime.port);
    assert.strictEqual(healthyAfterDeactivate, false, "runtime should be unreachable after deactivate()");

    const children = exports.provider.getChildren();
    assert.strictEqual(children[0].label, "Runtime: Offline");
  });

  test("initializeRuntimeStatus sets Offline when the runtime fails to start", async () => {
    const provider = new DriftSidebarProvider();
    const storage = openTempStorage();

    const result = await driftExtension.initializeRuntimeStatus(provider, storage, {
      startRuntime: () => Promise.reject(new Error("simulated startup failure")),
      checkHealth: () => Promise.resolve(true),
    });

    assert.strictEqual(result, undefined);
    assert.strictEqual(provider.getStatus(), "offline");
    assert.strictEqual(provider.getChildren()[0].label, "Runtime: Offline");
    storage.close();
  });

  test("initializeRuntimeStatus sets Offline when the health check fails", async () => {
    const provider = new DriftSidebarProvider();
    const storage = openTempStorage();
    const fakeRuntime: DriftRuntime = { port: 1, stop: () => Promise.resolve() };

    const result = await driftExtension.initializeRuntimeStatus(provider, storage, {
      startRuntime: () => Promise.resolve(fakeRuntime),
      checkHealth: () => Promise.resolve(false),
    });

    assert.strictEqual(result, fakeRuntime);
    assert.strictEqual(provider.getStatus(), "offline");
    assert.strictEqual(provider.getChildren()[0].label, "Runtime: Offline");
    storage.close();
  });

  test("initializeRuntimeStatus sets Online when startup and health check succeed", async () => {
    const provider = new DriftSidebarProvider();
    const storage = openTempStorage();
    const fakeRuntime: DriftRuntime = { port: 1, stop: () => Promise.resolve() };

    const result = await driftExtension.initializeRuntimeStatus(provider, storage, {
      startRuntime: () => Promise.resolve(fakeRuntime),
      checkHealth: () => Promise.resolve(true),
    });

    assert.strictEqual(result, fakeRuntime);
    assert.strictEqual(provider.getStatus(), "online");
    assert.strictEqual(provider.getChildren()[0].label, "Runtime: Online");
    storage.close();
  });
});
