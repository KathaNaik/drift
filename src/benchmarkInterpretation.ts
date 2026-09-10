/**
 * The final accounting layer over M14B's raw trials and M14C's own
 * aggregation. This is the first module in the project allowed to compute
 * an "avoided compute" estimate -- and it does so conservatively: only a
 * trial where control passed, treatment passed, a real M13B comparison
 * exists, and treatment actually received a delivered/consumed redirect
 * may contribute. Every other trial is excluded from that specific
 * accounting, with the exclusion reason(s) recorded explicitly -- never
 * silently dropped, and still fully visible in the inherited M14C
 * `benchmarkEvidence` (which never filters anything).
 *
 * Terminology discipline carries forward from M13B/M13B.1/M14C: this
 * module reports an "observed paired reduction" and a "benchmark-estimated
 * avoided compute" figure grounded in the exact eligible pairs used to
 * compute it -- never a general "Drift saves X%" product claim, never an
 * energy/carbon figure (token counts are not energy measurements), and
 * never a finding or a delivered redirect alone counted as avoided compute.
 * A finding is detected waste; only a matched, eligible benchmark pair is
 * evidence of avoided compute, and the two are never conflated here.
 */

import { TrialRecord } from "./benchmarkTrials";
import { evaluateBenchmarkTrials } from "./benchmarkEvaluation";

const TARGET_MODEL_FIELDS = ["modelCalls", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "durationMs"] as const;
type TargetModelFieldName = (typeof TARGET_MODEL_FIELDS)[number];

const DRIFT_OVERHEAD_FIELDS = ["localInferenceCount", "localInferenceDurationMs", "localInferenceInputTokens", "localInferenceOutputTokens", "analysisDurationMs", "redirectPacketSizeBytes"] as const;
type DriftOverheadFieldName = (typeof DRIFT_OVERHEAD_FIELDS)[number];

export type ExclusionReason = "control_not_passed" | "treatment_not_passed" | "no_valid_comparison" | "redirect_not_delivered" | "task_id_mismatch";

export interface ExclusionRecord {
  taskId: string;
  repetitionIndex: number;
  reasons: ExclusionReason[];
}

/** A generic n/total/mean/median/min/max distribution -- used both for a control-minus-treatment difference (target-model compute, elapsed time) and for a raw measured value with nothing to diff against (Drift's own overhead). Never clamped, never zero-filled: `n` reflects only pairs where the underlying value was actually defined. */
export interface AggregatedMetric {
  n: number;
  total: number | undefined;
  mean: number | undefined;
  median: number | undefined;
  min: number | undefined;
  max: number | undefined;
}

export type TargetModelComputeSummary = Record<TargetModelFieldName, AggregatedMetric>;
export type DriftOverheadSummary = Record<DriftOverheadFieldName, AggregatedMetric>;

export interface BenchmarkEvidenceSummary {
  totalTrials: number;
  eligiblePairs: number;
  excludedPairs: number;
  /** Reused verbatim from M14C -- never recomputed here. */
  successPreservationRate: number | undefined;
}

export interface InterventionBehaviorSummary {
  /** Reused verbatim from M14C. A separate, non-zero category -- never treated as "zero avoided compute". */
  noRedirectCandidateTrials: number;
  deliveredRedirectTrials: number;
}

export interface ElapsedTimeSummary {
  /** control.elapsedMs - treatment.elapsedMs per eligible pair, both M13C's own end-to-end wall-clock measurements (which already include Drift's own analysis/injection time on the treatment side -- never added or subtracted again here). Positive = treatment completed faster. Never derived from M7's target-model/request durationMs. */
  pairedElapsedDifferenceMs: AggregatedMetric;
}

export interface SustainabilitySummary {
  /** True only when at least one eligible pair exists to draw evidence from -- says nothing about whether that evidence is favorable. */
  benchmarkEstimatedAvoidedComputeAvailable: boolean;
  /** Always undefined: Drift's local inference has no measured monetary cost field (see DriftOverhead / NetDifference.costUsd) -- never assumed to be free. */
  netCostUsd: number | undefined;
  /** Never computed from token counts. */
  energyImpact: "not_measured";
  carbonImpact: "not_measured";
}

export interface BenchmarkInterpretation {
  benchmarkEvidence: BenchmarkEvidenceSummary;
  interventionBehavior: InterventionBehaviorSummary;
  /** "Observed paired reduction" per field, aggregated only across eligible pairs -- this is the benchmark-estimated avoided compute referred to by `sustainability.benchmarkEstimatedAvoidedComputeAvailable`. Reuses M13B's own grossDifference math verbatim; nothing here is recomputed. */
  targetModelCompute: TargetModelComputeSummary;
  elapsedTime: ElapsedTimeSummary;
  /** Drift's own local-model cost, reported as raw values (never a difference -- control has no Drift overhead to diff against), and never combined with targetModelCompute's Claude-token fields. */
  driftOverhead: DriftOverheadSummary;
  sustainability: SustainabilitySummary;
  /** Every non-eligible trial, with its own explicit reason(s) -- no trial disappears silently. */
  exclusions: ExclusionRecord[];
}

