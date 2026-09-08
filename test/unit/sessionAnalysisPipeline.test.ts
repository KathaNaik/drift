import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage, DriftStorage } from "../../src/storage";
import { normalizeRawEvent } from "../../src/normalizedEvent";
import { buildTrajectory } from "../../src/trajectory";
import { attributeUsageToTrajectory, TrajectoryUsage } from "../../src/trajectoryUsageAttribution";
import { LocalModelRuntime, InferenceResult, InferOptions, createLocalModelRuntime } from "../../src/localModelRuntime";
import { analyzeSession } from "../../src/sessionAnalysisPipeline";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-session-analysis-test-"));
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

function trajectoryUsageFor(sessionId: string, storage: DriftStorage): TrajectoryUsage {
  const session = storage.getSession(sessionId)!;
  const normalized = session.events.map(normalizeRawEvent);
  const trajectory = buildTrajectory(sessionId, normalized);
  return attributeUsageToTrajectory(trajectory, storage);
}

interface StubRuntime extends LocalModelRuntime {
  calls: string[];
}

/** A stub runtime that inspects each prompt's text to decide its canned response, and records every prompt it was called with (for call-count / dedup assertions). */
function stubRuntime(responder: (prompt: string, callIndex: number) => { text?: string; success?: boolean }): StubRuntime {
  const calls: string[] = [];
  return {
    calls,
    infer: async (prompt: string, _options?: InferOptions): Promise<InferenceResult> => {
      calls.push(prompt);
      const r = responder(prompt, calls.length - 1);
      return {
        text: r.text,
        record: { startedAt: 0, durationMs: 0, inputTokens: 1, outputTokens: 1, success: r.success !== false, error: r.success === false ? "stubbed failure" : undefined },
      };
    },
    close: async () => {},
  };
}

function fixedRuntime(classification: object): StubRuntime {
  return stubRuntime(() => ({ text: JSON.stringify(classification) }));
}

