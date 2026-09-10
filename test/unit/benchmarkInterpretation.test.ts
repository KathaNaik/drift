import * as assert from "assert";
import * as fs from "fs";
import { UsageSummary } from "../../src/trajectoryUsageAttribution";
import { DriftOverhead, InterventionRecord } from "../../src/interventionMeasurement";
import { TaskResult, comparePairedRun, PairedComparisonResult } from "../../src/pairedComparison";
import { TrialRecord, InterventionOccurrence } from "../../src/benchmarkTrials";
import { interpretBenchmarkResults } from "../../src/benchmarkInterpretation";

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
function taskResultFixture(passed: boolean): TaskResult {
  return { passed, evaluator: "fixture-evaluator" };
}

let counter = 0;

interface MakeTrialOptions {
  taskId?: string;
  redirectOutcome: "not_attempted" | "no_candidate" | "rejected" | "delivered" | "delivery_failed";
  controlPassed?: boolean; // undefined => no taskResult at all (control crashed)
  treatmentPassed?: boolean; // undefined => no taskResult at all (treatment crashed)
  controlUsage?: Partial<UsageSummary>;
  treatmentUsage?: Partial<UsageSummary>;
  controlElapsedMs?: number;
  treatmentElapsedMs?: number;
  driftOverhead?: Partial<DriftOverhead>;
  interventionOverride?: Partial<InterventionOccurrence>;
  mismatchedComparisonTaskId?: string; // defensive test hook for the task_id_mismatch guard
}

function makeTrial(opts: MakeTrialOptions): TrialRecord {
  counter++;
  const taskId = opts.taskId ?? "task-default";
  const controlSessionId = `control-${counter}`;
  const treatmentSessionId = `treatment-${counter}`;

  const controlTaskResult = opts.controlPassed === undefined ? undefined : taskResultFixture(opts.controlPassed);
  const treatmentTaskResult = opts.treatmentPassed === undefined ? undefined : taskResultFixture(opts.treatmentPassed);
  const cUsage = usage(opts.controlUsage);
  const tUsage = usage(opts.treatmentUsage);
  const dOverhead = overhead(opts.driftOverhead);

  let comparison: PairedComparisonResult | undefined;
  let intervention: InterventionOccurrence;

  if (opts.redirectOutcome === "delivered") {
    intervention = { redirectCandidateOccurred: true, packetApproved: true, delivered: true, consumed: true, ...opts.interventionOverride };
    if (controlTaskResult !== undefined && treatmentTaskResult !== undefined) {
      const result = comparePairedRun({
        taskId,
        control: { sessionId: controlSessionId, usage: cUsage, taskResult: controlTaskResult },
        treatment: { sessionId: treatmentSessionId, usage: tUsage, driftOverhead: dOverhead, intervention: interventionRecord(treatmentSessionId), taskResult: treatmentTaskResult },
      });
      if (!result.success) throw new Error("fixture build failed: " + result.error);
      comparison = result.comparison;
      if (opts.mismatchedComparisonTaskId) {
        comparison = { ...comparison!, taskId: opts.mismatchedComparisonTaskId };
      }
    }
  } else if (opts.redirectOutcome === "delivery_failed") {
    intervention = { redirectCandidateOccurred: true, packetApproved: true, delivered: false, consumed: false, ...opts.interventionOverride };
  } else if (opts.redirectOutcome === "rejected") {
    intervention = { redirectCandidateOccurred: true, packetApproved: false, delivered: false, consumed: false, ...opts.interventionOverride };
  } else {
    intervention = { redirectCandidateOccurred: false, packetApproved: false, delivered: false, consumed: false, ...opts.interventionOverride };
  }

  const condition =
    opts.controlPassed === undefined ? "control_process_failure" : opts.treatmentPassed === undefined && opts.redirectOutcome !== "not_attempted" ? "completed" : opts.redirectOutcome === "not_attempted" ? "treatment_process_failure" : opts.redirectOutcome === "no_candidate" ? "no_redirect_candidate" : opts.redirectOutcome === "delivery_failed" ? "redirect_approved_not_delivered" : "completed";

  return {
    taskId,
    repetitionIndex: counter,
    order: counter % 2 === 0 ? "control-first" : "treatment-first",
    controlSessionId,
    treatmentSessionId,
    workspaceFingerprint: `fp-${taskId}`,
    condition: condition as TrialRecord["condition"],
    intervention,
    comparison,
    comparisonUnavailableReason: comparison === undefined ? "fixture: no comparison" : undefined,
    benchmarkResult: {
      taskId,
      settings: { model: "m", allowedTools: [], permissionMode: "acceptEdits", env: {} },
      control: {
        sessionId: controlSessionId,
        workspace: "/tmp/c",
        startedAt: 0,
        completedAt: opts.controlElapsedMs ?? 1000,
        elapsedMs: opts.controlElapsedMs ?? 1000,
        usage: opts.controlPassed === undefined ? undefined : cUsage,
        taskResult: controlTaskResult,
        claudeError: opts.controlPassed === undefined ? "control crashed" : undefined,
        evaluatorError: undefined,
      },
      treatment: {
        sessionId: treatmentSessionId,
        workspace: "/tmp/t",
        startedAt: 0,
        completedAt: opts.treatmentElapsedMs ?? 1000,
        elapsedMs: opts.treatmentElapsedMs ?? 1000,
        usage: opts.redirectOutcome === "not_attempted" ? undefined : tUsage,
        taskResult: treatmentTaskResult,
        claudeError: opts.redirectOutcome === "not_attempted" ? "treatment crashed" : undefined,
        evaluatorError: undefined,
        driftOverhead: opts.redirectOutcome === "delivered" ? dOverhead : undefined,
        intervention: opts.redirectOutcome === "delivered" ? interventionRecord(treatmentSessionId) : undefined,
        redirectOutcome: opts.redirectOutcome,
      },
    },
  };
}

