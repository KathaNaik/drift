import * as assert from "assert";
import * as crypto from "crypto";
import * as http from "http";
import * as vscode from "vscode";
import * as driftExtension from "../../src/extension";
import { InspectSessionDeps, AnalyzeSessionDeps } from "../../src/extension";
import { DriftTrajectoryInspectorProvider, InspectorNode } from "../../src/trajectoryInspectorProvider";
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

function stepNodes(nodes: InspectorNode[]): Extract<InspectorNode, { kind: "step" }>[] {
  return nodes.filter((n): n is Extract<InspectorNode, { kind: "step" }> => n.kind === "step");
}

suite("Drift Trajectory Inspector (M11B)", () => {
  test("contributes the drift.inspector view and drift.inspectSession command", () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const views = ext.packageJSON.contributes.views.drift;
    assert.ok(views.some((v: { id: string }) => v.id === "drift.inspector"), "drift.inspector view not contributed");
    const commands: { command: string }[] = ext.packageJSON.contributes.commands;
    assert.ok(commands.some((c) => c.command === "drift.inspectSession"), "drift.inspectSession command not contributed");
  });

  test("a real stored session opens in exact trajectory order, with understandable invocation/result links, usage on the right step, and subagent identity shown", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const storage = exports.getStorage()!;
    const inspector: DriftTrajectoryInspectorProvider = exports.inspectorProvider;

    const sessionId = `m11b-order-${crypto.randomUUID()}`;
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionStart" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "run the tests" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", prompt_id: "p1", agent_id: "worker-9", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUseFailure", prompt_id: "p1", agent_id: "worker-9", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { error: "2 failing" } });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" });
    storage.insertModelUsageEvent(sessionId, apiRequestPayload({ "session.id": sessionId, "prompt.id": "p1", input_tokens: 321, output_tokens: 45 }), Date.now());

    const eventsBefore = storage.getSession(sessionId)!.events.length;

    const deps: InspectSessionDeps = { listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId };
    await driftExtension.runInspectSessionCommand(deps);

    assert.strictEqual(inspector.getCurrentSessionId(), sessionId);
    const roots = inspector.getChildren();
    const steps = stepNodes(roots);
    assert.strictEqual(steps.length, eventsBefore, "one row per real trajectory event, in exact order");
    assert.deepStrictEqual(
      steps.map((s) => s.step.index),
      steps.map((_, i) => i),
      "steps must render in exact original trajectory order (0..n-1), never reordered"
    );

    // Find the invocation and result rows and confirm the link is legible.
    const invocation = steps.find((s) => s.step.eventType === "tool_invocation")!;
    const result = steps.find((s) => s.step.eventType === "tool_result")!;
    const invocationItem = inspector.getTreeItem(invocation);
    const resultItem = inspector.getTreeItem(result);
    assert.ok(String(invocationItem.description).includes(`step ${result.step.index}`), "invocation row must point at its result step");
    assert.ok(String(resultItem.description).includes(`step ${invocation.step.index}`), "result row must point back at its invocation step");
    assert.strictEqual(invocation.step.linkedStepIndex, result.step.index);
    assert.strictEqual(result.step.linkedStepIndex, invocation.step.index);

    // Usage: only the UserPromptSubmit step should carry attributed usage.
    const promptStep = steps.find((s) => s.step.eventType === "user_prompt")!;
    assert.ok(promptStep.step.usage, "the owning prompt step must carry the attributed usage");
    assert.strictEqual(promptStep.step.usage!.inputTokens, 321);
    assert.strictEqual(promptStep.step.usage!.outputTokens, 45);
    for (const s of steps) {
      if (s.step.index !== promptStep.step.index) {
        assert.strictEqual(s.step.usage, undefined, `step ${s.step.index} must not fabricate usage it wasn't attributed`);
      }
    }

    // Subagent identity: only the agent-run steps should carry an agentId.
    assert.strictEqual(invocation.step.agentId, "worker-9");
    assert.strictEqual(result.step.agentId, "worker-9");
    const sessionStartStep = steps.find((s) => s.step.eventType === "session_start")!;
    assert.strictEqual(sessionStartStep.step.agentId, undefined, "main-thread steps must not fabricate an agentId");
  });

  test("findings highlight exactly the real M10B stepIndexes -- no more, no less", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const inspector: DriftTrajectoryInspectorProvider = exports.inspectorProvider;

    const sessionId = `m11b-overlay-${crypto.randomUUID()}`;
    // Leading unrelated read (never part of any finding), then a genuine repeated failure.
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionStart" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/README.md" }, tool_use_id: "r1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/README.md" }, tool_use_id: "r1", tool_response: "hi" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "d1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "d1", tool_response: { error: "boom" } });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "d2" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "d2", tool_response: { error: "boom" } });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" });

    const analyzeDeps: AnalyzeSessionDeps = {
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "low", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" }) })),
    };
    const analysisResult = await driftExtension.runAnalyzeSessionCommand(analyzeDeps);
    assert.ok(analysisResult);
    const expectedStepIndexes = new Set(analysisResult!.analyses[0].stepIndexes);

    const inspectDeps: InspectSessionDeps = { listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId };
    await driftExtension.runInspectSessionCommand(inspectDeps);

    const steps = stepNodes(inspector.getChildren());
    for (const s of steps) {
      if (expectedStepIndexes.has(s.step.index)) {
        assert.ok(s.window, `step ${s.step.index} is a real M10B stepIndex and must carry the analysis overlay`);
        const item = inspector.getTreeItem(s);
        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      } else {
        assert.strictEqual(s.window, undefined, `step ${s.step.index} is NOT part of the real M10B window and must not be marked`);
      }
    }

    // Selecting an analysis exposes its complete evidence and reasonCodes.
    const markedStep = steps.find((s) => s.window !== undefined)!;
    const analysisChildren = inspector.getChildren(markedStep);
    assert.strictEqual(analysisChildren.length, 1);
    assert.strictEqual(analysisChildren[0].kind, "analysis");
    const detailChildren = inspector.getChildren(analysisChildren[0]);
    const kinds = detailChildren.map((c) => c.kind);
    assert.ok(kinds.includes("evidenceGroup") && kinds.includes("semantic") && kinds.includes("reasonCodes"));
    const reasonCodesNode = detailChildren.find((c) => c.kind === "reasonCodes")!;
    const reasonCodesItem = inspector.getTreeItem(reasonCodesNode);
    assert.deepStrictEqual(String(reasonCodesItem.label).replace("Why: ", "").split(", "), analysisResult!.analyses[0].decision.reasonCodes);
  });

  test("clicking a finding in the Findings view navigates the inspector to the correct trajectory location", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const findings: DriftFindingsProvider = exports.findingsProvider;
    const inspector: DriftTrajectoryInspectorProvider = exports.inspectorProvider;

    const sessionId = `m11b-navigate-${crypto.randomUUID()}`;
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionStart" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "release" }, tool_use_id: "rl1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "release" }, tool_use_id: "rl1", tool_response: { error: "boom" } });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "release" }, tool_use_id: "rl2" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "release" }, tool_use_id: "rl2", tool_response: { error: "boom" } });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" });

    await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }) })),
    });

    const [windowNode] = findings.getChildren();
    const item = findings.getTreeItem(windowNode);
    assert.ok(item.command, "a finding row must be directly clickable");
    const [clickedSessionId, clickedStepIndex] = item.command!.arguments as [string, number];
    assert.strictEqual(clickedSessionId, sessionId);

    // Simulate the click by invoking the exact command VS Code would run.
    await vscode.commands.executeCommand(item.command!.command, clickedSessionId, clickedStepIndex);

    assert.strictEqual(inspector.getCurrentSessionId(), sessionId);
    const steps = stepNodes(inspector.getChildren());
    const targetStep = steps.find((s) => s.step.index === clickedStepIndex)!;
    assert.ok(targetStep, "the inspector must contain the exact step the finding pointed at");
    assert.ok(targetStep.window, "the target step must carry the analysis overlay after navigation");
  });

  test("inspecting a session with no analysis yet still renders its raw trajectory, with zero Gemma calls", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const inspector: DriftTrajectoryInspectorProvider = exports.inspectorProvider;

    const sessionId = `m11b-noanalysis-${crypto.randomUUID()}`;
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionStart" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x.txt" }, tool_use_id: "x1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/x.txt" }, tool_use_id: "x1", tool_response: "ok" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" });

    const start = Date.now();
    await driftExtension.runInspectSessionCommand({ listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId });
    const elapsedMs = Date.now() - start;

    const steps = stepNodes(inspector.getChildren());
    assert.strictEqual(steps.length, 4);
    for (const s of steps) assert.strictEqual(s.window, undefined, "no analysis exists yet -- nothing should be marked");
    // A real Gemma call in this suite consistently takes multiple seconds
    // (see the semanticClassifier/M9B real-model tests); inspecting must
    // complete near-instantly since it never touches the model at all.
    assert.ok(elapsedMs < 2000, `Inspect Session must not invoke the local model (took ${elapsedMs}ms)`);
  });

  test("repeated Inspect Session for the same session does not duplicate rows or mutate storage", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const storage = exports.getStorage()!;
    const inspector: DriftTrajectoryInspectorProvider = exports.inspectorProvider;

    const sessionId = `m11b-repeat-${crypto.randomUUID()}`;
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionStart" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/y.txt" }, tool_use_id: "y1" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/y.txt" }, tool_use_id: "y1", tool_response: "ok" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" });

    const eventsBefore = storage.getSession(sessionId)!.events.length;
    const deps: InspectSessionDeps = { listSessions: (s) => s.listSessions(), pickSessionId: async () => sessionId };

    for (let i = 0; i < 3; i++) {
      await driftExtension.runInspectSessionCommand(deps);
    }

    assert.strictEqual(stepNodes(inspector.getChildren()).length, 4, "repeated opens must never accumulate rows");
    assert.strictEqual(storage.getSession(sessionId)!.events.length, eventsBefore, "inspecting must never write to storage");
  });
});