suite("sessionAnalysisPipeline (M10B)", () => {
  let storage: DriftStorage;

  setup(() => {
    storage = openStorage(tempDbPath());
  });

  teardown(() => {
    storage.close();
  });

  test("stalled retry flows end-to-end into finding", async () => {
    storage.ensureSession("s-finding");
    storage.insertRawEvent("s-finding", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-finding", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s-finding", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s-finding", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

    const trajectoryUsage = trajectoryUsageFor("s-finding", storage);
    const runtime = fixedRuntime({ progress: "low", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" });

    const result = await analyzeSession(trajectoryUsage, storage, runtime);
    assert.strictEqual(result.sessionId, "s-finding");
    assert.strictEqual(result.analyses.length, 1);
    assert.strictEqual(result.analyses[0].decision.state, "finding");
  });

  test("strong repeated stalled loop can flow into redirect_candidate", async () => {
    storage.ensureSession("s-redirect");
    let t = 100;
    for (let i = 0; i < 3; i++) {
      storage.insertRawEvent("s-redirect", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: `c${i}a` }, t++);
      storage.insertRawEvent("s-redirect", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: `c${i}b`, tool_response: { error: "boom" } }, t++);
    }

    const trajectoryUsage = trajectoryUsageFor("s-redirect", storage);
    const runtime = fixedRuntime({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" });

    const result = await analyzeSession(trajectoryUsage, storage, runtime);
    assert.strictEqual(result.analyses.length, 1);
    assert.strictEqual(result.analyses[0].decision.state, "redirect_candidate");
    assert.ok(result.analyses[0].deterministicFindings.length >= 2, "expected multiple corroborating M8A findings (repeated_failure + retry_without_state_change pairs)");
  });

  test("productive retry never becomes redirect_candidate, even when the model itself reports it end-to-end", async () => {
    storage.ensureSession("s-productive");
    storage.insertRawEvent("s-productive", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-productive", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s-productive", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s-productive", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2", tool_response: { output: "worked" } }, 130);

    const trajectoryUsage = trajectoryUsageFor("s-productive", storage);
    // Adversarial: the (stubbed) model claims productive_retry with maximally
    // "qualifying" other fields, even though the deterministic evidence here
    // (retry_without_state_change) structurally shows no state change at all --
    // decideFindingPolicy must still refuse to ever escalate this.
    const runtime = fixedRuntime({ progress: "meaningful", newEvidence: true, newHypothesis: false, semanticRedundancy: "low", class: "productive_retry" });

    const result = await analyzeSession(trajectoryUsage, storage, runtime);
    assert.strictEqual(result.analyses.length, 1);
    assert.notStrictEqual(result.analyses[0].decision.state, "redirect_candidate");
    assert.strictEqual(result.analyses[0].decision.state, "observe");
    assert.ok(result.analyses[0].decision.reasonCodes.includes("productive_retry_excludes_low_value_pattern"));
  });

  test("real duplicate-subagent overlap becomes finding", async () => {
    storage.ensureSession("s-duplicate");
    storage.insertRawEvent("s-duplicate", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "a1" }, 100);
    storage.insertRawEvent("s-duplicate", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "a1", tool_response: { output: "ok" } }, 110);
    storage.insertRawEvent("s-duplicate", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "b1" }, 120);
    storage.insertRawEvent("s-duplicate", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "b1", tool_response: { output: "ok" } }, 130);

    const trajectoryUsage = trajectoryUsageFor("s-duplicate", storage);
    // semanticRedundancy is deliberately "medium" (not "high") here: this
    // fixture also incidentally trips M8A's repeated_command/repeated_context
    // detectors (both agents ran the literal same command), so deterministic
    // corroboration alone would already clear redirect_candidate's 2+-signal
    // bar -- keeping redundancy at "medium" isolates this test's intent
    // (duplicate subagent work surfaces as a finding) from that separate,
    // already-covered escalation path.
    const runtime = fixedRuntime({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "duplicate_subagent_work" });

    const result = await analyzeSession(trajectoryUsage, storage, runtime);
    assert.strictEqual(result.analyses.length, 1);
    assert.ok(result.analyses[0].subagentOverlaps.length >= 1, "expected at least one subagent_overlap finding");
    assert.strictEqual(result.analyses[0].decision.state, "finding");
  });

  test("semantic classifier failure produces observe rather than aborting session analysis, and unrelated windows remain separate", async () => {
    storage.ensureSession("s-mixed");
    // Window A: will get a malformed model response.
    storage.insertRawEvent("s-mixed", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-a" }, tool_use_id: "a1" }, 100);
    storage.insertRawEvent("s-mixed", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-a" }, tool_use_id: "a1", tool_response: { error: "boom-a" } }, 110);
    storage.insertRawEvent("s-mixed", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-a" }, tool_use_id: "a2" }, 120);
    storage.insertRawEvent("s-mixed", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-a" }, tool_use_id: "a2", tool_response: { error: "boom-a" } }, 130);
    // Window B: unrelated, far away, gets a valid corroborating response.
    storage.insertRawEvent("s-mixed", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-b" }, tool_use_id: "b1" }, 500);
    storage.insertRawEvent("s-mixed", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-b" }, tool_use_id: "b1", tool_response: { error: "boom-b" } }, 510);
    storage.insertRawEvent("s-mixed", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-b" }, tool_use_id: "b2" }, 520);
    storage.insertRawEvent("s-mixed", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-b" }, tool_use_id: "b2", tool_response: { error: "boom-b" } }, 530);

    const trajectoryUsage = trajectoryUsageFor("s-mixed", storage);
    const runtime = stubRuntime((prompt) => {
      if (prompt.includes("flaky-a")) return { text: "not valid json at all" };
      return { text: JSON.stringify({ progress: "low", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" }) };
    });

    const result = await analyzeSession(trajectoryUsage, storage, runtime);
    assert.strictEqual(result.analyses.length, 2, "both windows must be analyzed independently, never merged");

    const windowA = result.analyses.find((a) => a.deterministicFindings.some((f) => JSON.stringify(f.evidence).includes("flaky-a")))!;
    const windowB = result.analyses.find((a) => a.deterministicFindings.some((f) => JSON.stringify(f.evidence).includes("flaky-b")))!;
    assert.ok(windowA && windowB, "expected to find both distinct windows");

    assert.strictEqual(windowA.semanticResult.success, false);
    assert.strictEqual(windowA.decision.state, "observe");

    assert.strictEqual(windowB.semanticResult.success, true, windowB.semanticResult.error);
    assert.strictEqual(windowB.decision.state, "finding");

    assert.notDeepStrictEqual(windowA.stepIndexes, windowB.stepIndexes);
    const overlap = windowA.stepIndexes.some((i) => windowB.stepIndexes.includes(i));
    assert.strictEqual(overlap, false, "unrelated windows must not share any step indexes");
  });

  test("overlapping M8 findings for the same activity do not cause duplicate Gemma calls", async () => {
    storage.ensureSession("s-dedup");
    storage.insertRawEvent("s-dedup", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-dedup", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s-dedup", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s-dedup", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

    const trajectoryUsage = trajectoryUsageFor("s-dedup", storage);
    const runtime = fixedRuntime({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" });

    const result = await analyzeSession(trajectoryUsage, storage, runtime);
    // repeated_failure and retry_without_state_change both cover this exact
    // pair of failed attempts -- two M8A findings describing one activity.
    assert.ok(result.analyses[0].deterministicFindings.length >= 2);
    assert.strictEqual(result.analyses.length, 1);
    assert.strictEqual(runtime.calls.length, 1, "one activity covered by multiple overlapping findings must still be classified exactly once");
  });

  test("usage attribution survives through the final decision", async () => {
    storage.ensureSession("s-usage");
    storage.insertRawEvent("s-usage", { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 90);
    storage.insertRawEvent("s-usage", { hook_event_name: "PreToolUse", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-usage", { hook_event_name: "PostToolUseFailure", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s-usage", { hook_event_name: "PreToolUse", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s-usage", { hook_event_name: "PostToolUseFailure", prompt_id: "p1", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);
    storage.insertModelUsageEvent("s-usage", apiRequestPayload({ "session.id": "s-usage", "prompt.id": "p1", input_tokens: 777, output_tokens: 88 }), 95);

    const trajectoryUsage = trajectoryUsageFor("s-usage", storage);
    const runtime = fixedRuntime({ progress: "low", newEvidence: false, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" });

    const result = await analyzeSession(trajectoryUsage, storage, runtime);
    assert.strictEqual(result.analyses.length, 1);
    const usage = result.analyses[0].decision.attributedUsage;
    assert.ok(usage, "expected usage to be attributed to this decision");
    assert.strictEqual(usage!.inputTokens, 777);
    assert.strictEqual(usage!.outputTokens, 88);
  });

  test("original stepIndexes remain correct even when the relevant activity is not at the start of the trajectory", async () => {
    storage.ensureSession("s-indexes");
    storage.insertRawEvent("s-indexes", { hook_event_name: "UserPromptSubmit", prompt_id: "p0" }, 50);
    storage.insertRawEvent("s-indexes", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/README.md" }, tool_use_id: "r1" }, 60);
    storage.insertRawEvent("s-indexes", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/README.md" }, tool_use_id: "r1", tool_response: "hello" }, 70);
    storage.insertRawEvent("s-indexes", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-indexes", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s-indexes", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s-indexes", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

    const trajectoryUsage = trajectoryUsageFor("s-indexes", storage);
    // Sanity: the failing Bash steps are NOT at the start of the trajectory.
    const bashStepIndexes = trajectoryUsage.steps.filter((s) => s.event.data.toolName === "Bash").map((s) => s.index);
    assert.ok(Math.min(...bashStepIndexes) > 0);

    const runtime = fixedRuntime({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" });
    const result = await analyzeSession(trajectoryUsage, storage, runtime);

    assert.strictEqual(result.analyses.length, 1);
    const { stepIndexes } = result.analyses[0];
    for (const index of stepIndexes) {
      assert.strictEqual(trajectoryUsage.steps[index].event.data.toolName, "Bash", `stepIndex ${index} must point at the real Bash step, not a renumbered position`);
    }
    assert.deepStrictEqual([...stepIndexes].sort((a, b) => a - b), stepIndexes, "stepIndexes must be ascending");
  });

  test("deterministic output for the same input", async () => {
    storage.ensureSession("s-det");
    storage.insertRawEvent("s-det", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-det", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s-det", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s-det", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

    const trajectoryUsage = trajectoryUsageFor("s-det", storage);
    const classificationObj = { progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" };

    const first = await analyzeSession(trajectoryUsage, storage, fixedRuntime(classificationObj));
    const second = await analyzeSession(trajectoryUsage, storage, fixedRuntime(classificationObj));
    assert.deepStrictEqual(first, second);
  });

  test("does not mutate the trajectory it is given", async () => {
    storage.ensureSession("s-mutate");
    storage.insertRawEvent("s-mutate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-mutate", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s-mutate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s-mutate", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-cmd" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

    const trajectoryUsage = trajectoryUsageFor("s-mutate", storage);
    const snapshotBefore = JSON.stringify(trajectoryUsage);
    const runtime = fixedRuntime({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" });

    await analyzeSession(trajectoryUsage, storage, runtime);
    assert.strictEqual(JSON.stringify(trajectoryUsage), snapshotBefore);
  });

  suite("real classification against Gemma 3 4B", function () {
    const MODEL_PATH = path.join(process.cwd(), "models", "gemma-3-4b-it-IQ4_XS.gguf");
    const MODEL_PRESENT = fs.existsSync(MODEL_PATH);
    let runtime: LocalModelRuntime;

    suiteSetup(function () {
      if (!MODEL_PRESENT) this.skip();
      runtime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 60000 });
    });

    suiteTeardown(async () => {
      if (runtime) await runtime.close();
    });

    test("a real stalled-retry session is analyzed end-to-end using the actual local model, never a stub", async function () {
      this.timeout(60000);
      storage.ensureSession("s-real");
      storage.insertRawEvent("s-real", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "curl https://internal/health" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("s-real", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "curl https://internal/health" }, tool_use_id: "c1", tool_response: { error: "connection refused" } }, 110);
      storage.insertRawEvent("s-real", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "curl https://internal/health" }, tool_use_id: "c2" }, 120);
      storage.insertRawEvent("s-real", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "curl https://internal/health" }, tool_use_id: "c2", tool_response: { error: "connection refused" } }, 130);

      const trajectoryUsage = trajectoryUsageFor("s-real", storage);
      const result = await analyzeSession(trajectoryUsage, storage, runtime);

      assert.strictEqual(result.sessionId, "s-real");
      assert.strictEqual(result.analyses.length, 1);
      assert.ok(result.analyses[0].semanticResult.raw !== undefined, "expected real generated text from the model, not a stub");
      assert.ok(["observe", "finding", "redirect_candidate"].includes(result.analyses[0].decision.state));
    });
  });
});
