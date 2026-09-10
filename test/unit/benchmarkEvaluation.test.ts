import * as assert from "assert";
import { UsageSummary } from "../../src/trajectoryUsageAttribution";
import { DriftOverhead, InterventionRecord } from "../../src/interventionMeasurement";
import { TaskResult, comparePairedRun, PairedComparisonResult } from "../../src/pairedComparison";
import { TrialRecord, TrialCondition, InterventionOccurrence } from "../../src/benchmarkTrials";
import { evaluateBenchmarkTrials } from "../../src/benchmarkEvaluation";

function usage(fields: Partial<UsageSummary> = {}): UsageSummary {
  return { modelCalls: 0, inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined, costUsd: undefined, durationMs: undefined, records: [], ...fields };
}
function overhead(fields: Partial<DriftOverhead> = {}): DriftOverhead {
  return { localInferenceCount: 0, localInferenceDurationMs: undefined, localInferenceInputTokens: undefined, localInferenceOutputTokens: undefined, redirectPacketSizeBytes: 0, analysisDurationMs: undefined, ...fields };
}
function interventionRecord(sessionId: string, fields: Partial<InterventionRecord> = {}): InterventionRecord {
  return {
    sessionId,
    sourceStepIndexes: [0],
    approvedAt: 10,
    deliveredAt: 20,
    preRedirectUsage: usage(),
    postRedirectUsage: usage(),
    driftOverhead: overhead(),
    outcome: { finalToolCall: undefined, sessionEndReason: undefined },
    ...fields,
  };
}
function taskResultFixture(passed: boolean, fields: Partial<TaskResult> = {}): TaskResult {
  return { passed, evaluator: "fixture-evaluator", ...fields };
}

let trialCounter = 0;

interface MakeTrialOptions {
  taskId?: string;
  condition: TrialCondition;
  controlUsage?: Partial<UsageSummary>;
  treatmentUsage?: Partial<UsageSummary>;
  controlPassed?: boolean | undefined; // undefined means "no taskResult at all" (unevaluable)
  treatmentPassed?: boolean | undefined;
  controlElapsedMs?: number;
  treatmentElapsedMs?: number;
  driftOverhead?: Partial<DriftOverhead>;
  /** Only meaningful for "completed" with a delivered redirect -- forces intervention flags/redirectOutcome explicitly for edge cases like "rejected". */
  interventionOverride?: Partial<InterventionOccurrence>;
  redirectOutcomeOverride?: "not_attempted" | "no_candidate" | "rejected" | "delivered" | "delivery_failed";
}

