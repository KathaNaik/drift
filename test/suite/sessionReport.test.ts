import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import * as driftExtension from "../../src/extension";
import { ViewSessionReportDeps, AnalyzeSessionDeps } from "../../src/extension";
import { DriftSessionReportProvider } from "../../src/sessionReportProvider";
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

function apiRequestPayload(attrs: Record<string, unknown>): unknown {
  return {
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
    })),
  };
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

async function postRepeatedFailureSession(port: number, sessionId: string, occurrences: number): Promise<void> {
  await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionStart" });
  for (let i = 0; i < occurrences; i++) {
    const id = `report-call-${i}`;
    await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run deploy" }, tool_use_id: id });
    await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm run deploy" }, tool_use_id: id, tool_response: { error: "timeout" } });
  }
  await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" });
}

function allFieldLabels(provider: DriftSessionReportProvider, nodes: any[]): string[] {
  const labels: string[] = [];
  for (const n of nodes) {
    const item = provider.getTreeItem(n);
    labels.push(String(item.label) + (item.description ? ` | ${item.description}` : ""));
    labels.push(...allFieldLabels(provider, provider.getChildren(n)));
  }
  return labels;
}

suite("Drift Session Report (M11C)", () => {
  test("contributes the drift.report view and drift.viewSessionReport command", () => {
    const ext = vscode.extensions.getExtension("drift.drift")!;
    const views = ext.packageJSON.contributes.views.drift;
    assert.ok(views.some((v: { id: string }) => v.id === "drift.report"), "drift.report view not contributed");
    const commands: { command: string }[] = ext.packageJSON.contributes.commands;
    assert.ok(commands.some((c) => c.command === "drift.viewSessionReport"), "drift.viewSessionReport command not contributed");
  });

  test("before any report is generated, the view shows only a placeholder", () => {
    // Fresh instance, independent of the shared extension singleton's state
    // (which other suites in this process may have already populated).
    const provider = new DriftSessionReportProvider();
    const children = provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.ok(String(provider.getTreeItem(children[0]).label).toLowerCase().includes("view session report"));
  });

  test("an analyzed real session produces a complete report: usage matches M7C exactly, Finding/Redirect counts match M10B exactly, step indexes are correct", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const storage = exports.getStorage()!;
    const reportProvider: DriftSessionReportProvider = exports.reportProvider;

    const sessionId = `m11c-complete-${crypto.randomUUID()}`;
    await postRepeatedFailureSession(runtime.port, sessionId, 3);
    storage.insertModelUsageEvent(sessionId, apiRequestPayload({ "session.id": sessionId, input_tokens: 1234, output_tokens: 88 }), Date.now());

    const analyzeResult = await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }) })),
    });
    assert.ok(analyzeResult);

    await driftExtension.runViewSessionReportCommand({ listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId });
    const report = reportProvider.getCurrentReport();
    assert.ok(report);
    assert.strictEqual(report!.sessionId, sessionId);

    // Usage totals match M7C exactly.
    assert.strictEqual(report!.usage.inputTokens, 1234);
    assert.strictEqual(report!.usage.outputTokens, 88);

    // Finding/Redirect Candidate counts match M10B exactly.
    const expectedFinding = analyzeResult!.analyses.filter((a) => a.decision.state === "finding").length;
    const expectedRedirect = analyzeResult!.analyses.filter((a) => a.decision.state === "redirect_candidate").length;
    const expectedObserve = analyzeResult!.analyses.filter((a) => a.decision.state === "observe").length;
    assert.ok(report!.findings);
    assert.strictEqual(report!.findings!.findingCount, expectedFinding);
    assert.strictEqual(report!.findings!.redirectCandidateCount, expectedRedirect);
    assert.strictEqual(report!.findings!.observeCount, expectedObserve);

    // Step indexes match the original M10B output exactly.
    assert.ok(report!.evidenceSummary);
    for (const entry of report!.evidenceSummary!) {
      const matchingWindow = analyzeResult!.analyses.find((a) => JSON.stringify(a.stepIndexes) === JSON.stringify(entry.stepIndexes));
      assert.ok(matchingWindow, `expected a real M10B window with stepIndexes ${JSON.stringify(entry.stepIndexes)}`);
    }

    // Render the whole tree and confirm it's readable, non-empty, and free of raw JSON dumps.
    const rootNodes = reportProvider.getChildren();
    const labels = allFieldLabels(reportProvider, rootNodes);
    assert.ok(labels.length > 5);
    assert.ok(!labels.some((l) => l.trim().startsWith("{")), "report must never render a raw JSON blob");
  });

  test("missing usage fields remain absent, not zero-filled, in the rendered report", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const reportProvider: DriftSessionReportProvider = exports.reportProvider;

    const sessionId = `m11c-nousage-${crypto.randomUUID()}`;
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_use_id: "u1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_use_id: "u1", tool_response: "hi" });

    await driftExtension.runViewSessionReportCommand({ listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId });
    const report = reportProvider.getCurrentReport()!;
    assert.strictEqual(report.usage.inputTokens, undefined);
    assert.strictEqual(report.usage.outputTokens, undefined);
    assert.strictEqual(report.usage.costUsd, undefined);

    const [, usageSection] = reportProvider.getChildren();
    const usageFieldLabels = reportProvider.getChildren(usageSection).map((n) => reportProvider.getTreeItem(n).label);
    assert.ok(!usageFieldLabels.some((l) => String(l).includes("Input tokens")), "an absent field must not be rendered at all, not shown as 0");
  });

  test("a session with no analysis renders safely and states that no analysis has been run", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const reportProvider: DriftSessionReportProvider = exports.reportProvider;

    const sessionId = `m11c-noanalysis-${crypto.randomUUID()}`;
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" }, tool_use_id: "r1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/x" }, tool_use_id: "r1", tool_response: "y" });

    await driftExtension.runViewSessionReportCommand({ listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId });
    const report = reportProvider.getCurrentReport()!;
    assert.strictEqual(report.findings, undefined);
    assert.strictEqual(report.evidenceSummary, undefined);

    const rootNodes = reportProvider.getChildren();
    const findingsNode = rootNodes[2];
    const item = reportProvider.getTreeItem(findingsNode);
    assert.ok(String(item.label).toLowerCase().includes("no analysis has been run"));
    // Evidence Summary section must not even be offered when there's no analysis.
    assert.strictEqual(rootNodes.length, 4, "expected summary, usage, findings, outcome only -- no evidence section without an analysis");
  });

  test("opening the report causes zero Gemma calls", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();

    const sessionId = `m11c-nomodel-${crypto.randomUUID()}`;
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo x" }, tool_use_id: "e1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo x" }, tool_use_id: "e1", tool_response: "x" });

    const start = Date.now();
    await driftExtension.runViewSessionReportCommand({ listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `viewing the report must not invoke the local model (took ${elapsed}ms)`);
  });

  test("the report never claims saved or avoided compute, and uses 'detected' terminology", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const reportProvider: DriftSessionReportProvider = exports.reportProvider;

    const sessionId = `m11c-terms-${crypto.randomUUID()}`;
    await postRepeatedFailureSession(runtime.port, sessionId, 2);
    await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "low", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" }) })),
    });
    await driftExtension.runViewSessionReportCommand({ listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId });

    const rootNodes = reportProvider.getChildren();
    const labels = allFieldLabels(reportProvider, rootNodes).join(" ").toLowerCase();
    for (const forbidden of ["avoided", "saved", "energy"]) {
      assert.ok(!labels.includes(forbidden), `report text must never contain "${forbidden}"`);
    }
    assert.ok(labels.includes("detected pattern"), "expected findings to be described as detected patterns");
  });

  test("repeated report generation replaces rather than accumulates, and never mutates storage", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const storage = exports.getStorage()!;
    const reportProvider: DriftSessionReportProvider = exports.reportProvider;

    const sessionId = `m11c-repeat-${crypto.randomUUID()}`;
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo z" }, tool_use_id: "z1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo z" }, tool_use_id: "z1", tool_response: "z" });

    const eventsBefore = storage.getSession(sessionId)!.events.length;
    const deps: ViewSessionReportDeps = { listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId };

    let firstReportJson: string | undefined;
    for (let i = 0; i < 3; i++) {
      await driftExtension.runViewSessionReportCommand(deps);
      const json = JSON.stringify(reportProvider.getCurrentReport());
      if (i === 0) firstReportJson = json;
      else assert.strictEqual(json, firstReportJson, "repeated generation for the same session must be deterministic and non-accumulating");
    }
    assert.strictEqual(storage.getSession(sessionId)!.events.length, eventsBefore, "viewing a report must never write to storage");
  });

  suite("real classification against Gemma 3 4B, feeding a real report", function () {
    const MODEL_PATH = path.join(process.cwd(), "models", "gemma-3-4b-it-IQ4_XS.gguf");
    const MODEL_PRESENT = fs.existsSync(MODEL_PATH);

    test("a report built from a real Gemma-analyzed session is complete and well-formed", async function () {
      if (!MODEL_PRESENT) this.skip();
      this.timeout(60000);

      const ext = vscode.extensions.getExtension("drift.drift")!;
      const exports = await ext.activate();
      const runtime = exports.getRuntime();
      const reportProvider: DriftSessionReportProvider = exports.reportProvider;

      const sessionId = `m11c-realmodel-${crypto.randomUUID()}`;
      await postRepeatedFailureSession(runtime.port, sessionId, 2);

      const { createLocalModelRuntime } = await import("../../src/localModelRuntime");
      const realRuntime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 60000 });
      try {
        const analyzeResult = await driftExtension.runAnalyzeSessionCommand({
          listSessions: (s) => s.listSessions(),
          pickSessionId: async () => sessionId,
          createRuntime: () => realRuntime,
        } as AnalyzeSessionDeps);
        assert.ok(analyzeResult);

        await driftExtension.runViewSessionReportCommand({ listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId });
        const report = reportProvider.getCurrentReport()!;
        assert.strictEqual(report.sessionId, sessionId);
        assert.ok(report.findings);
        assert.strictEqual(report.findings!.findingCount + report.findings!.redirectCandidateCount + report.findings!.observeCount, analyzeResult!.analyses.length);
      } finally {
        await realRuntime.close();
      }
    });
  });
});
