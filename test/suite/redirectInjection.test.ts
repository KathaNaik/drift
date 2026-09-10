import * as assert from "assert";
import * as crypto from "crypto";
import * as http from "http";
import * as vscode from "vscode";
import * as driftExtension from "../../src/extension";
import { AnalyzeSessionDeps } from "../../src/extension";
import { formatInjectedRedirectContext } from "../../src/redirectPacket";
import { LocalModelRuntime, InferenceResult, InferOptions } from "../../src/localModelRuntime";

function postJson(port: number, urlPath: string, body: unknown): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
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

async function postGenuineStalledLoop(port: number, sessionId: string, occurrences: number, command: string, errorText: string): Promise<void> {
  await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionStart" });
  for (let i = 0; i < occurrences; i++) {
    await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: `inj-c${i}` });
    await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, tool_use_id: `inj-c${i}`, tool_response: { error: errorText } });
  }
  await postJson(port, "/hooks/claude", { session_id: sessionId, hook_event_name: "SessionEnd", reason: "other" });
}

async function analyzeAndPrepareApprovedRedirect(
  port: number,
  sessionId: string,
  command: string,
  errorText: string
): Promise<{ analyzeResult: Awaited<ReturnType<typeof driftExtension.runAnalyzeSessionCommand>> }> {
  await postGenuineStalledLoop(port, sessionId, 3, command, errorText);
  const analyzeResult = await driftExtension.runAnalyzeSessionCommand({
    listSessions: (s) => s.listSessions(),
    pickSessionId: async () => sessionId,
    createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }) })),
  } as AnalyzeSessionDeps);
  assert.strictEqual(analyzeResult!.analyses[0].decision.state, "redirect_candidate");
  return { analyzeResult };
}

