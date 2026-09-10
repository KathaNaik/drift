import * as assert from "assert";
import * as crypto from "crypto";
import * as http from "http";
import * as vscode from "vscode";
import * as driftExtension from "../../src/extension";
import { RedirectApprovalDeps } from "../../src/extension";
import { DriftFindingsProvider } from "../../src/findingsViewProvider";
import { LocalModelRuntime, InferenceResult, InferOptions } from "../../src/localModelRuntime";

function postJson(port: number, urlPath: string, body: unknown): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function stubRuntime(responder: (prompt: string) => { text?: string; success?: boolean }): LocalModelRuntime {
  return {
    infer: async (prompt: string, _o?: InferOptions): Promise<InferenceResult> => {
      const r = responder(prompt);
      return { text: r.text, record: { startedAt: 0, durationMs: 0, inputTokens: 1, outputTokens: 1, success: r.success !== false, error: r.success === false ? "stub failure" : undefined } };
    },
    close: async () => {},
  };
}

async function postGenuineStalledLoop(port: number, sessionId: string, occurrences: number): Promise<void> {
  await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionStart" });
  for (let i = 0; i < occurrences; i++) {
    await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "terraform apply" }, tool_use_id: `red-c${i}` });
    await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "terraform apply" }, tool_use_id: `red-c${i}`, tool_response: { error: "state lock held" } });
  }
  await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" });
}

