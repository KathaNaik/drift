/**
 * A pure, descriptive aggregation layer over completed M14B trial results.
 * Every number here is derived by reading M14B's TrialRecord array and
 * M13B's own PairedComparisonResult objects -- nothing is reimplemented
 * from scratch (comparison math stays in comparePairedRun, condition/
 * intervention facts stay exactly as M14B already derived them) and no
 * trial, including a failed or no-intervention one, is ever dropped from
 * the accounting.
 *
 * This module makes no causal, statistical, or sustainability claim: no
 * p-value, confidence interval, effect-size estimate, energy/emissions
 * figure, avoided-waste claim, or precision/recall label appears anywhere
 * here. A rate is always reported next to the explicit count it was
 * divided from, and a distribution is always reported next to its sample
 * size `n`, so a reader can judge how much weight the number deserves
 * without this module deciding that for them.
 */

import { TrialRecord } from "./benchmarkTrials";

const USAGE_FIELDS = ["modelCalls", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "durationMs"] as const;
type UsageFieldName = (typeof USAGE_FIELDS)[number];

export interface NumericDistribution {
  n: number;
  mean: number | undefined;
  median: number | undefined;
  min: number | undefined;
  max: number | undefined;
}

export interface UsageFieldSummary {
  /** Distribution of comparePairedRun()'s own grossDifference.<field>.difference across every trial where it was defined. Same direction as M13B: positive = treatment used less than control. */
  absoluteDifference: NumericDistribution;
  /** Distribution of grossDifference.<field>.percentageDifference, aggregated separately, only over pairs where M13B itself produced a defined percentage (never recomputed here, never backfilled from a zero/undefined control value). */
  percentageDifference: NumericDistribution;
}

export type PairedUsageComparisonSummary = Record<UsageFieldName, UsageFieldSummary>;

export interface RatePassFail {
  passed: number;
  failed: number;
  /** passed / (passed + failed); undefined when there is no evaluable run at all for this side. */
  passRate: number | undefined;
}

export interface PairedOutcomeCounts {
  controlPass_treatmentPass: number;
  controlPass_treatmentFail: number;
  controlFail_treatmentPass: number;
  controlFail_treatmentFail: number;
}

export interface TaskSuccessSummary {
  control: RatePassFail;
  treatment: RatePassFail;
  pairedOutcomes: PairedOutcomeCounts;
}

export interface SuccessPreservationSummary {
  /** count(control pass AND treatment pass). */
  numerator: number;
  /** count(control pass), regardless of whether treatment's own result is available -- a trial where control passed but treatment never produced a result still counts here, honestly pulling the rate down rather than being silently excluded. */
  denominator: number;
  /** numerator / denominator; undefined when denominator is 0 -- never fabricated as 0 or 1. */
  rate: number | undefined;
}

export interface TrialAccounting {
  totalTrials: number;
  /** Trials whose condition is exactly "completed" (see benchmarkTrials.ts's TrialCondition). */
  completedTrials: number;
  controlProcessFailures: number;
  treatmentProcessFailures: number;
  evaluatorFailures: number;
  /** Trials whose condition is exactly "no_redirect_candidate" -- treatment ran its own turn and objectively found nothing, as distinct from a trial where treatment never got the chance to look (counted under treatmentProcessFailures instead). */
  noRedirectCandidateTrials: number;
  /**
   * Trials where a redirect_candidate genuinely emerged at any point
   * (intervention.redirectCandidateOccurred), independent of whether
   * control or the evaluator also succeeded -- this is a fact about what
   * treatment's own analysis found, not a statement about the whole pair's
   * condition. Because of that, redirectCandidateTrials + noRedirectCandidateTrials
   * does not necessarily equal totalTrials (a treatment process failure
   * contributes to neither): the condition-based counts above are the ones
   * that reconcile exactly to totalTrials.
   */
  redirectCandidateTrials: number;
  approvedRedirectTrials: number;
  deliveredRedirectTrials: number;
  consumedRedirectTrials: number;
}

export interface InterventionRateSummary {
  /** totalTrials - treatmentProcessFailures: treatment runs that got far enough to be analyzed at all. */
  eligibleTreatmentTrials: number;
  /** redirectCandidateTrials / eligibleTreatmentTrials; undefined when the denominator is 0. Descriptive only -- never labeled precision or recall. */
  redirectCandidateRate: number | undefined;
  /** deliveredRedirectTrials / approvedRedirectTrials; undefined when the denominator is 0. */
  deliveryRate: number | undefined;
}

