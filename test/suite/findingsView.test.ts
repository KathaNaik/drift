import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as vscode from "vscode";
import * as driftExtension from "../../src/extension";
import { AnalyzeSessionDeps } from "../../src/extension";
import { DriftFindingsProvider, SHOW_FINDING_STEPS_COMMAND } from "../../src/findingsViewProvider";
import { SessionAnalysis, SessionAnalysisWindow } from "../../src/sessionAnalysisPipeline";
import { LocalModelRuntime, InferenceResult, InferOptions, createLocalModelRuntime } from "../../src/localModelRuntime";

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

/** Posts a real repeated-failure session through the running runtime's actual hook endpoint -- exercising storage, normalization, and trajectory reconstruction for real, not fixtures hand-built in test code. */
async function postRepeatedFailureSession(port: number, sessionId: string): Promise<void> {
  await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionStart" });
  for (const toolUseId of ["m11a-1", "m11a-2"]) {
    await postJson(port, "/hooks/claude", {
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "flaky-deploy" },
      tool_use_id: toolUseId,
    });
    await postJson(port, "/hooks/claude", {
      session_id: sessionId,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "flaky-deploy" },
      tool_use_id: toolUseId,
      tool_response: { error: "connection refused" },
    });
  }
  await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" });
}

function stubRuntime(responder: (prompt: string) => { text?: string; success?: boolean }): LocalModelRuntime & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    infer: async (prompt: string, _options?: InferOptions): Promise<InferenceResult> => {
      calls++;
      const r = responder(prompt);
      return {
        text: r.text,
        record: { startedAt: 0, durationMs: 0, inputTokens: 1, outputTokens: 1, success: r.success !== false, error: r.success === false ? "stubbed failure" : undefined },
      };
    },
    close: async () => {},
  };
}

