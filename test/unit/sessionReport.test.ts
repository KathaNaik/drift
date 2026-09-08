import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage, DriftStorage, DriftRawEvent } from "../../src/storage";
import { normalizeRawEvent } from "../../src/normalizedEvent";
import { buildTrajectory } from "../../src/trajectory";
import { attributeUsageToTrajectory } from "../../src/trajectoryUsageAttribution";
import { extractTrajectoryFeatures } from "../../src/trajectoryFeatures";
import { detectSubagentOverlap } from "../../src/subagentOverlap";
import { decideFindingPolicy, DeterministicEvidence } from "../../src/findingDecisionPolicy";
import { SessionAnalysis, SessionAnalysisWindow } from "../../src/sessionAnalysisPipeline";
import { ClassificationResult, SemanticClassification } from "../../src/semanticClassifier";
import { buildSessionReport } from "../../src/sessionReport";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-session-report-test-"));
  return path.join(dir, "drift.sqlite3");
}

function apiRequestPayload(attrs: Record<string, unknown>): unknown {
  return {
    attributes: Object.entries(attrs).map(([key, value]) => ({
      key,
      value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
    })),
  };
}

function loadTrajectoryUsage(sessionId: string, storage: DriftStorage) {
  const session = storage.getSession(sessionId)!;
  const normalized = session.events.map(normalizeRawEvent);
  const trajectory = buildTrajectory(sessionId, normalized);
  return attributeUsageToTrajectory(trajectory, storage);
}

function rawEventsByIdFor(sessionId: string, storage: DriftStorage): Map<number, DriftRawEvent> {
  const session = storage.getSession(sessionId)!;
  const map = new Map<number, DriftRawEvent>();
  for (const e of session.events) map.set(e.id, e);
  return map;
}

