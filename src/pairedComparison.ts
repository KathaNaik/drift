/**
 * A pure comparison layer for one matched benchmark task: one completed
 * "control" run (normal Claude behavior) and one completed "treatment" run
 * (Drift intervention enabled). This module does not launch Claude, does
 * not run a benchmark, and does not score task success itself -- both
 * `taskResult`s must already come from an explicit benchmark evaluator
 * (never from M11C's `buildOutcome`, which is a trajectory-shaped guess
 * about the last tool call, not an objective pass/fail verdict).
 *
 * One pair proves nothing on its own: this module never claims avoided
 * waste, general token savings, a sustainability improvement, or an energy
 * reduction. It only reports what the two runs measured, and whether task
 * success was preserved between them.
 */

import { UsageSummary } from "./trajectoryUsageAttribution";
import { DriftOverhead, InterventionRecord } from "./interventionMeasurement";

/** An explicit benchmark evaluator's verdict for one run -- never inferred from trajectory/hook data. */
export interface TaskResult {
  passed: boolean;
  checksPassed?: number;
  checksTotal?: number;
  evaluator: string;
  /** Optional: the evaluator's own record of which task this scored, cross-checked against the requested taskId when present. */
  taskId?: string;
}

export interface ControlRun {
  sessionId: string;
  usage: UsageSummary;
  taskResult: TaskResult;
}

export interface TreatmentRun {
  sessionId: string;
  usage: UsageSummary;
  driftOverhead: DriftOverhead;
  /** The M13A record for the redirect delivered during this run -- must belong to this same session. */
  intervention: InterventionRecord;
  taskResult: TaskResult;
}

export interface PairedComparisonInput {
  taskId: string;
  control: ControlRun;
  treatment: TreatmentRun;
}

/**
 * One measured field's control/treatment comparison.
 * Direction is fixed and explicit: difference = control - treatment, so a
 * positive difference means treatment used LESS than control, and a
 * negative difference means treatment used MORE. Undefined whenever either
 * side's own value is undefined -- never coerced to 0.
 */
export interface UsageFieldDifference {
  control: number | undefined;
  treatment: number | undefined;
  difference: number | undefined;
  /** difference / control -- only when control is a defined, non-zero number. Never fabricated from a zero or missing denominator. */
  percentageDifference: number | undefined;
}

export interface UsageDifference {
  modelCalls: UsageFieldDifference;
  inputTokens: UsageFieldDifference;
  outputTokens: UsageFieldDifference;
  cacheReadTokens: UsageFieldDifference;
  cacheWriteTokens: UsageFieldDifference;
  costUsd: UsageFieldDifference;
  /**
   * control.usage.durationMs - treatment.usage.durationMs -- both sides
   * come from the same Claude usage-telemetry definition (target-model/API
   * request duration), so this difference is valid on its own terms. It is
   * NOT end-to-end wall-clock savings: it says nothing about how long the
   * user actually waited, since it excludes everything outside Claude's own
   * request duration (thinking time between requests, tool execution,
   * Drift's own analysis -- see NetDifference.durationMs, which is where
   * that broader, genuinely comparable measurement would belong once it
   * exists).
   */
  durationMs: UsageFieldDifference;
}

/**
 * Fields here are only ever populated when control and treatment (plus,
 * for durationMs, any Drift-side addend) share one explicitly-defined
 * elapsed-time or monetary measurement -- equal units (both "ms") are not
 * sufficient on their own, since two ms measurements can describe different
 * things. A token count is never a candidate for this interface at all: a
 * Claude token and a local-model token are not the same unit and are never
 * combined or treated as equivalent anywhere here.
 */
export interface NetDifference {
  /**
   * Always undefined for now (M13B.1). Claude's usage.durationMs is
   * model/API request telemetry; Drift's driftOverhead.analysisDurationMs
   * measures Drift's own analysis execution -- both happen to be
   * milliseconds, but that does not make them the same explicitly-defined
   * elapsed-time measurement, so treatment.usage.durationMs +
   * driftOverhead.analysisDurationMs is never computed or summed anywhere
   * in this module. A real net wall-clock comparison needs a benchmark
   * runner that captures comparable end-to-end elapsed timing for both the
   * control and treatment runs under one shared timing definition -- out of
   * scope here (see interventionMeasurement.ts's DriftOverhead.analysisDurationMs
   * for whether it already includes local inference time, which matters for
   * that future work but not for this field, which stays undefined either way).
   */
  durationMs: number | undefined;
  /** Always undefined in this milestone: Drift's local inference has no measured monetary cost field (it runs the packaged local model, not a billed API), so there is nothing genuinely comparable to add to Claude's own costUsd -- this deliberately never defaults to treating Drift as free. */
  costUsd: number | undefined;
}

export interface PairedComparisonResult {
  taskId: string;
  controlTaskResult: TaskResult;
  treatmentTaskResult: TaskResult;
  /**
   * true only when control passed AND treatment passed.
   * false when control passed but treatment failed -- a real, comparable
   * regression (the raw usage difference is still reported below; it is
   * never described as an improvement here since no such field exists).
   * undefined when control itself failed -- the pair has no successful
   * baseline, so it is unsuitable for judging whether success was
   * preserved at all.
   */
  taskSuccessPreserved: boolean | undefined;
  controlUsage: UsageSummary;
  treatmentUsage: UsageSummary;
  driftOverhead: DriftOverhead;
  grossDifference: UsageDifference;
  netDifference: NetDifference;
}