suite("benchmarkInterpretation (M15A)", () => {
  test("only success-preserving delivered-intervention pairs contribute to avoided-compute accounting", () => {
    const eligible = makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 10 }, treatmentUsage: { modelCalls: 3 } });
    const ineligible = makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "no_candidate" });
    const result = interpretBenchmarkResults([eligible, ineligible]);

    assert.strictEqual(result.benchmarkEvidence.eligiblePairs, 1);
    assert.strictEqual(result.benchmarkEvidence.excludedPairs, 1);
    assert.strictEqual(result.targetModelCompute.modelCalls.n, 1);
    assert.strictEqual(result.targetModelCompute.modelCalls.total, 7);
  });

  test("exclusion reasons are explicit and correct for each individually disqualifying condition", () => {
    const controlFailed = makeTrial({ controlPassed: false, treatmentPassed: true, redirectOutcome: "delivered" });
    const treatmentFailed = makeTrial({ controlPassed: true, treatmentPassed: false, redirectOutcome: "delivered" });
    const noComparison = makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "no_candidate" });
    const notDelivered = makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivery_failed" });

    const result = interpretBenchmarkResults([controlFailed, treatmentFailed, noComparison, notDelivered]);
    assert.strictEqual(result.exclusions.length, 4);

    const byRepIndex = new Map(result.exclusions.map((e) => [e.repetitionIndex, e.reasons]));
    assert.deepStrictEqual(byRepIndex.get(controlFailed.repetitionIndex), ["control_not_passed"]);
    assert.deepStrictEqual(byRepIndex.get(treatmentFailed.repetitionIndex), ["treatment_not_passed"]);
    assert.deepStrictEqual(byRepIndex.get(noComparison.repetitionIndex), ["no_valid_comparison", "redirect_not_delivered"]);
    assert.deepStrictEqual(byRepIndex.get(notDelivered.repetitionIndex), ["no_valid_comparison", "redirect_not_delivered"]);
  });

  test("a trial failing multiple conditions at once reports every applicable reason, not just the first", () => {
    const trial = makeTrial({ controlPassed: false, treatmentPassed: false, redirectOutcome: "no_candidate" });
    const result = interpretBenchmarkResults([trial]);
    assert.deepStrictEqual(result.exclusions[0].reasons, ["control_not_passed", "treatment_not_passed", "no_valid_comparison", "redirect_not_delivered"]);
  });

  test("no trial disappears silently: excludedPairs + eligiblePairs equals totalTrials", () => {
    const trials = [
      makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered" }),
      makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "no_candidate" }),
      makeTrial({ controlPassed: false, treatmentPassed: undefined, redirectOutcome: "not_attempted" }),
      makeTrial({ controlPassed: true, treatmentPassed: false, redirectOutcome: "delivery_failed" }),
    ];
    const result = interpretBenchmarkResults(trials);
    assert.strictEqual(result.benchmarkEvidence.totalTrials, 4);
    assert.strictEqual(result.benchmarkEvidence.eligiblePairs + result.benchmarkEvidence.excludedPairs, 4);
  });

  test("observed target-model compute difference reuses M13B's own grossDifference math verbatim (positive and negative)", () => {
    const trials = [
      makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 10, inputTokens: 200, costUsd: 0.5 }, treatmentUsage: { modelCalls: 2, inputTokens: 50, costUsd: 0.1 } }),
      makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 3, inputTokens: 30, costUsd: 0.05 }, treatmentUsage: { modelCalls: 9, inputTokens: 90, costUsd: 0.2 } }), // treatment used MORE -- negative
    ];
    const result = interpretBenchmarkResults(trials);
    const mc = result.targetModelCompute.modelCalls;
    assert.strictEqual(mc.n, 2);
    assert.strictEqual(mc.total, 8 + -6);
    assert.strictEqual(mc.mean, (8 + -6) / 2);
    assert.strictEqual(mc.min, -6, "the negative difference must be preserved as the minimum, never clamped to 0");
    assert.strictEqual(mc.max, 8);

    const cost = result.targetModelCompute.costUsd;
    assert.ok(Math.abs(cost.total! - (0.4 + -0.15)) < 1e-9);
  });

  test("Drift overhead is reported separately from target-model compute and is never combined with Claude token fields", () => {
    const trial = makeTrial({
      controlPassed: true,
      treatmentPassed: true,
      redirectOutcome: "delivered",
      controlUsage: { inputTokens: 1000 },
      treatmentUsage: { inputTokens: 900 },
      driftOverhead: { localInferenceCount: 3, localInferenceDurationMs: 800, localInferenceInputTokens: 6000, localInferenceOutputTokens: 1200, redirectPacketSizeBytes: 512, analysisDurationMs: 850 },
    });
    const result = interpretBenchmarkResults([trial]);

    assert.strictEqual(result.driftOverhead.localInferenceCount.total, 3);
    assert.strictEqual(result.driftOverhead.localInferenceInputTokens.total, 6000);
    assert.strictEqual(result.driftOverhead.analysisDurationMs.total, 850);
    // The huge local-model token count must never leak into targetModelCompute's Claude-token fields.
    assert.strictEqual(result.targetModelCompute.inputTokens.total, 100, "1000 - 900, unaffected by the 6000 local tokens");
  });

  test("netCostUsd is always undefined -- Drift's local inference has no measured monetary cost", () => {
    const trial = makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { costUsd: 5 }, treatmentUsage: { costUsd: 1 } });
    const result = interpretBenchmarkResults([trial]);
    assert.strictEqual(result.sustainability.netCostUsd, undefined);
  });

  test("pairedElapsedDifferenceMs uses M13C's own end-to-end elapsedMs, never M7's target-model durationMs", () => {
    const trial = makeTrial({
      controlPassed: true,
      treatmentPassed: true,
      redirectOutcome: "delivered",
      controlElapsedMs: 10000,
      treatmentElapsedMs: 6000,
      controlUsage: { durationMs: 999999 }, // deliberately absurd M7 durationMs values to prove they're never used here
      treatmentUsage: { durationMs: 1 },
    });
    const result = interpretBenchmarkResults([trial]);
    assert.strictEqual(result.elapsedTime.pairedElapsedDifferenceMs.total, 4000, "must be 10000-6000, not derived from the M7 durationMs values");
  });

  test("Drift's own analysisDurationMs is never added to or subtracted from pairedElapsedDifferenceMs (it is already inside treatment's elapsedMs)", () => {
    const base = { controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered" as const, controlElapsedMs: 10000, treatmentElapsedMs: 6000 };
    const withSmallOverhead = makeTrial({ ...base, driftOverhead: { analysisDurationMs: 100 } });
    const withHugeOverhead = makeTrial({ ...base, driftOverhead: { analysisDurationMs: 999999 } });

    const r1 = interpretBenchmarkResults([withSmallOverhead]);
    const r2 = interpretBenchmarkResults([withHugeOverhead]);
    assert.strictEqual(r1.elapsedTime.pairedElapsedDifferenceMs.total, 4000);
    assert.strictEqual(r2.elapsedTime.pairedElapsedDifferenceMs.total, 4000, "analysisDurationMs must never be added into the elapsed-time difference");
  });

  test("task-success guard: control passed + treatment failed + treatment used fewer tokens is excluded from avoided-compute accounting, never called beneficial", () => {
    const trial = makeTrial({ controlPassed: true, treatmentPassed: false, redirectOutcome: "delivered", controlUsage: { modelCalls: 10 }, treatmentUsage: { modelCalls: 1 } });
    const result = interpretBenchmarkResults([trial]);
    assert.strictEqual(result.benchmarkEvidence.eligiblePairs, 0);
    assert.deepStrictEqual(result.exclusions[0].reasons, ["treatment_not_passed"]);
    assert.strictEqual(result.targetModelCompute.modelCalls.n, 0, "the reduced-token-usage difference must not enter avoided-compute accounting despite the raw numbers looking favorable");
  });

  test("aggregate accounting exposes explicit denominators: eligiblePairs, excludedPairs, successPreservationRate, deliveredRedirectTrials, noRedirectCandidateTrials", () => {
    const trials = [
      makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered" }),
      makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "no_candidate" }),
      makeTrial({ controlPassed: true, treatmentPassed: false, redirectOutcome: "no_candidate" }),
    ];
    const result = interpretBenchmarkResults(trials);
    assert.strictEqual(result.benchmarkEvidence.eligiblePairs, 1);
    assert.strictEqual(result.benchmarkEvidence.excludedPairs, 2);
    assert.ok(Math.abs(result.benchmarkEvidence.successPreservationRate! - 2 / 3) < 1e-9, "2 of 3 control-passing trials also had treatment pass");
    assert.strictEqual(result.interventionBehavior.deliveredRedirectTrials, 1);
    assert.strictEqual(result.interventionBehavior.noRedirectCandidateTrials, 2);
  });

  test("a finding/redirect alone (without an eligible matched pair) never counts as avoided compute", () => {
    // Delivered, but treatment failed -- a real redirect was delivered, yet must not count.
    const trial = makeTrial({ controlPassed: true, treatmentPassed: false, redirectOutcome: "delivered", controlUsage: { modelCalls: 20 }, treatmentUsage: { modelCalls: 1 } });
    const result = interpretBenchmarkResults([trial]);
    assert.strictEqual(result.interventionBehavior.deliveredRedirectTrials, 1, "the delivery itself is still visible");
    assert.strictEqual(result.targetModelCompute.modelCalls.n, 0, "but it must not contribute to avoided compute since the pair is not eligible");
  });

  test("no-intervention trials remain visible but are not treated as a zero avoided-compute data point (excluded from n entirely, never averaged in as 0)", () => {
    const eligible = makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 10 }, treatmentUsage: { modelCalls: 8 } }); // diff = 2
    const noRedirect = makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "no_candidate" });
    const result = interpretBenchmarkResults([eligible, noRedirect]);

    assert.strictEqual(result.interventionBehavior.noRedirectCandidateTrials, 1);
    assert.strictEqual(result.targetModelCompute.modelCalls.n, 1, "only the eligible pair contributes -- the no-redirect trial is excluded, not counted as a 0");
    assert.strictEqual(result.targetModelCompute.modelCalls.mean, 2, "must not be diluted toward 1 by treating the no-redirect trial as a 0");
  });

  test("negative results are preserved: an eligible pair where treatment used more compute is never clamped to zero or omitted", () => {
    const trial = makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 2 }, treatmentUsage: { modelCalls: 9 } });
    const result = interpretBenchmarkResults([trial]);
    assert.strictEqual(result.targetModelCompute.modelCalls.n, 1);
    assert.strictEqual(result.targetModelCompute.modelCalls.total, -7);
    assert.strictEqual(result.targetModelCompute.modelCalls.mean, -7);
  });

  test("when all eligible results show no benefit, the aggregate mean is negative or zero -- reported honestly, not hidden or reframed", () => {
    const trials = [
      makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 2 }, treatmentUsage: { modelCalls: 5 } }),
      makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 3 }, treatmentUsage: { modelCalls: 6 } }),
    ];
    const result = interpretBenchmarkResults(trials);
    assert.ok(result.targetModelCompute.modelCalls.mean! < 0);
    assert.strictEqual(result.sustainability.benchmarkEstimatedAvoidedComputeAvailable, true, "evidence exists (2 eligible pairs) even though it shows no benefit -- availability of evidence is not the same as a favorable result");
  });

  test("energy and carbon are always explicitly not_measured, never a fabricated figure", () => {
    const trials = [makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 10 }, treatmentUsage: { modelCalls: 2 } })];
    const result = interpretBenchmarkResults(trials);
    assert.strictEqual(result.sustainability.energyImpact, "not_measured");
    assert.strictEqual(result.sustainability.carbonImpact, "not_measured");
  });

  test("benchmarkEstimatedAvoidedComputeAvailable is false when there are zero eligible pairs", () => {
    const result = interpretBenchmarkResults([makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "no_candidate" })]);
    assert.strictEqual(result.sustainability.benchmarkEstimatedAvoidedComputeAvailable, false);
    assert.strictEqual(result.targetModelCompute.modelCalls.n, 0);
  });

  test("the final interpretation object exposes the required semantic sections", () => {
    const result = interpretBenchmarkResults([makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered" })]);
    for (const key of ["benchmarkEvidence", "interventionBehavior", "targetModelCompute", "elapsedTime", "driftOverhead", "sustainability", "exclusions"]) {
      assert.ok(key in result, `missing top-level key: ${key}`);
    }
  });

  test("deterministic: shuffled trial order produces identical numerical results", () => {
    const trials = [
      makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 9 }, treatmentUsage: { modelCalls: 1 } }),
      makeTrial({ controlPassed: true, treatmentPassed: false, redirectOutcome: "no_candidate" }),
      makeTrial({ controlPassed: false, treatmentPassed: true, redirectOutcome: "delivery_failed" }),
      makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 3 }, treatmentUsage: { modelCalls: 7 } }),
    ];
    const shuffled = [trials[3], trials[1], trials[0], trials[2]];
    const a = interpretBenchmarkResults(trials);
    const b = interpretBenchmarkResults(shuffled);
    assert.deepStrictEqual({ ...a, exclusions: undefined }, { ...b, exclusions: undefined });
    assert.strictEqual(a.exclusions.length, b.exclusions.length);
  });

  test("does not mutate its input trials", () => {
    const trials = [makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 5 }, treatmentUsage: { modelCalls: 1 } })];
    const snapshot = JSON.stringify(trials);
    interpretBenchmarkResults(trials);
    assert.strictEqual(JSON.stringify(trials), snapshot);
  });

  test("an empty trial set produces an honest, all-empty interpretation without throwing", () => {
    const result = interpretBenchmarkResults([]);
    assert.strictEqual(result.benchmarkEvidence.totalTrials, 0);
    assert.strictEqual(result.benchmarkEvidence.eligiblePairs, 0);
    assert.strictEqual(result.sustainability.benchmarkEstimatedAvoidedComputeAvailable, false);
    assert.strictEqual(result.targetModelCompute.modelCalls.n, 0);
    assert.deepStrictEqual(result.exclusions, []);
  });

  test("no energy/carbon/statistical-significance/marketing-claim computation appears anywhere in a real output or the source (only as documented negations)", () => {
    const trials = [makeTrial({ controlPassed: true, treatmentPassed: true, redirectOutcome: "delivered", controlUsage: { modelCalls: 10 }, treatmentUsage: { modelCalls: 2 } })];
    const result = interpretBenchmarkResults(trials);
    const json = JSON.stringify(result).toLowerCase();
    for (const forbidden of ["joule", "kwh", "co2", "carbon avoided", "emissions saved", "p-value", "significan", "leaderboard", "drift saves"]) {
      assert.ok(!json.includes(forbidden), `forbidden term "${forbidden}" found in a real output object`);
    }

    const src = fs.readFileSync("/Users/meenasawant/Drift/src/benchmarkInterpretation.ts", "utf8");
    const patterns = [/joule/i, /kwh/i, /co2/i, /carbon\s+avoided/i, /emissions?\s+saved/i, /p-value/i, /significan/i, /leaderboard/i];
    for (const pattern of patterns) {
      const match = pattern.exec(src);
      if (!match) continue;
      const context = src.slice(Math.max(0, match.index - 220), match.index + 60);
      assert.ok(/never|no |not |does not|doesn't/i.test(context), `pattern ${pattern} matched with no negation nearby: ${context}`);
    }
  });
});