/** Builds a realistic, internally-consistent TrialRecord -- when a redirect was delivered, `comparison` is produced via a REAL comparePairedRun() call, never hand-faked. */
function makeTrial(opts: MakeTrialOptions): TrialRecord {
  trialCounter++;
  const taskId = opts.taskId ?? "task-default";
  const controlSessionId = `control-${trialCounter}`;
  const treatmentSessionId = `treatment-${trialCounter}`;

  const controlClaudeError = opts.condition === "control_process_failure" ? "simulated control crash" : undefined;
  const treatmentClaudeError = opts.condition === "treatment_process_failure" ? "simulated treatment crash" : undefined;
  const evaluatorError = opts.condition === "evaluator_failure" ? "simulated evaluator crash" : undefined;

  let redirectOutcome = opts.redirectOutcomeOverride;
  if (redirectOutcome === undefined) {
    if (opts.condition === "treatment_process_failure") redirectOutcome = "not_attempted";
    else if (opts.condition === "no_redirect_candidate") redirectOutcome = "no_candidate";
    else if (opts.condition === "redirect_approved_not_delivered") redirectOutcome = "delivery_failed";
    else redirectOutcome = "delivered"; // "completed" default: assume a delivered redirect unless overridden (e.g. to "rejected" or "no_candidate" for a plain completed pair)
  }

  const cUsage = usage(opts.controlUsage);
  const tUsage = usage(opts.treatmentUsage);
  const dOverhead = overhead(opts.driftOverhead);

  // A real M13C result never carries both evaluatorError and taskResult for
  // the same side -- this fixture's "evaluator_failure" condition simulates
  // the evaluator crashing on both sides at once, so neither side gets a
  // taskResult regardless of controlPassed/treatmentPassed being supplied.
  const controlTaskResult = opts.controlPassed === undefined || evaluatorError !== undefined ? undefined : taskResultFixture(opts.controlPassed);
  const treatmentTaskResult = opts.treatmentPassed === undefined || treatmentClaudeError !== undefined || evaluatorError !== undefined ? undefined : taskResultFixture(opts.treatmentPassed);

  let comparison: PairedComparisonResult | undefined;
  let intervention: InterventionOccurrence;

  if (redirectOutcome === "delivered") {
    const record = interventionRecord(treatmentSessionId);
    if (controlTaskResult !== undefined && treatmentTaskResult !== undefined && controlClaudeError === undefined && treatmentClaudeError === undefined) {
      const result = comparePairedRun({
        taskId,
        control: { sessionId: controlSessionId, usage: cUsage, taskResult: controlTaskResult },
        treatment: { sessionId: treatmentSessionId, usage: tUsage, driftOverhead: dOverhead, intervention: record, taskResult: treatmentTaskResult },
      });
      if (!result.success) throw new Error("fixture comparePairedRun failed: " + result.error);
      comparison = result.comparison;
    }
    intervention = { redirectCandidateOccurred: true, packetApproved: true, delivered: true, consumed: true, ...opts.interventionOverride };
  } else if (redirectOutcome === "delivery_failed") {
    intervention = { redirectCandidateOccurred: true, packetApproved: true, delivered: false, consumed: false, ...opts.interventionOverride };
  } else if (redirectOutcome === "rejected") {
    intervention = { redirectCandidateOccurred: true, packetApproved: false, delivered: false, consumed: false, ...opts.interventionOverride };
  } else {
    // "no_candidate" or "not_attempted"
    intervention = { redirectCandidateOccurred: false, packetApproved: false, delivered: false, consumed: false, ...opts.interventionOverride };
  }

  return {
    taskId,
    repetitionIndex: trialCounter,
    order: trialCounter % 2 === 0 ? "control-first" : "treatment-first",
    controlSessionId,
    treatmentSessionId,
    workspaceFingerprint: `fingerprint-${taskId}`,
    condition: opts.condition,
    intervention,
    comparison,
    comparisonUnavailableReason: comparison === undefined ? "fixture: no comparison" : undefined,
    benchmarkResult: {
      taskId,
      settings: { model: "m", allowedTools: [], permissionMode: "acceptEdits", env: {} },
      control: {
        sessionId: controlSessionId,
        workspace: "/tmp/control",
        startedAt: 0,
        completedAt: opts.controlElapsedMs ?? 1000,
        elapsedMs: opts.controlElapsedMs ?? 1000,
        usage: controlClaudeError ? undefined : cUsage,
        taskResult: controlTaskResult,
        claudeError: controlClaudeError,
        evaluatorError: opts.condition === "evaluator_failure" ? evaluatorError : undefined,
      },
      treatment: {
        sessionId: treatmentSessionId,
        workspace: "/tmp/treatment",
        startedAt: 0,
        completedAt: opts.treatmentElapsedMs ?? 1000,
        elapsedMs: opts.treatmentElapsedMs ?? 1000,
        usage: treatmentClaudeError ? undefined : tUsage,
        taskResult: treatmentTaskResult,
        claudeError: treatmentClaudeError,
        evaluatorError: opts.condition === "evaluator_failure" ? evaluatorError : undefined,
        driftOverhead: redirectOutcome === "delivered" ? dOverhead : undefined,
        intervention: redirectOutcome === "delivered" ? interventionRecord(treatmentSessionId) : undefined,
        redirectOutcome,
      },
    },
  };
}