export interface PairedComparisonOutcome {
  success: boolean;
  comparison: PairedComparisonResult | undefined;
  error: string | undefined;
}

function validateTaskResult(taskResult: TaskResult, label: string): string | undefined {
  if (typeof taskResult.passed !== "boolean") {
    return `${label}.taskResult.passed must be a boolean`;
  }
  if (typeof taskResult.evaluator !== "string" || taskResult.evaluator.length === 0) {
    return `${label}.taskResult.evaluator must be a non-empty string`;
  }
  if (taskResult.checksPassed !== undefined && (typeof taskResult.checksPassed !== "number" || taskResult.checksPassed < 0)) {
    return `${label}.taskResult.checksPassed must be a non-negative number when present`;
  }
  if (taskResult.checksTotal !== undefined && (typeof taskResult.checksTotal !== "number" || taskResult.checksTotal < 0)) {
    return `${label}.taskResult.checksTotal must be a non-negative number when present`;
  }
  if (taskResult.checksPassed !== undefined && taskResult.checksTotal !== undefined && taskResult.checksPassed > taskResult.checksTotal) {
    return `${label}.taskResult reports checksPassed (${taskResult.checksPassed}) greater than checksTotal (${taskResult.checksTotal})`;
  }
  return undefined;
}

function fieldDifference(control: number | undefined, treatment: number | undefined): UsageFieldDifference {
  const difference = control !== undefined && treatment !== undefined ? control - treatment : undefined;
  const percentageDifference = difference !== undefined && control !== undefined && control !== 0 ? difference / control : undefined;
  return { control, treatment, difference, percentageDifference };
}

function buildUsageDifference(control: UsageSummary, treatment: UsageSummary): UsageDifference {
  return {
    modelCalls: fieldDifference(control.modelCalls, treatment.modelCalls),
    inputTokens: fieldDifference(control.inputTokens, treatment.inputTokens),
    outputTokens: fieldDifference(control.outputTokens, treatment.outputTokens),
    cacheReadTokens: fieldDifference(control.cacheReadTokens, treatment.cacheReadTokens),
    cacheWriteTokens: fieldDifference(control.cacheWriteTokens, treatment.cacheWriteTokens),
    costUsd: fieldDifference(control.costUsd, treatment.costUsd),
    durationMs: fieldDifference(control.durationMs, treatment.durationMs),
  };
}

/**
 * M13B.1: durationMs is unconditionally undefined here -- see
 * NetDifference.durationMs for why Claude's usage.durationMs and Drift's
 * analysisDurationMs, despite both being milliseconds, are not the same
 * explicitly-defined elapsed-time measurement and are never summed.
 * `control`/`treatment`/`driftOverhead` are still accepted (rather than
 * dropped from this function's signature) so a future milestone that adds
 * a genuinely comparable end-to-end timing definition has an obvious,
 * already-wired place to compute it.
 */
function buildNetDifference(_control: UsageSummary, _treatment: UsageSummary, _driftOverhead: DriftOverhead): NetDifference {
  return { durationMs: undefined, costUsd: undefined };
}

function invalid(error: string): PairedComparisonOutcome {
  return { success: false, comparison: undefined, error };
}

/**
 * Compares one control run against one treatment run for the same task.
 * Pure and deterministic: the same input always produces the same result,
 * and nothing is mutated.
 *
 * Rejects (never fabricates a comparison) when:
 * - control and treatment are the same session,
 * - either run's taskResult carries its own taskId that doesn't match the
 *   requested taskId,
 * - the treatment's intervention record belongs to a different session
 *   than the treatment run itself, or
 * - either taskResult is malformed (wrong types, or checksPassed exceeding
 *   checksTotal).
 */
export function comparePairedRun(input: PairedComparisonInput): PairedComparisonOutcome {
  const { taskId, control, treatment } = input;

  if (control.sessionId === treatment.sessionId) {
    return invalid(`control and treatment must be different sessions, both were "${control.sessionId}"`);
  }
  if (control.taskResult.taskId !== undefined && control.taskResult.taskId !== taskId) {
    return invalid(`control.taskResult.taskId "${control.taskResult.taskId}" does not match requested taskId "${taskId}"`);
  }
  if (treatment.taskResult.taskId !== undefined && treatment.taskResult.taskId !== taskId) {
    return invalid(`treatment.taskResult.taskId "${treatment.taskResult.taskId}" does not match requested taskId "${taskId}"`);
  }
  if (treatment.intervention.sessionId !== treatment.sessionId) {
    return invalid(`treatment.intervention belongs to session "${treatment.intervention.sessionId}", not the treatment session "${treatment.sessionId}"`);
  }

  const controlError = validateTaskResult(control.taskResult, "control");
  if (controlError) return invalid(controlError);
  const treatmentError = validateTaskResult(treatment.taskResult, "treatment");
  if (treatmentError) return invalid(treatmentError);

  const taskSuccessPreserved: boolean | undefined = control.taskResult.passed ? treatment.taskResult.passed : undefined;

  const comparison: PairedComparisonResult = {
    taskId,
    controlTaskResult: control.taskResult,
    treatmentTaskResult: treatment.taskResult,
    taskSuccessPreserved,
    controlUsage: control.usage,
    treatmentUsage: treatment.usage,
    driftOverhead: treatment.driftOverhead,
    grossDifference: buildUsageDifference(control.usage, treatment.usage),
    netDifference: buildNetDifference(control.usage, treatment.usage, treatment.driftOverhead),
  };

  return { success: true, comparison, error: undefined };
}