function median(sortedValues: number[]): number | undefined {
  if (sortedValues.length === 0) return undefined;
  const mid = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 1 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function summarizeMetric(values: number[]): AggregatedMetric {
  if (values.length === 0) {
    return { n: 0, total: undefined, mean: undefined, median: undefined, min: undefined, max: undefined };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((a, b) => a + b, 0);
  return { n: values.length, total, mean: total / values.length, median: median(sorted), min: sorted[0], max: sorted[sorted.length - 1] };
}

/**
 * Eligibility per requirement 1: control passed, treatment passed, a real
 * M13B comparison exists, and treatment's redirect was actually delivered.
 * Every applicable reason is collected (not just the first), so a trial
 * failing multiple conditions at once is fully explained.
 */
function deriveEligibility(trial: TrialRecord): { eligible: boolean; reasons: ExclusionReason[] } {
  const reasons: ExclusionReason[] = [];
  const controlResult = trial.benchmarkResult.control.taskResult;
  const treatmentResult = trial.benchmarkResult.treatment.taskResult;

  if (controlResult === undefined || !controlResult.passed) reasons.push("control_not_passed");
  if (treatmentResult === undefined || !treatmentResult.passed) reasons.push("treatment_not_passed");
  if (trial.comparison === undefined) reasons.push("no_valid_comparison");
  if (!trial.intervention.delivered) reasons.push("redirect_not_delivered");
  if (trial.comparison !== undefined && trial.comparison.taskId !== trial.taskId) reasons.push("task_id_mismatch");

  return { eligible: reasons.length === 0, reasons };
}

function buildTargetModelCompute(eligibleTrials: TrialRecord[]): TargetModelComputeSummary {
  const result = {} as TargetModelComputeSummary;
  for (const field of TARGET_MODEL_FIELDS) {
    const values: number[] = [];
    for (const trial of eligibleTrials) {
      const difference = trial.comparison?.grossDifference[field].difference;
      if (difference !== undefined) values.push(difference);
    }
    result[field] = summarizeMetric(values);
  }
  return result;
}

function buildElapsedTime(eligibleTrials: TrialRecord[]): ElapsedTimeSummary {
  const values = eligibleTrials.map((t) => t.benchmarkResult.control.elapsedMs - t.benchmarkResult.treatment.elapsedMs);
  return { pairedElapsedDifferenceMs: summarizeMetric(values) };
}

function buildDriftOverhead(eligibleTrials: TrialRecord[]): DriftOverheadSummary {
  const result = {} as DriftOverheadSummary;
  for (const field of DRIFT_OVERHEAD_FIELDS) {
    const values: number[] = [];
    for (const trial of eligibleTrials) {
      const value = trial.benchmarkResult.treatment.driftOverhead?.[field];
      if (value !== undefined) values.push(value);
    }
    result[field] = summarizeMetric(values);
  }
  return result;
}

/**
 * Produces the final, conservative benchmark interpretation over a
 * completed M14B trial set. Pure and deterministic: the same trials in any
 * order produce the same numbers, and `trials` is never mutated. Reuses
 * M14C's own aggregation for successPreservationRate/intervention counts,
 * and M13B's own grossDifference math for every compute figure -- nothing
 * here is a reimplementation of either.
 */
export function interpretBenchmarkResults(trials: TrialRecord[]): BenchmarkInterpretation {
  const m14c = evaluateBenchmarkTrials(trials);

  const eligibleTrials: TrialRecord[] = [];
  const exclusions: ExclusionRecord[] = [];

  for (const trial of trials) {
    const { eligible, reasons } = deriveEligibility(trial);
    if (eligible) {
      eligibleTrials.push(trial);
    } else {
      exclusions.push({ taskId: trial.taskId, repetitionIndex: trial.repetitionIndex, reasons });
    }
  }

  return {
    benchmarkEvidence: {
      totalTrials: m14c.overall.accounting.totalTrials,
      eligiblePairs: eligibleTrials.length,
      excludedPairs: exclusions.length,
      successPreservationRate: m14c.overall.successPreservation.rate,
    },
    interventionBehavior: {
      noRedirectCandidateTrials: m14c.overall.accounting.noRedirectCandidateTrials,
      deliveredRedirectTrials: m14c.overall.accounting.deliveredRedirectTrials,
    },
    targetModelCompute: buildTargetModelCompute(eligibleTrials),
    elapsedTime: buildElapsedTime(eligibleTrials),
    driftOverhead: buildDriftOverhead(eligibleTrials),
    sustainability: {
      benchmarkEstimatedAvoidedComputeAvailable: eligibleTrials.length > 0,
      netCostUsd: undefined,
      energyImpact: "not_measured",
      carbonImpact: "not_measured",
    },
    exclusions,
  };
}