suite("benchmarkEvaluation (M14C)", () => {
  test("every raw trial is accounted for: the six condition-based counts sum exactly to totalTrials", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 5 }, treatmentUsage: { modelCalls: 2 } }),
      makeTrial({ condition: "control_process_failure" }),
      makeTrial({ condition: "treatment_process_failure" }),
      makeTrial({ condition: "evaluator_failure", controlPassed: true }),
      makeTrial({ condition: "no_redirect_candidate", controlPassed: true, treatmentPassed: true }),
      makeTrial({ condition: "redirect_approved_not_delivered", controlPassed: true, treatmentPassed: true }),
    ];
    const output = evaluateBenchmarkTrials(trials);
    const a = output.overall.accounting;
    assert.strictEqual(a.totalTrials, 6);
    const redirectApprovedNotDeliveredCount = a.totalTrials - a.completedTrials - a.controlProcessFailures - a.treatmentProcessFailures - a.evaluatorFailures - a.noRedirectCandidateTrials;
    assert.strictEqual(redirectApprovedNotDeliveredCount, 1, "the 6th condition (redirect_approved_not_delivered) must be exactly the remainder");
    assert.strictEqual(a.completedTrials, 1);
    assert.strictEqual(a.controlProcessFailures, 1);
    assert.strictEqual(a.treatmentProcessFailures, 1);
    assert.strictEqual(a.evaluatorFailures, 1);
    assert.strictEqual(a.noRedirectCandidateTrials, 1);
  });

  test("intervention-flag-based counts (redirectCandidateTrials, approvedRedirectTrials, deliveredRedirectTrials, consumedRedirectTrials) are correct and independent of overall condition", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true }), // delivered
      makeTrial({ condition: "redirect_approved_not_delivered", controlPassed: true, treatmentPassed: true }), // candidate + approved, not delivered
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, redirectOutcomeOverride: "rejected" }), // candidate, not approved
      makeTrial({ condition: "no_redirect_candidate", controlPassed: true, treatmentPassed: true }), // no candidate
      makeTrial({ condition: "control_process_failure" }), // control crashed, but treatment still delivered a real redirect
    ];
    // Force the 5th trial's treatment to have genuinely delivered, even though control crashed.
    trials[4] = makeTrial({ condition: "control_process_failure", treatmentPassed: true, redirectOutcomeOverride: "delivered" });

    const output = evaluateBenchmarkTrials(trials);
    const a = output.overall.accounting;

    // Candidates: trial 0 (delivered), trial 1 (approved-not-delivered), trial 2 (rejected), trial 4 (delivered despite control crashing) = 4. Trial 3 (no_redirect_candidate) has none.
    assert.strictEqual(a.redirectCandidateTrials, 4);
    assert.strictEqual(a.approvedRedirectTrials, 3, "delivered (trial 0) + not-delivered (trial 1) + delivered-despite-control-crash (trial 4) were approved; rejected (trial 2) was not");
    assert.strictEqual(a.deliveredRedirectTrials, 2, "trial 0 and trial 4, INCLUDING the one where control crashed");
    assert.strictEqual(a.consumedRedirectTrials, 2);
  });

  test("task success: control/treatment passed/failed/passRate computed independently from explicit evaluator results only", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, redirectOutcomeOverride: "no_candidate" }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: false, redirectOutcomeOverride: "no_candidate" }),
      makeTrial({ condition: "completed", controlPassed: false, treatmentPassed: true, redirectOutcomeOverride: "no_candidate" }),
      makeTrial({ condition: "completed", controlPassed: false, treatmentPassed: false, redirectOutcomeOverride: "no_candidate" }),
    ];
    const output = evaluateBenchmarkTrials(trials);
    const s = output.overall.taskSuccess;
    assert.strictEqual(s.control.passed, 2);
    assert.strictEqual(s.control.failed, 2);
    assert.strictEqual(s.control.passRate, 0.5);
    assert.strictEqual(s.treatment.passed, 2);
    assert.strictEqual(s.treatment.failed, 2);
    assert.strictEqual(s.treatment.passRate, 0.5);
  });

  test("all four paired success outcomes are counted correctly", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, redirectOutcomeOverride: "no_candidate" }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: false, redirectOutcomeOverride: "no_candidate" }),
      makeTrial({ condition: "completed", controlPassed: false, treatmentPassed: true, redirectOutcomeOverride: "no_candidate" }),
      makeTrial({ condition: "completed", controlPassed: false, treatmentPassed: false, redirectOutcomeOverride: "no_candidate" }),
    ];
    const output = evaluateBenchmarkTrials(trials);
    assert.deepStrictEqual(output.overall.taskSuccess.pairedOutcomes, {
      controlPass_treatmentPass: 1,
      controlPass_treatmentFail: 1,
      controlFail_treatmentPass: 1,
      controlFail_treatmentFail: 1,
    });
  });

  test("a trial where either side is unevaluable is excluded from pairedOutcomes but still counted in that side's own passed/failed", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: undefined, redirectOutcomeOverride: "no_candidate" }), // treatment unevaluable somehow
      makeTrial({ condition: "control_process_failure", treatmentPassed: true, redirectOutcomeOverride: "no_candidate" }), // control unevaluable
    ];
    const output = evaluateBenchmarkTrials(trials);
    const s = output.overall.taskSuccess;
    assert.strictEqual(s.control.passed, 1); // only trial 1's control
    assert.strictEqual(s.control.failed, 0);
    assert.strictEqual(s.treatment.passed, 1); // only trial 2's treatment
    assert.strictEqual(s.treatment.failed, 0);
    const total = s.pairedOutcomes.controlPass_treatmentPass + s.pairedOutcomes.controlPass_treatmentFail + s.pairedOutcomes.controlFail_treatmentPass + s.pairedOutcomes.controlFail_treatmentFail;
    assert.strictEqual(total, 0, "neither trial has BOTH sides evaluable, so no paired outcome should be recorded for either");
  });

  test("success preservation denominator and rate are correct, and control-failing trials are excluded from both numerator and denominator", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, redirectOutcomeOverride: "no_candidate" }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, redirectOutcomeOverride: "no_candidate" }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: false, redirectOutcomeOverride: "no_candidate" }),
      makeTrial({ condition: "completed", controlPassed: false, treatmentPassed: true, redirectOutcomeOverride: "no_candidate" }), // must be excluded entirely
      makeTrial({ condition: "control_process_failure", treatmentPassed: true, redirectOutcomeOverride: "no_candidate" }), // control unevaluable -- excluded too
    ];
    const output = evaluateBenchmarkTrials(trials);
    const sp = output.overall.successPreservation;
    assert.strictEqual(sp.denominator, 3, "only the 3 trials where control passed");
    assert.strictEqual(sp.numerator, 2);
    assert.strictEqual(sp.rate, 2 / 3);
  });

  test("success preservation rate is undefined when the denominator is zero, with the denominator explicitly reported as 0", () => {
    const trials = [makeTrial({ condition: "completed", controlPassed: false, treatmentPassed: true, redirectOutcomeOverride: "no_candidate" })];
    const output = evaluateBenchmarkTrials(trials);
    assert.strictEqual(output.overall.successPreservation.denominator, 0);
    assert.strictEqual(output.overall.successPreservation.rate, undefined);
  });

  test("intervention rates use explicit denominators and are undefined when those denominators are zero", () => {
    const trials = [
      makeTrial({ condition: "treatment_process_failure" }),
      makeTrial({ condition: "treatment_process_failure" }),
    ];
    const output = evaluateBenchmarkTrials(trials);
    const ir = output.overall.interventionRates;
    assert.strictEqual(ir.eligibleTreatmentTrials, 0, "both treatments crashed before ever being eligible for analysis");
    assert.strictEqual(ir.redirectCandidateRate, undefined);
    assert.strictEqual(ir.deliveryRate, undefined, "approvedRedirectTrials is also 0 here");
  });

  test("intervention rates are computed correctly with a real, non-zero denominator", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true }), // delivered candidate
      makeTrial({ condition: "redirect_approved_not_delivered", controlPassed: true, treatmentPassed: true }), // approved candidate, not delivered
      makeTrial({ condition: "no_redirect_candidate", controlPassed: true, treatmentPassed: true }), // no candidate
      makeTrial({ condition: "no_redirect_candidate", controlPassed: true, treatmentPassed: true }), // no candidate
    ];
    const output = evaluateBenchmarkTrials(trials);
    const ir = output.overall.interventionRates;
    assert.strictEqual(ir.eligibleTreatmentTrials, 4);
    assert.strictEqual(ir.redirectCandidateRate, 2 / 4);
    assert.strictEqual(ir.deliveryRate, 1 / 2, "1 delivered out of 2 approved");
  });

  test("aggregate usage stats (mean/median/min/max) are mathematically correct and use only valid measured values", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 10, inputTokens: 100 }, treatmentUsage: { modelCalls: 2, inputTokens: 20 } }), // diff modelCalls=8, inputTokens=80
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 6, inputTokens: undefined }, treatmentUsage: { modelCalls: 1, inputTokens: 5 } }), // diff modelCalls=5, inputTokens=undefined (missing on control side)
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 4, inputTokens: 40 }, treatmentUsage: { modelCalls: 1, inputTokens: 10 } }), // diff modelCalls=3, inputTokens=30
    ];
    const output = evaluateBenchmarkTrials(trials);
    const modelCalls = output.overall.usageComparison.modelCalls.absoluteDifference;
    assert.strictEqual(modelCalls.n, 3);
    assert.strictEqual(modelCalls.mean, (8 + 5 + 3) / 3);
    assert.strictEqual(modelCalls.median, 5);
    assert.strictEqual(modelCalls.min, 3);
    assert.strictEqual(modelCalls.max, 8);

    const inputTokens = output.overall.usageComparison.inputTokens.absoluteDifference;
    assert.strictEqual(inputTokens.n, 2, "the trial with a missing control-side value must be excluded, not zero-filled");
    assert.strictEqual(inputTokens.mean, (80 + 30) / 2);
    assert.strictEqual(inputTokens.min, 30);
    assert.strictEqual(inputTokens.max, 80);
  });

  test("percentageDifference is aggregated separately from absolute differences, with its own n", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 10 }, treatmentUsage: { modelCalls: 2 } }), // % = 0.8
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 0 }, treatmentUsage: { modelCalls: 5 } }), // control 0 -- percentage must be undefined
    ];
    const output = evaluateBenchmarkTrials(trials);
    const modelCalls = output.overall.usageComparison.modelCalls;
    assert.strictEqual(modelCalls.absoluteDifference.n, 2, "both absolute differences are defined");
    assert.strictEqual(modelCalls.percentageDifference.n, 1, "only the first trial has a defined percentage -- zero-control trial excluded, not treated as 0%");
    assert.ok(Math.abs(modelCalls.percentageDifference.mean! - 0.8) < 1e-9);
  });

  test("median is correct for both even and odd sample counts", () => {
    const three = evaluateBenchmarkTrials([
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 1 }, treatmentUsage: { modelCalls: 0 } }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 5 }, treatmentUsage: { modelCalls: 0 } }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 9 }, treatmentUsage: { modelCalls: 0 } }),
    ]);
    assert.strictEqual(three.overall.usageComparison.modelCalls.absoluteDifference.median, 5);

    const four = evaluateBenchmarkTrials([
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 1 }, treatmentUsage: { modelCalls: 0 } }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 3 }, treatmentUsage: { modelCalls: 0 } }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 7 }, treatmentUsage: { modelCalls: 0 } }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 9 }, treatmentUsage: { modelCalls: 0 } }),
    ]);
    assert.strictEqual(four.overall.usageComparison.modelCalls.absoluteDifference.median, (3 + 7) / 2);
  });

  test("per-task and overall summaries reconcile: per-task totals sum to the overall total", () => {
    const trials = [
      makeTrial({ taskId: "task-A", condition: "completed", controlPassed: true, treatmentPassed: true }),
      makeTrial({ taskId: "task-A", condition: "no_redirect_candidate", controlPassed: true, treatmentPassed: true }),
      makeTrial({ taskId: "task-B", condition: "control_process_failure" }),
    ];
    const output = evaluateBenchmarkTrials(trials);
    assert.strictEqual(output.overall.accounting.totalTrials, 3);
    assert.strictEqual(output.perTask["task-A"].accounting.totalTrials, 2);
    assert.strictEqual(output.perTask["task-B"].accounting.totalTrials, 1);
    assert.strictEqual(output.perTask["task-A"].accounting.totalTrials + output.perTask["task-B"].accounting.totalTrials, output.overall.accounting.totalTrials);
  });

  test("a task with more valid measurements does not distort another task's own per-task summary, and both expose their own sample counts", () => {
    const manyMeasured = Array.from({ length: 5 }, () => makeTrial({ taskId: "task-heavy", condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 100 }, treatmentUsage: { modelCalls: 1 } }));
    const oneMeasured = [makeTrial({ taskId: "task-light", condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 4 }, treatmentUsage: { modelCalls: 3 } })];
    const output = evaluateBenchmarkTrials([...manyMeasured, ...oneMeasured]);

    assert.strictEqual(output.perTask["task-heavy"].usageComparison.modelCalls.absoluteDifference.n, 5);
    assert.strictEqual(output.perTask["task-light"].usageComparison.modelCalls.absoluteDifference.n, 1);
    assert.strictEqual(output.perTask["task-light"].usageComparison.modelCalls.absoluteDifference.mean, 1, "task-light's own mean must not be pulled toward task-heavy's values");
  });

  test("no-intervention trials remain visible in accounting and taskSuccess, not silently excluded", () => {
    const trials = [makeTrial({ condition: "no_redirect_candidate", controlPassed: true, treatmentPassed: true })];
    const output = evaluateBenchmarkTrials(trials);
    assert.strictEqual(output.overall.accounting.totalTrials, 1);
    assert.strictEqual(output.overall.accounting.noRedirectCandidateTrials, 1);
    assert.strictEqual(output.overall.taskSuccess.pairedOutcomes.controlPass_treatmentPass, 1);
  });

  test("intervention subgroups: delivered vs no-redirect are reported separately, and the no-redirect subgroup's usage comparison is honestly empty under the current M13B contract", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 10 }, treatmentUsage: { modelCalls: 2 } }), // delivered
      makeTrial({ condition: "no_redirect_candidate", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 10 }, treatmentUsage: { modelCalls: 8 } }), // no redirect
    ];
    const output = evaluateBenchmarkTrials(trials);
    assert.strictEqual(output.overall.interventionSubgroups.deliveredRedirect.modelCalls.absoluteDifference.n, 1);
    assert.strictEqual(output.overall.interventionSubgroups.noRedirect.modelCalls.absoluteDifference.n, 0, "comparePairedRun requires a delivered intervention, so no-redirect trials can never have a comparison");
  });

  test("elapsedMs distributions are reported separately for control and treatment, with no difference computed between them", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlElapsedMs: 1000, treatmentElapsedMs: 4000 }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlElapsedMs: 2000, treatmentElapsedMs: 5000 }),
    ];
    const output = evaluateBenchmarkTrials(trials);
    assert.strictEqual(output.overall.elapsedMs.control.mean, 1500);
    assert.strictEqual(output.overall.elapsedMs.treatment.mean, 4500);
    // No field anywhere computes or exposes a difference between these two distributions.
    const outputJson = JSON.stringify(output.overall.elapsedMs);
    assert.ok(!/difference|saved/i.test(outputJson));
  });

  test("no redirect precision/recall or significance language is claimed anywhere in a real output object or the source", () => {
    const trials = [makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true })];
    const output = evaluateBenchmarkTrials(trials);
    const json = JSON.stringify(output).toLowerCase();
    for (const forbidden of ["precision", "recall", "p-value", "pvalue", "confidenceinterval", "significance", "energy", "emission", "sustainab", "leaderboard", "avoidedwaste", "causal"]) {
      assert.ok(!json.includes(forbidden), `forbidden term "${forbidden}" found in output`);
    }
    // Source comments are allowed to mention these terms only as a negation
    // ("never labeled precision", "no p-value") describing the constraint
    // being honored -- only an actual computation/claim (no nearby negation)
    // is a real violation. Matches the same verification pattern already
    // used for M13A/M13B's own "baseline"/"sustainability improvement" checks.
    const fs = require("fs");
    const src = fs.readFileSync("/Users/meenasawant/Drift/src/benchmarkEvaluation.ts", "utf8");
    for (const forbidden of [/\bprecision\b/i, /\brecall\b/i, /p-value/i, /confidence\s*interval/i, /\bsignificance\b/i, /energy\s*estimat/i, /emission/i, /leaderboard/i]) {
      const match = forbidden.exec(src);
      if (!match) continue;
      const context = src.slice(Math.max(0, match.index - 220), match.index + 40);
      assert.ok(/never|no |not /i.test(context), `pattern ${forbidden} matched with no negation nearby (looks like an actual claim): ${context}`);
    }
  });

  test("deterministic: shuffled trial order produces identical numerical results", () => {
    const trials = [
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 10 }, treatmentUsage: { modelCalls: 2 } }),
      makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: false, controlUsage: { modelCalls: 5 }, treatmentUsage: { modelCalls: 1 } }),
      makeTrial({ condition: "no_redirect_candidate", controlPassed: false, treatmentPassed: true }),
      makeTrial({ condition: "control_process_failure" }),
    ];
    const shuffled = [trials[3], trials[1], trials[0], trials[2]];

    const a = evaluateBenchmarkTrials(trials);
    const b = evaluateBenchmarkTrials(shuffled);
    assert.deepStrictEqual(a.overall, b.overall);
  });

  test("does not mutate its input trials array or any trial object", () => {
    const trials = [makeTrial({ condition: "completed", controlPassed: true, treatmentPassed: true, controlUsage: { modelCalls: 5 }, treatmentUsage: { modelCalls: 1 } })];
    const snapshot = JSON.stringify(trials);
    evaluateBenchmarkTrials(trials);
    assert.strictEqual(JSON.stringify(trials), snapshot);
  });

  test("an empty trial set produces an honest all-zero/all-undefined summary, never throwing", () => {
    const output = evaluateBenchmarkTrials([]);
    assert.strictEqual(output.overall.accounting.totalTrials, 0);
    assert.strictEqual(output.overall.successPreservation.rate, undefined);
    assert.strictEqual(output.overall.interventionRates.redirectCandidateRate, undefined);
    assert.strictEqual(output.overall.usageComparison.modelCalls.absoluteDifference.n, 0);
    assert.deepStrictEqual(output.perTask, {});
  });
});