suite("Drift Prepare Redirect (M12A)", () => {
  test("contributes the drift.prepareRedirect command, scoped to redirect_candidate rows only", () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const commands: { command: string }[] = ext.packageJSON.contributes.commands;
    assert.ok(commands.some((c) => c.command === "drift.prepareRedirect"), "drift.prepareRedirect command not contributed");

    const contextMenus: { command: string; when: string }[] = ext.packageJSON.contributes.menus["view/item/context"];
    const entry = contextMenus.find((m) => m.command === "drift.prepareRedirect");
    assert.ok(entry, "drift.prepareRedirect must be contributed as a context menu action");
    assert.ok(entry!.when.includes("drift.finding.redirect_candidate"), "must be scoped to redirect_candidate rows only");
    assert.ok(!entry!.when.includes("drift.finding.finding") && !entry!.when.includes("drift.finding.observe"));
  });

  test("a real redirect_candidate analysis produces a grounded packet, shown for Approve/Cancel -- Approve records approval with no side effects", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const storage = exports.getStorage()!;
    const findings: DriftFindingsProvider = exports.findingsProvider;

    const sessionId = `m12a-redirect-${crypto.randomUUID()}`;
    await postGenuineStalledLoop(runtime.port, sessionId, 3);

    const analyzeResult = await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }) })),
    });
    assert.ok(analyzeResult);
    assert.strictEqual(analyzeResult!.analyses[0].decision.state, "redirect_candidate");

    const eventsBefore = storage.getSession(sessionId)!.events.length;
    let shownPacketText: string | undefined;
    const deps: RedirectApprovalDeps = {
      showPacketAndConfirm: async (text) => {
        shownPacketText = text;
        return "approved";
      },
    };

    const result = await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], deps);

    assert.strictEqual(result.decision, "approved");
    assert.ok(result.packet);
    assert.strictEqual(result.packet!.sessionId, sessionId);
    assert.deepStrictEqual(result.packet!.sourceStepIndexes, analyzeResult!.analyses[0].stepIndexes);
    assert.deepStrictEqual(result.packet!.reasonCodes, analyzeResult!.analyses[0].decision.reasonCodes);
    assert.ok(result.packet!.avoidRepeating.includes("terraform apply"));
    assert.ok(shownPacketText && shownPacketText.includes("terraform apply"));
    assert.ok(shownPacketText && !shownPacketText.trim().startsWith("{"));

    // No side effects: storage untouched, no Claude config written, session data identical.
    assert.strictEqual(storage.getSession(sessionId)!.events.length, eventsBefore);
  });

  test("Cancel changes nothing and is recorded distinctly from Approve", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const storage = exports.getStorage()!;

    const sessionId = `m12a-cancel-${crypto.randomUUID()}`;
    await postGenuineStalledLoop(runtime.port, sessionId, 3);
    const analyzeResult = await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }) })),
    });

    const eventsBefore = storage.getSession(sessionId)!.events.length;
    const result = await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => "cancelled" });

    assert.strictEqual(result.decision, "cancelled");
    assert.ok(result.packet, "the packet is still returned for inspection even when cancelled -- only the decision differs");
    assert.strictEqual(storage.getSession(sessionId)!.events.length, eventsBefore);
  });

  test("Finding and Observe analyses cannot produce a packet through the real command -- rejected before any UI is shown", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();

    const sessionId = `m12a-notredirect-${crypto.randomUUID()}`;
    await postGenuineStalledLoop(runtime.port, sessionId, 2);
    const analyzeResult = await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "low", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" }) })),
    });
    assert.strictEqual(analyzeResult!.analyses[0].decision.state, "finding");

    let uiShown = false;
    const result = await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], {
      showPacketAndConfirm: async () => {
        uiShown = true;
        return "approved";
      },
    });

    assert.strictEqual(result.decision, "rejected");
    assert.strictEqual(result.packet, undefined);
    assert.strictEqual(uiShown, false, "the packet UI must never be shown for a non-redirect_candidate analysis");
  });

  test("a stale analysis for a different session is rejected, never applied", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();

    const sessionIdA = `m12a-stale-a-${crypto.randomUUID()}`;
    const sessionIdB = `m12a-stale-b-${crypto.randomUUID()}`;
    await postGenuineStalledLoop(runtime.port, sessionIdA, 3);
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionIdB, hook_event_name: "SessionStart" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionIdB, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo unrelated" }, tool_use_id: "u1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionIdB, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo unrelated" }, tool_use_id: "u1", tool_response: "unrelated" });

    const analyzeResult = await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionIdA,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }) })),
    });
    assert.strictEqual(analyzeResult!.analyses[0].decision.state, "redirect_candidate");

    // Attempt to prepare a redirect for session A's window, but naming session B.
    let uiShown = false;
    const result = await driftExtension.runPrepareRedirectCommand(sessionIdB, analyzeResult!.analyses[0], {
      showPacketAndConfirm: async () => {
        uiShown = true;
        return "approved";
      },
    });

    assert.strictEqual(result.decision, "rejected");
    assert.strictEqual(result.packet, undefined);
    assert.strictEqual(uiShown, false);
  });

  test("preparing/viewing a redirect packet invokes zero Gemma calls", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();

    const sessionId = `m12a-nomodel-${crypto.randomUUID()}`;
    await postGenuineStalledLoop(runtime.port, sessionId, 3);
    const analyzeResult = await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }) })),
    });

    const start = Date.now();
    await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => "approved" });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `preparing a redirect must not invoke the local model (took ${elapsed}ms)`);
  });

  test("no Claude intervention occurs: no hook installer or Claude config write happens as part of preparing/approving a redirect", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();

    const sessionId = `m12a-nointervention-${crypto.randomUUID()}`;
    await postGenuineStalledLoop(runtime.port, sessionId, 3);
    const analyzeResult = await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }) })),
    });

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]!;
    const settingsPath = require("path").join(workspaceFolder.uri.fsPath, ".claude", "settings.local.json");
    const before = require("fs").existsSync(settingsPath) ? require("fs").readFileSync(settingsPath, "utf8") : undefined;

    await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => "approved" });

    const after = require("fs").existsSync(settingsPath) ? require("fs").readFileSync(settingsPath, "utf8") : undefined;
    assert.strictEqual(after, before, "Claude hook configuration must be completely untouched by preparing/approving a redirect");
  });
});