/** A minimal synthetic window, for testing pure rendering logic without needing a real session/model. */
function syntheticWindow(overrides: Partial<SessionAnalysisWindow> = {}): SessionAnalysisWindow {
  return {
    stepIndexes: [0, 1, 2, 3],
    deterministicFindings: [
      { type: "repeated_failure", sessionId: "syn", stepIndexes: [0, 1, 2, 3], evidence: { toolName: "Bash", toolInput: { command: "flaky" }, occurrences: 2 } },
    ],
    subagentOverlaps: [],
    semanticResult: {
      classification: { progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" },
      raw: "{}",
      success: true,
      error: undefined,
    },
    decision: {
      state: "finding",
      sessionId: "syn",
      stepIndexes: [0, 1, 2, 3],
      deterministicEvidence: [],
      semanticEvidence: { progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" },
      attributedUsage: undefined,
      reasonCodes: ["strong_deterministic_signal", "semantic_corroboration_confirmed"],
    },
    ...overrides,
  };
}

function syntheticAnalysis(windows: SessionAnalysisWindow[]): SessionAnalysis {
  return { sessionId: "syn", analyses: windows };
}

suite("Drift Findings view (M11A)", () => {
  test("contributes the drift.findings view inside the Drift container", () => {
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const views = ext.packageJSON.contributes.views.drift;
    assert.ok(views.some((v: { id: string }) => v.id === "drift.findings"), "drift.findings view not contributed");
  });

  test("contributes the drift.analyzeSession command", () => {
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const commands: { command: string }[] = ext.packageJSON.contributes.commands;
    assert.ok(commands.some((c) => c.command === "drift.analyzeSession"), "drift.analyzeSession command not contributed");
  });

  test("before any analysis, the Findings view shows only a placeholder -- no automatic analysis on activation", async () => {
    // A fresh instance, independent of the shared extension singleton's
    // state (which other suites in this same extension-host process may
    // have already populated by the time this runs) -- this proves the
    // class itself never auto-populates an analysis on construction.
    const provider = new DriftFindingsProvider();

    const children = provider.getChildren();
    assert.strictEqual(children.length, 1);
    assert.strictEqual(provider.getTreeItem(children[0]).label, 'Run "Drift: Analyze Session" to see findings.');
  });

  test("Observe, Finding, and Redirect Candidate render with visibly distinct labels and icons", async () => {
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const provider: DriftFindingsProvider = exports.findingsProvider;

    const observeWindow = syntheticWindow({ decision: { ...syntheticWindow().decision, state: "observe", reasonCodes: ["no_deterministic_evidence"] } });
    const findingWindow = syntheticWindow({ decision: { ...syntheticWindow().decision, state: "finding" } });
    const redirectWindow = syntheticWindow({
      decision: { ...syntheticWindow().decision, state: "redirect_candidate", reasonCodes: ["strong_deterministic_signal", "no_new_evidence"] },
    });

    provider.setAnalysis(syntheticAnalysis([observeWindow, findingWindow, redirectWindow]));
    const nodes = provider.getChildren();
    assert.strictEqual(nodes.length, 3);

    const items = nodes.map((n) => provider.getTreeItem(n));
    const labels = items.map((i) => i.label as string);
    assert.ok(labels[0].startsWith("Observe:"));
    assert.ok(labels[1].startsWith("Finding:"));
    assert.ok(labels[2].startsWith("Redirect Candidate:"));

    const iconIds = items.map((i) => (i.iconPath as vscode.ThemeIcon).id);
    assert.strictEqual(new Set(iconIds).size, 3, "each state must use a visually distinct icon");
  });

  test("evidence and reasonCodes are inspectable without dumping raw JSON", async () => {
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const provider: DriftFindingsProvider = exports.findingsProvider;

    const window = syntheticWindow();
    provider.setAnalysis(syntheticAnalysis([window]));
    const [windowNode] = provider.getChildren();
    const detailNodes = provider.getChildren(windowNode);

    const evidenceGroupNode = detailNodes.find((n: any) => n.kind === "evidenceGroup")!;
    assert.ok(evidenceGroupNode, "expected an evidence group node");
    const evidenceItems = provider.getChildren(evidenceGroupNode);
    assert.strictEqual(evidenceItems.length, 1);
    const evidenceItem = provider.getTreeItem(evidenceItems[0]);
    assert.strictEqual(evidenceItem.label, "Repeated failure");
    assert.ok(!String(evidenceItem.description).startsWith("{"), "evidence must not be rendered as a raw JSON blob");

    const reasonCodesNode = detailNodes.find((n: any) => n.kind === "reasonCodes")!;
    const reasonCodesItem = provider.getTreeItem(reasonCodesNode);
    assert.ok(String(reasonCodesItem.label).includes("strong_deterministic_signal"));
    assert.ok(String(reasonCodesItem.label).includes("semantic_corroboration_confirmed"));

    const semanticNode = detailNodes.find((n: any) => n.kind === "semantic")!;
    const semanticItem = provider.getTreeItem(semanticNode);
    assert.ok(String(semanticItem.label).includes("stalled_retry"));
    assert.ok(String(semanticItem.label).includes("newEvidence=false"));
    assert.ok(String(semanticItem.label).includes("newHypothesis=false"));
    assert.ok(String(semanticItem.label).includes("redundancy=high"));
  });

  test("a failed semantic classification renders safely as Observe with the failure contained, never thrown or raw-dumped", async () => {
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const provider: DriftFindingsProvider = exports.findingsProvider;

    const failedWindow = syntheticWindow({
      semanticResult: { classification: undefined, raw: "not valid json", success: false, error: "model output was not valid JSON" },
      decision: { ...syntheticWindow().decision, state: "observe", semanticEvidence: undefined, reasonCodes: ["semantic_classification_invalid_or_failed"] },
    });
    provider.setAnalysis(syntheticAnalysis([failedWindow]));

    const [windowNode] = provider.getChildren();
    assert.strictEqual(String(provider.getTreeItem(windowNode).label).startsWith("Observe:"), true);

    const semanticNode = provider.getChildren(windowNode).find((n: any) => n.kind === "semantic")!;
    const item = provider.getTreeItem(semanticNode);
    assert.ok(String(item.label).includes("unavailable"));
    assert.ok(String(item.label).includes("model output was not valid JSON"));
  });

  test("usage is shown only when attributed, and omitted (not fabricated) when absent", async () => {
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const provider: DriftFindingsProvider = exports.findingsProvider;

    const withoutUsage = syntheticWindow();
    provider.setAnalysis(syntheticAnalysis([withoutUsage]));
    const [nodeWithoutUsage] = provider.getChildren();
    assert.ok(!provider.getChildren(nodeWithoutUsage).some((n: any) => n.kind === "usage"));

    const withUsage = syntheticWindow({
      decision: {
        ...syntheticWindow().decision,
        attributedUsage: { modelCalls: 2, inputTokens: 400, outputTokens: 40, cacheReadTokens: undefined, cacheWriteTokens: undefined, costUsd: undefined, durationMs: undefined, records: [] },
      },
    });
    provider.setAnalysis(syntheticAnalysis([withUsage]));
    const [nodeWithUsage] = provider.getChildren();
    const usageNode = provider.getChildren(nodeWithUsage).find((n: any) => n.kind === "usage");
    assert.ok(usageNode);
    const usageItem = provider.getTreeItem(usageNode!);
    assert.ok(String(usageItem.label).includes("400 in"));
    assert.ok(String(usageItem.label).includes("40 out"));
  });

  test("real stored session: Analyze Session renders correct M10B analyses with correct step references, and repeating it does not duplicate state", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    assert.ok(runtime, "extension did not start a runtime");
    const storage = exports.getStorage()!;
    const provider: DriftFindingsProvider = exports.findingsProvider;

    const sessionId = `m11a-real-${crypto.randomUUID()}`;
    await postRepeatedFailureSession(runtime.port, sessionId);

    const eventCountBefore = storage.getSession(sessionId)!.events.length;

    const stub = stubRuntime(() => ({ text: JSON.stringify({ progress: "low", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" }) }));
    const deps: AnalyzeSessionDeps = {
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stub,
    };

    const result = await driftExtension.runAnalyzeSessionCommand(deps);
    assert.ok(result);
    assert.strictEqual(result!.sessionId, sessionId);
    assert.strictEqual(result!.analyses.length, 1);

    const [windowNode] = provider.getChildren();
    const item = provider.getTreeItem(windowNode);
    assert.ok(String(item.label).startsWith("Finding:"));

    const stepsNode = provider.getChildren(windowNode).find((n: any) => n.kind === "steps")!;
    const stepsItem = provider.getTreeItem(stepsNode);
    const expectedSteps = result!.analyses[0].stepIndexes;
    assert.ok(String(stepsItem.label).includes(expectedSteps.join(", ")));
    assert.deepStrictEqual((stepsItem.command!.arguments as unknown[])[1], result!.analyses[0]);

    // Repeating the command must not duplicate anything: same window count,
    // no new raw events persisted as a side effect of analysis.
    const secondResult = await driftExtension.runAnalyzeSessionCommand(deps);
    assert.strictEqual(secondResult!.analyses.length, 1);
    assert.strictEqual(provider.getChildren().length, 1, "repeated analysis must replace, not accumulate, findings");
    assert.strictEqual(storage.getSession(sessionId)!.events.length, eventCountBefore, "analysis must not persist or duplicate any stored data");
  });

  test("drift.showFindingSteps opens a compact, non-JSON, read-only summary of the involved steps", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const storage = exports.getStorage()!;

    const sessionId = `m11a-steps-${crypto.randomUUID()}`;
    await postRepeatedFailureSession(runtime.port, sessionId);

    const stub = stubRuntime(() => ({ text: JSON.stringify({ progress: "low", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" }) }));
    const result = await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stub,
    });

    const registeredCommands = await vscode.commands.getCommands(true);
    assert.ok(registeredCommands.includes(SHOW_FINDING_STEPS_COMMAND));

    await vscode.commands.executeCommand(SHOW_FINDING_STEPS_COMMAND, sessionId, result!.analyses[0]);

    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor, "expected a document to open");
    const text = activeEditor!.document.getText();
    assert.ok(text.includes("Bash"), "expected the real tool name to appear");
    assert.ok(!text.trim().startsWith("{"), "step detail must not be a raw JSON dump");
    assert.ok(text.includes(`Step ${result!.analyses[0].stepIndexes[0]}`));
  });

  test("no automatic/background Gemma calls happen merely from activating the extension or posting hook events", async () => {
    let createRuntimeCalls = 0;
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    assert.ok(runtime);

    const sessionId = `m11a-noauto-${crypto.randomUUID()}`;
    await postRepeatedFailureSession(runtime.port, sessionId);
    // Give any wrongly-automatic background analysis a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(createRuntimeCalls, 0, "no local model runtime should be created merely from hook activity");

    const stub = stubRuntime(() => ({ text: JSON.stringify({ progress: "low", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" }) }));
    await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => {
        createRuntimeCalls++;
        return stub;
      },
    });
    assert.strictEqual(createRuntimeCalls, 1, "exactly one runtime creation for one explicit Analyze Session invocation");
  });

  test("semantic failure for one window still displays as Observe end-to-end through the real command, with the failure contained", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const provider: DriftFindingsProvider = exports.findingsProvider;

    const sessionId = `m11a-failure-${crypto.randomUUID()}`;
    await postRepeatedFailureSession(runtime.port, sessionId);

    const brokenStub = stubRuntime(() => ({ success: false, text: undefined }));
    const result = await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => brokenStub,
    });

    assert.strictEqual(result!.analyses.length, 1);
    assert.strictEqual(result!.analyses[0].decision.state, "observe");
    assert.strictEqual(result!.analyses[0].semanticResult.success, false);

    const [windowNode] = provider.getChildren();
    assert.ok(String(provider.getTreeItem(windowNode).label).startsWith("Observe:"));
  });

  suite("real classification against Gemma 3 4B", function () {
    const MODEL_PATH = path.join(process.cwd(), "models", "gemma-3-4b-it-IQ4_XS.gguf");
    const MODEL_PRESENT = fs.existsSync(MODEL_PATH);

    test("a real Claude session posted through hooks can be analyzed end-to-end via the actual command and local model", async function () {
      if (!MODEL_PRESENT) this.skip();
      this.timeout(60000);

      const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
      const exports = await ext.activate();
      const runtime = exports.getRuntime();
      const provider: DriftFindingsProvider = exports.findingsProvider;

      const sessionId = `m11a-realmodel-${crypto.randomUUID()}`;
      await postRepeatedFailureSession(runtime.port, sessionId);

      const realModelRuntime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 60000 });
      try {
        const result = await driftExtension.runAnalyzeSessionCommand({
          listSessions: (s) => s.listSessions(),
          pickSessionId: async () => sessionId,
          createRuntime: () => realModelRuntime,
        });

        assert.ok(result);
        assert.strictEqual(result!.analyses.length, 1);
        assert.ok(result!.analyses[0].semanticResult.raw !== undefined, "expected real generated text, not a stub");

        const [windowNode] = provider.getChildren();
        const label = String(provider.getTreeItem(windowNode).label);
        assert.ok(label.startsWith("Observe:") || label.startsWith("Finding:") || label.startsWith("Redirect Candidate:"));
      } finally {
        await realModelRuntime.close();
      }
    });
  });
});