function classification(fields: Partial<SemanticClassification>): ClassificationResult {
  const full: SemanticClassification = { progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry", ...fields };
  return { classification: full, raw: JSON.stringify(full), success: true, error: undefined };
}

function makeWindow(sessionId: string, stepIndexes: number[], deterministicEvidence: DeterministicEvidence[], cls: ClassificationResult): SessionAnalysisWindow {
  const decision = decideFindingPolicy({ sessionId, stepIndexes, deterministicEvidence, classification: cls, attributedUsage: undefined });
  return {
    stepIndexes,
    deterministicFindings: deterministicEvidence.filter((e) => e.type !== "subagent_overlap") as any,
    subagentOverlaps: deterministicEvidence.filter((e) => e.type === "subagent_overlap") as any,
    semanticResult: cls,
    decision,
  };
}

suite("sessionReport (M11C)", () => {
  let storage: DriftStorage;

  setup(() => {
    storage = openStorage(tempDbPath());
  });

  teardown(() => {
    storage.close();
  });

  test("session summary: sessionId, totalSteps, toolCallCount (including PostToolBatch sub-calls and orphan results)", () => {
    storage.ensureSession("s1");
    storage.insertRawEvent("s1", { hook_event_name: "SessionStart" }, 100);
    storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 110);
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 120);
    storage.insertRawEvent(
      "s1",
      { hook_event_name: "PostToolBatch", tool_calls: [{ tool_name: "Read", tool_input: { file_path: "/a" }, tool_response: "1" }, { tool_name: "Read", tool_input: { file_path: "/b" }, tool_response: "2" }] },
      130
    );
    // Orphan result: no matching PreToolUse for this tool_use_id.
    storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "orphan" }, tool_use_id: "orphan-1", tool_response: "ok" }, 140);
    storage.insertRawEvent("s1", { hook_event_name: "SessionEnd", reason: "other" }, 150);

    const trajectoryUsage = loadTrajectoryUsage("s1", storage);
    const report = buildSessionReport(trajectoryUsage, rawEventsByIdFor("s1", storage), undefined);

    assert.strictEqual(report.sessionId, "s1");
    assert.strictEqual(report.summary.sessionId, "s1");
    assert.strictEqual(report.summary.totalSteps, trajectoryUsage.steps.length);
    // 1 (Bash invocation+result pair) + 2 (batch sub-calls) + 1 (orphan result) = 4.
    assert.strictEqual(report.summary.toolCallCount, 4);
  });

  test("subagentCount is undefined with no subagent activity, and a real distinct count when agents are present", () => {
    storage.ensureSession("s-noagent");
    storage.insertRawEvent("s-noagent", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-noagent", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 110);
    let report = buildSessionReport(loadTrajectoryUsage("s-noagent", storage), rawEventsByIdFor("s-noagent", storage), undefined);
    assert.strictEqual(report.summary.subagentCount, undefined);

    storage.ensureSession("s-agents");
    storage.insertRawEvent("s-agents", { hook_event_name: "PreToolUse", agent_id: "worker-1", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "a1" }, 100);
    storage.insertRawEvent("s-agents", { hook_event_name: "PostToolUse", agent_id: "worker-1", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "a1", tool_response: "ok" }, 110);
    storage.insertRawEvent("s-agents", { hook_event_name: "PreToolUse", agent_id: "worker-2", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "a2" }, 120);
    storage.insertRawEvent("s-agents", { hook_event_name: "PostToolUse", agent_id: "worker-2", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "a2", tool_response: "ok" }, 130);
    report = buildSessionReport(loadTrajectoryUsage("s-agents", storage), rawEventsByIdFor("s-agents", storage), undefined);
    assert.strictEqual(report.summary.subagentCount, 2);
  });

  test("model usage exactly matches M7C session totals, and missing fields remain absent (not zero-filled)", () => {
    storage.ensureSession("s-usage");
    storage.insertRawEvent("s-usage", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 90);
    storage.insertRawEvent("s-usage", { hook_event_name: "PreToolUse", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-usage", { hook_event_name: "PostToolUse", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 110);
    storage.insertModelUsageEvent("s-usage", apiRequestPayload({ "session.id": "s-usage", "prompt.id": "p1", input_tokens: 500, output_tokens: 60 }), 95);

    const trajectoryUsage = loadTrajectoryUsage("s-usage", storage);
    const report = buildSessionReport(trajectoryUsage, rawEventsByIdFor("s-usage", storage), undefined);

    assert.deepStrictEqual(report.usage, trajectoryUsage.sessionTotals);
    assert.strictEqual(report.usage.inputTokens, 500);
    assert.strictEqual(report.usage.outputTokens, 60);
    assert.strictEqual(report.usage.cacheReadTokens, undefined, "unattributed fields must stay undefined, never zero-filled");
    assert.strictEqual(report.usage.cacheWriteTokens, undefined);
    assert.strictEqual(report.usage.costUsd, undefined);
    assert.strictEqual(report.usage.durationMs, undefined);
  });

  test("with no usage events at all, modelCalls is a real 0 but every token/cost/duration field stays undefined", () => {
    storage.ensureSession("s-nousage");
    storage.insertRawEvent("s-nousage", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-nousage", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 110);
    const report = buildSessionReport(loadTrajectoryUsage("s-nousage", storage), rawEventsByIdFor("s-nousage", storage), undefined);
    assert.strictEqual(report.usage.modelCalls, 0);
    assert.strictEqual(report.usage.inputTokens, undefined);
    assert.strictEqual(report.usage.outputTokens, undefined);
  });

  test("no analysis yet: findings and evidenceSummary are undefined, session/usage/outcome still render", () => {
    storage.ensureSession("s-noanalysis");
    storage.insertRawEvent("s-noanalysis", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-noanalysis", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 110);
    const report = buildSessionReport(loadTrajectoryUsage("s-noanalysis", storage), rawEventsByIdFor("s-noanalysis", storage), undefined);
    assert.strictEqual(report.findings, undefined);
    assert.strictEqual(report.evidenceSummary, undefined);
    assert.ok(report.summary);
    assert.ok(report.usage);
    assert.ok(report.outcome);
  });

  test("a leftover analysis for a DIFFERENT session is ignored, exactly like no analysis at all", () => {
    storage.ensureSession("s-mismatch");
    storage.insertRawEvent("s-mismatch", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-mismatch", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 110);
    const trajectoryUsage = loadTrajectoryUsage("s-mismatch", storage);

    const foreignAnalysis: SessionAnalysis = { sessionId: "some-other-session", analyses: [] };
    const report = buildSessionReport(trajectoryUsage, rawEventsByIdFor("s-mismatch", storage), foreignAnalysis);
    assert.strictEqual(report.findings, undefined);
    assert.strictEqual(report.evidenceSummary, undefined);
  });

  test("Finding/Redirect Candidate/Observe counts, evidence type counts, and semantic classes match the analysis exactly", () => {
    storage.ensureSession("s-counts");
    storage.insertRawEvent("s-counts", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-counts", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 110);
    const trajectoryUsage = loadTrajectoryUsage("s-counts", storage);

    const observeWindow = makeWindow(
      "s-counts",
      [0, 1],
      [{ type: "repeated_command", sessionId: "s-counts", stepIndexes: [0, 1], evidence: { occurrences: 2 } } as DeterministicEvidence],
      classification({ class: "new_exploration", semanticRedundancy: "low" })
    );
    const findingWindow = makeWindow(
      "s-counts",
      [2, 3, 4, 5],
      [
        { type: "repeated_failure", sessionId: "s-counts", stepIndexes: [2, 3, 4, 5], evidence: { occurrences: 2 } } as DeterministicEvidence,
        { type: "retry_without_state_change", sessionId: "s-counts", stepIndexes: [2, 3], evidence: {} } as DeterministicEvidence,
      ],
      classification({ class: "stalled_retry", semanticRedundancy: "medium" })
    );
    const redirectWindow = makeWindow(
      "s-counts",
      [6, 7, 8, 9],
      [
        { type: "repeated_failure", sessionId: "s-counts", stepIndexes: [6, 7, 8, 9], evidence: { occurrences: 2 } } as DeterministicEvidence,
        { type: "retry_without_state_change", sessionId: "s-counts", stepIndexes: [6, 7], evidence: {} } as DeterministicEvidence,
      ],
      classification({ class: "stalled_retry", semanticRedundancy: "high" })
    );
    assert.strictEqual(observeWindow.decision.state, "observe");
    assert.strictEqual(findingWindow.decision.state, "finding");
    assert.strictEqual(redirectWindow.decision.state, "redirect_candidate");

    const analysis: SessionAnalysis = { sessionId: "s-counts", analyses: [observeWindow, findingWindow, redirectWindow] };
    const report = buildSessionReport(trajectoryUsage, rawEventsByIdFor("s-counts", storage), analysis);

    assert.ok(report.findings);
    assert.strictEqual(report.findings!.observeCount, 1);
    assert.strictEqual(report.findings!.findingCount, 1);
    assert.strictEqual(report.findings!.redirectCandidateCount, 1);
    assert.deepStrictEqual(report.findings!.evidenceTypeCounts, { repeated_command: 1, repeated_failure: 2, retry_without_state_change: 2 });
    assert.deepStrictEqual(report.findings!.semanticClassesObserved, ["new_exploration", "stalled_retry"]);

    assert.ok(report.evidenceSummary);
    // The "state" field's type itself excludes "observe" (Exclude<DecisionState, "observe">)
    // -- this length check is what actually proves the observe window was filtered out.
    assert.strictEqual(report.evidenceSummary!.length, 2, "evidenceSummary must exclude the observe window");
    const findingEntry = report.evidenceSummary!.find((e) => e.state === "finding")!;
    assert.deepStrictEqual(findingEntry.stepIndexes, [2, 3, 4, 5]);
    assert.deepStrictEqual(findingEntry.deterministicEvidenceTypes.sort(), ["repeated_failure", "retry_without_state_change"]);
    assert.strictEqual(findingEntry.semanticClass, "stalled_retry");
    assert.deepStrictEqual(findingEntry.reasonCodes, findingWindow.decision.reasonCodes);
  });

  test("evidenceSummary is an empty array (not undefined) when analyzed but nothing is a Finding/Redirect Candidate", () => {
    storage.ensureSession("s-allobserve");
    storage.insertRawEvent("s-allobserve", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-allobserve", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 110);
    const trajectoryUsage = loadTrajectoryUsage("s-allobserve", storage);

    const observeWindow = makeWindow(
      "s-allobserve",
      [0, 1],
      [{ type: "repeated_command", sessionId: "s-allobserve", stepIndexes: [0, 1], evidence: {} } as DeterministicEvidence],
      classification({ class: "new_exploration" })
    );
    const analysis: SessionAnalysis = { sessionId: "s-allobserve", analyses: [observeWindow] };
    const report = buildSessionReport(trajectoryUsage, rawEventsByIdFor("s-allobserve", storage), analysis);

    assert.ok(report.findings);
    assert.strictEqual(report.findings!.findingCount, 0);
    assert.strictEqual(report.findings!.redirectCandidateCount, 0);
    assert.deepStrictEqual(report.evidenceSummary, [], "must be a real empty array, distinct from undefined (no analysis yet)");
  });

  test("outcome: final tool call success/failure, skipping a trailing PostToolBatch (no single objective outcome), and SessionEnd reason", () => {
    storage.ensureSession("s-outcome-fail");
    storage.insertRawEvent("s-outcome-fail", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-outcome-fail", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { error: "2 failing" } }, 110);
    storage.insertRawEvent("s-outcome-fail", { hook_event_name: "SessionEnd", reason: "clear" }, 120);
    let report = buildSessionReport(loadTrajectoryUsage("s-outcome-fail", storage), rawEventsByIdFor("s-outcome-fail", storage), undefined);
    assert.ok(report.outcome.finalToolCall);
    assert.strictEqual(report.outcome.finalToolCall!.outcome, "failure");
    assert.strictEqual(report.outcome.finalToolCall!.toolName, "Bash");
    assert.ok(report.outcome.finalToolCall!.inputSummary?.includes("npm test"));
    assert.strictEqual(report.outcome.sessionEndReason, "clear");

    storage.ensureSession("s-outcome-batch-last");
    storage.insertRawEvent("s-outcome-batch-last", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" }, tool_use_id: "b1" }, 100);
    storage.insertRawEvent("s-outcome-batch-last", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm run build" }, tool_use_id: "b1", tool_response: "built" }, 110);
    storage.insertRawEvent("s-outcome-batch-last", { hook_event_name: "PostToolBatch", tool_calls: [{ tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: "1" }] }, 120);
    report = buildSessionReport(loadTrajectoryUsage("s-outcome-batch-last", storage), rawEventsByIdFor("s-outcome-batch-last", storage), undefined);
    assert.ok(report.outcome.finalToolCall, "must look past a trailing PostToolBatch (no single objective outcome) to the last real single-call result");
    assert.strictEqual(report.outcome.finalToolCall!.outcome, "success");
    assert.strictEqual(report.outcome.finalToolCall!.toolName, "Bash");
    assert.strictEqual(report.outcome.sessionEndReason, undefined, "no SessionEnd event was recorded");

    storage.ensureSession("s-outcome-none");
    storage.insertRawEvent("s-outcome-none", { hook_event_name: "UserPromptSubmit", prompt: "hello" }, 100);
    report = buildSessionReport(loadTrajectoryUsage("s-outcome-none", storage), rawEventsByIdFor("s-outcome-none", storage), undefined);
    assert.strictEqual(report.outcome.finalToolCall, undefined, "no tool calls at all -- must not fabricate an outcome");
  });

  test("report step indexes match original trajectory indexes exactly (never renumbered)", () => {
    storage.ensureSession("s-indexes");
    storage.insertRawEvent("s-indexes", { hook_event_name: "UserPromptSubmit", prompt: "leading" }, 50);
    storage.insertRawEvent("s-indexes", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a" }, tool_use_id: "r1" }, 60);
    storage.insertRawEvent("s-indexes", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a" }, tool_use_id: "r1", tool_response: "x" }, 70);
    storage.insertRawEvent("s-indexes", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "fail" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-indexes", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "fail" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    const trajectoryUsage = loadTrajectoryUsage("s-indexes", storage);

    const bashInvocationIndex = trajectoryUsage.steps.findIndex((s) => s.event.data.toolName === "Bash" && s.event.type === "tool_invocation");
    const window = makeWindow(
      "s-indexes",
      [bashInvocationIndex, bashInvocationIndex + 1],
      [{ type: "repeated_failure", sessionId: "s-indexes", stepIndexes: [bashInvocationIndex, bashInvocationIndex + 1], evidence: {} } as DeterministicEvidence],
      classification({ class: "stalled_retry" })
    );
    const analysis: SessionAnalysis = { sessionId: "s-indexes", analyses: [window] };
    const report = buildSessionReport(trajectoryUsage, rawEventsByIdFor("s-indexes", storage), analysis);

    assert.ok(bashInvocationIndex > 0, "sanity: the failing Bash call is not at the start of the trajectory");
    assert.deepStrictEqual(report.evidenceSummary![0].stepIndexes, [bashInvocationIndex, bashInvocationIndex + 1]);
    assert.strictEqual(report.outcome.finalToolCall!.stepIndex, bashInvocationIndex + 1);
  });

  test("deterministic output for the same input", () => {
    storage.ensureSession("s-det");
    storage.insertRawEvent("s-det", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-det", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 110);
    const trajectoryUsage = loadTrajectoryUsage("s-det", storage);
    const rawEventsById = rawEventsByIdFor("s-det", storage);

    const first = buildSessionReport(trajectoryUsage, rawEventsById, undefined);
    const second = buildSessionReport(trajectoryUsage, rawEventsById, undefined);
    assert.deepStrictEqual(first, second);
  });

  test("does not mutate its inputs", () => {
    storage.ensureSession("s-mutate");
    storage.insertRawEvent("s-mutate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-mutate", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 110);
    const trajectoryUsage = loadTrajectoryUsage("s-mutate", storage);
    const rawEventsById = rawEventsByIdFor("s-mutate", storage);

    const window = makeWindow(
      "s-mutate",
      [0, 1],
      [{ type: "repeated_command", sessionId: "s-mutate", stepIndexes: [0, 1], evidence: {} } as DeterministicEvidence],
      classification({ class: "new_exploration" })
    );
    const analysis: SessionAnalysis = { sessionId: "s-mutate", analyses: [window] };
    const trajectorySnapshot = JSON.stringify(trajectoryUsage);
    const analysisSnapshot = JSON.stringify(analysis);

    buildSessionReport(trajectoryUsage, rawEventsById, analysis);

    assert.strictEqual(JSON.stringify(trajectoryUsage), trajectorySnapshot);
    assert.strictEqual(JSON.stringify(analysis), analysisSnapshot);
  });
});