export interface BenchmarkEvaluationSummary {
  accounting: TrialAccounting;
  taskSuccess: TaskSuccessSummary;
  successPreservation: SuccessPreservationSummary;
  interventionRates: InterventionRateSummary;
  usageComparison: PairedUsageComparisonSummary;
  /** Separately-measured M13C wall-clock elapsedMs for each side -- reported as two distributions, never combined into a difference or a "saved time" claim (see requirement 9 / M13B.1's own netDifference.durationMs, which stays undefined). */
  elapsedMs: { control: NumericDistribution; treatment: NumericDistribution };
  /**
   * Observational-only subgroup breakdown by whether a redirect was
   * actually delivered in that trial's treatment run. Never a causal claim:
   * a difference between these two subgroups is not evidence the redirect
   * caused it. The "no redirect" subgroup's usageComparison is always
   * empty (n: 0 everywhere) under the current M13B contract, since
   * comparePairedRun() requires a delivered InterventionRecord to produce
   * any comparison at all -- an honest reflection of what can be measured
   * today, not a bug.
   */
  interventionSubgroups: {
    deliveredRedirect: PairedUsageComparisonSummary;
    noRedirect: PairedUsageComparisonSummary;
  };
}

export interface BenchmarkEvaluationOutput {
  overall: BenchmarkEvaluationSummary;
  /** Same structure as `overall`, scoped to each distinct taskId -- so a task with more valid measurements can never silently dominate a claimed "typical" result; every summary carries its own explicit sample counts. */
  perTask: Record<string, BenchmarkEvaluationSummary>;
}

function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