suite("Drift Approved Redirect Injection (M12B)", () => {
  test("an approved packet injects into the correct session's next UserPromptSubmit, with content exactly reflecting the approved packet, then becomes consumed", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const redirectLifecycle = exports.redirectLifecycle;

    const sessionId = `m12b-inject-${crypto.randomUUID()}`;
    const { analyzeResult } = await analyzeAndPrepareApprovedRedirect(runtime.port, sessionId, "rake db:migrate", "PG::ConnectionBad");

    const prepResult = await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => "approved" });
    assert.strictEqual(prepResult.decision, "approved");
    assert.strictEqual(redirectLifecycle.getState(sessionId), "approved");

    const expectedContent = formatInjectedRedirectContext(prepResult.packet!);

    const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "what next?" });
    assert.strictEqual(statusCode, 200);
    const parsed = JSON.parse(body);
    assert.deepStrictEqual(parsed, { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: [expectedContent] } });

    assert.strictEqual(redirectLifecycle.getState(sessionId), "consumed", "successful delivery must become consumed");
  });

  test("no raw/internal Drift data leaks into the real injected HTTP response", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();

    const sessionId = `m12b-noleak-${crypto.randomUUID()}`;
    const { analyzeResult } = await analyzeAndPrepareApprovedRedirect(runtime.port, sessionId, "terraform destroy", "resource lock");
    const prepResult = await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => "approved" });

    const { body } = await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "UserPromptSubmit" });
    const injectedText = JSON.parse(body).hookSpecificOutput.additionalContext[0] as string;

    assert.ok(!injectedText.includes(sessionId), "sessionId must never leak into injected context");
    for (const code of prepResult.packet!.reasonCodes) {
      assert.ok(!injectedText.includes(code), `reasonCode "${code}" must never leak into injected context`);
    }
    assert.ok(!/inputTokens|outputTokens|modelCalls/.test(injectedText), "token statistics must never leak into injected context");
    assert.ok(!injectedText.includes(JSON.stringify(prepResult.packet!.sourceStepIndexes)), "raw step indexes must not appear verbatim");
  });

  test("unapproved (merely prepared) packet cannot inject", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const redirectLifecycle = exports.redirectLifecycle;

    const sessionId = `m12b-unapproved-${crypto.randomUUID()}`;
    const { analyzeResult } = await analyzeAndPrepareApprovedRedirect(runtime.port, sessionId, "helm rollback", "revision not found");
    // Cancel here would remove it entirely; to test "merely prepared", we must
    // observe the state right after generation, before any Approve/Cancel
    // decision is recorded. Since runPrepareRedirectCommand always resolves
    // the decision synchronously via deps, we simulate "never decided" by
    // never calling it and preparing the tracked state directly via a
    // pending (never-resolving-until-checked) deps callback instead: call
    // it with a deferred promise, check state mid-flight, then resolve.
    let resolveChoice!: (choice: "approved" | "cancelled") => void;
    const choicePromise = new Promise<"approved" | "cancelled">((resolve) => {
      resolveChoice = resolve;
    });
    const prepPromise = driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => choicePromise });

    // Give the command a tick to reach "prepared" (which happens synchronously before awaiting the UI).
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(redirectLifecycle.getState(sessionId), "prepared", "sanity: tracked as prepared, not yet decided");

    const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "UserPromptSubmit" });
    assert.strictEqual(statusCode, 200);
    assert.deepStrictEqual(JSON.parse(body), { status: "ok" }, "an unapproved (merely prepared) packet must never inject");

    resolveChoice("approved");
    await prepPromise;
  });

  test("a cancelled packet cannot inject", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const redirectLifecycle = exports.redirectLifecycle;

    const sessionId = `m12b-cancelled-${crypto.randomUUID()}`;
    const { analyzeResult } = await analyzeAndPrepareApprovedRedirect(runtime.port, sessionId, "npm publish", "403 forbidden");
    await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => "cancelled" });
    assert.strictEqual(redirectLifecycle.getState(sessionId), "cancelled");

    const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "UserPromptSubmit" });
    assert.strictEqual(statusCode, 200);
    assert.deepStrictEqual(JSON.parse(body), { status: "ok" });
  });

  test("a consumed packet cannot inject twice", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const redirectLifecycle = exports.redirectLifecycle;

    const sessionId = `m12b-oneshot-${crypto.randomUUID()}`;
    const { analyzeResult } = await analyzeAndPrepareApprovedRedirect(runtime.port, sessionId, "circleci trigger", "quota exceeded");
    await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => "approved" });

    const first = await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "UserPromptSubmit" });
    assert.ok((JSON.parse(first.body) as any).hookSpecificOutput, "first prompt must receive the injection");
    assert.strictEqual(redirectLifecycle.getState(sessionId), "consumed");

    const second = await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "UserPromptSubmit" });
    assert.deepStrictEqual(JSON.parse(second.body), { status: "ok" }, "a second prompt must never receive the same injection again");
  });

  test("a mismatched active session is rejected -- the approved packet stays approved and untouched", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const redirectLifecycle = exports.redirectLifecycle;

    const sessionIdA = `m12b-mismatch-a-${crypto.randomUUID()}`;
    const sessionIdB = `m12b-mismatch-b-${crypto.randomUUID()}`;
    const { analyzeResult } = await analyzeAndPrepareApprovedRedirect(runtime.port, sessionIdA, "gcloud deploy", "permission denied");
    await driftExtension.runPrepareRedirectCommand(sessionIdA, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => "approved" });
    assert.strictEqual(redirectLifecycle.getState(sessionIdA), "approved");

    // A completely unrelated session submits a prompt.
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionIdB, hook_event_name: "SessionStart" });
    const { body } = await postJson(runtime.port, "/hooks/claude", { session_id: sessionIdB, hook_event_name: "UserPromptSubmit" });
    assert.deepStrictEqual(JSON.parse(body), { status: "ok" }, "an unrelated active session must never receive session A's injection");
    assert.strictEqual(redirectLifecycle.getState(sessionIdA), "approved", "session A's packet must remain untouched -- still approved, still retryable");
  });

  test("failed delivery (stale analysis) leaves Claude's session unaffected and the packet retryable, not consumed", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();
    const redirectLifecycle = exports.redirectLifecycle;

    const sessionId = `m12b-stale-${crypto.randomUUID()}`;
    const { analyzeResult } = await analyzeAndPrepareApprovedRedirect(runtime.port, sessionId, "vault unseal", "sealed");
    await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => "approved" });
    assert.strictEqual(redirectLifecycle.getState(sessionId), "approved");

    // A NEWER manual re-analysis of the SAME session replaces the bound analysis, making the approved packet stale.
    await driftExtension.runAnalyzeSessionCommand({
      listSessions: (s) => s.listSessions(),
      pickSessionId: async () => sessionId,
      createRuntime: () => stubRuntime(() => ({ text: JSON.stringify({ progress: "low", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" }) })),
    });

    const { statusCode, body } = await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "UserPromptSubmit" });
    assert.strictEqual(statusCode, 200, "Claude's normal session must continue even when delivery is rejected as stale");
    assert.deepStrictEqual(JSON.parse(body), { status: "ok" }, "the hook response must not be corrupted by a failed/stale delivery");
    assert.strictEqual(redirectLifecycle.getState(sessionId), "approved", "a failed/stale delivery must leave the packet approved (unconsumed), so it remains reportable/retryable");
  });

  test("no additional Gemma call occurs during approval/injection", async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension("drift.drift-agent-monitor")!;
    const exports = await ext.activate();
    const runtime = exports.getRuntime();

    const sessionId = `m12b-nomodel-${crypto.randomUUID()}`;
    const { analyzeResult } = await analyzeAndPrepareApprovedRedirect(runtime.port, sessionId, "kubectl exec", "pod not found");

    const start = Date.now();
    await driftExtension.runPrepareRedirectCommand(sessionId, analyzeResult!.analyses[0], { showPacketAndConfirm: async () => "approved" });
    await postJson(runtime.port, "/hooks/claude", { session_id: sessionId, hook_event_name: "UserPromptSubmit" });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `approval + injection must not invoke the local model (took ${elapsed}ms)`);
  });
});