function median(sortedValues: number[]): number | undefined {
  if (sortedValues.length === 0) return undefined;
  const mid = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function summarizeNumbers(values: number[]): NumericDistribution {
  if (values.length === 0) {
    return { n: 0, mean: undefined, median: undefined, min: undefined, max: undefined };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return { n: values.length, mean: mean(values), median: median(sorted), min: sorted[0], max: sorted[sorted.length - 1] };
}

function collectUsageField(trials: TrialRecord[], field: UsageFieldName): UsageFieldSummary {
  const absoluteValues: number[] = [];
  const percentageValues: number[] = [];
  for (const trial of trials) {
    if (!trial.comparison) continue;
    const fieldDiff = trial.comparison.grossDifference[field];
    if (fieldDiff.difference !== undefined) absoluteValues.push(fieldDiff.difference);
    if (fieldDiff.percentageDifference !== undefined) percentageValues.push(fieldDiff.percentageDifference);
  }
  return { absoluteDifference: summarizeNumbers(absoluteValues), percentageDifference: summarizeNumbers(percentageValues) };
}

function buildUsageComparison(trials: TrialRecord[]): PairedUsageComparisonSummary {
  const result = {} as PairedUsageComparisonSummary;
  for (const field of USAGE_FIELDS) {
    result[field] = collectUsageField(trials, field);
  }
  return result;
}

function buildAccounting(trials: TrialRecord[]): TrialAccounting {
  let completedTrials = 0;
  let controlProcessFailures = 0;
  let treatmentProcessFailures = 0;
  let evaluatorFailures = 0;
  let noRedirectCandidateTrials = 0;
  let redirectCandidateTrials = 0;
  let approvedRedirectTrials = 0;
  let deliveredRedirectTrials = 0;
  let consumedRedirectTrials = 0;

  for (const trial of trials) {
    switch (trial.condition) {
      case "completed":
        completedTrials++;
        break;
      case "control_process_failure":
        controlProcessFailures++;
        break;
      case "treatment_process_failure":
        treatmentProcessFailures++;
        break;
      case "evaluator_failure":
        evaluatorFailures++;
        break;
      case "no_redirect_candidate":
        noRedirectCandidateTrials++;
        break;
      case "redirect_approved_not_delivered":
        // Counted below via the intervention flags (approvedRedirectTrials
        // without deliveredRedirectTrials already makes this visible) --
        // no separate top-level field for this condition, per the
        // milestone's own explicit "always report" list.
        break;
    }
    if (trial.intervention.redirectCandidateOccurred) redirectCandidateTrials++;
    if (trial.intervention.packetApproved) approvedRedirectTrials++;
    if (trial.intervention.delivered) deliveredRedirectTrials++;
    if (trial.intervention.consumed) consumedRedirectTrials++;
  }

  return {
    totalTrials: trials.length,
    completedTrials,
    controlProcessFailures,
    treatmentProcessFailures,
    evaluatorFailures,
    noRedirectCandidateTrials,
    redirectCandidateTrials,
    approvedRedirectTrials,
    deliveredRedirectTrials,
    consumedRedirectTrials,
  };
}

function buildTaskSuccess(trials: TrialRecord[]): TaskSuccessSummary {
  let controlPassed = 0;
  let controlFailed = 0;
  let treatmentPassed = 0;
  let treatmentFailed = 0;
  const pairedOutcomes: PairedOutcomeCounts = { controlPass_treatmentPass: 0, controlPass_treatmentFail: 0, controlFail_treatmentPass: 0, controlFail_treatmentFail: 0 };

  for (const trial of trials) {
    // Explicit evaluator results only -- never Claude's own response, SessionEnd, or M11C's buildOutcome.
    const controlResult = trial.benchmarkResult.control.taskResult;
    const treatmentResult = trial.benchmarkResult.treatment.taskResult;

    if (controlResult !== undefined) {
      if (controlResult.passed) controlPassed++;
      else controlFailed++;
    }
    if (treatmentResult !== undefined) {
      if (treatmentResult.passed) treatmentPassed++;
      else treatmentFailed++;
    }

    if (controlResult !== undefined && treatmentResult !== undefined) {
      if (controlResult.passed && treatmentResult.passed) pairedOutcomes.controlPass_treatmentPass++;
      else if (controlResult.passed && !treatmentResult.passed) pairedOutcomes.controlPass_treatmentFail++;
      else if (!controlResult.passed && treatmentResult.passed) pairedOutcomes.controlFail_treatmentPass++;
      else pairedOutcomes.controlFail_treatmentFail++;
    }
  }

  return {
    control: { passed: controlPassed, failed: controlFailed, passRate: controlPassed + controlFailed === 0 ? undefined : controlPassed / (controlPassed + controlFailed) },
    treatment: { passed: treatmentPassed, failed: treatmentFailed, passRate: treatmentPassed + treatmentFailed === 0 ? undefined : treatmentPassed / (treatmentPassed + treatmentFailed) },
    pairedOutcomes,
  };
}

function buildSuccessPreservation(trials: TrialRecord[]): SuccessPreservationSummary {
  let numerator = 0;
  let denominator = 0;

  for (const trial of trials) {
    const controlResult = trial.benchmarkResult.control.taskResult;
    if (controlResult === undefined || !controlResult.passed) continue; // control-failing (or unevaluable) trials are neither preserved nor regressed -- excluded from both numerator and denominator.
    denominator++;
    const treatmentResult = trial.benchmarkResult.treatment.taskResult;
    if (treatmentResult !== undefined && treatmentResult.passed) numerator++;
  }

  return { numerator, denominator, rate: denominator === 0 ? undefined : numerator / denominator };
}

function buildInterventionRates(accounting: TrialAccounting): InterventionRateSummary {
  const eligibleTreatmentTrials = accounting.totalTrials - accounting.treatmentProcessFailures;
  return {
    eligibleTreatmentTrials,
    redirectCandidateRate: eligibleTreatmentTrials === 0 ? undefined : accounting.redirectCandidateTrials / eligibleTreatmentTrials,
    deliveryRate: accounting.approvedRedirectTrials === 0 ? undefined : accounting.deliveredRedirectTrials / accounting.approvedRedirectTrials,
  };
}

function buildElapsedMs(trials: TrialRecord[]): { control: NumericDistribution; treatment: NumericDistribution } {
  return {
    control: summarizeNumbers(trials.map((t) => t.benchmarkResult.control.elapsedMs)),
    treatment: summarizeNumbers(trials.map((t) => t.benchmarkResult.treatment.elapsedMs)),
  };
}

function summarizeTrialSet(trials: TrialRecord[]): BenchmarkEvaluationSummary {
  const accounting = buildAccounting(trials);
  const delivered = trials.filter((t) => t.intervention.delivered);
  const noRedirect = trials.filter((t) => !t.intervention.redirectCandidateOccurred);

  return {
    accounting,
    taskSuccess: buildTaskSuccess(trials),
    successPreservation: buildSuccessPreservation(trials),
    interventionRates: buildInterventionRates(accounting),
    usageComparison: buildUsageComparison(trials),
    elapsedMs: buildElapsedMs(trials),
    interventionSubgroups: {
      deliveredRedirect: buildUsageComparison(delivered),
      noRedirect: buildUsageComparison(noRedirect),
    },
  };
}

/**
 * Aggregates a completed M14B trial set into descriptive overall and
 * per-task summaries. Pure and deterministic: the same trials in any order
 * produce the same numbers (every aggregate here is order-independent by
 * construction), and `trials` is never mutated.
 */
export function evaluateBenchmarkTrials(trials: TrialRecord[]): BenchmarkEvaluationOutput {
  const byTask = new Map<string, TrialRecord[]>();
  for (const trial of trials) {
    const existing = byTask.get(trial.taskId);
    if (existing) existing.push(trial);
    else byTask.set(trial.taskId, [trial]);
  }

  const perTask: Record<string, BenchmarkEvaluationSummary> = {};
  for (const [taskId, taskTrials] of byTask) {
    perTask[taskId] = summarizeTrialSet(taskTrials);
  }

  return { overall: summarizeTrialSet(trials), perTask };
}
