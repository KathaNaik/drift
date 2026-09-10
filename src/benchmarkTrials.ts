/**
 * Runs a validated M14A benchmark task as N independent, matched
 * control/treatment pairs, using the real M13C runner for every pair. This
 * module owns none of the actual execution: workspace setup, Claude
 * spawning, evaluator logic, the M12 redirect lifecycle, and M7C usage
 * collection all stay exactly where M13C already put them
 * (runMatchedBenchmark). All this module adds is the repetition loop, order
 * alternation, honest per-trial bookkeeping, and feeding each completed
 * pair through M13B's own comparePairedRun() -- never a reimplementation of
 * that comparison math.
 *
 * No trial is ever silently dropped, and no aggregate statistic is computed
 * here: the goal is repeated raw measurements, not a verdict.
 */

import { BenchmarkTaskDefinition, computeWorkspaceFingerprint, runTaskEvaluator } from "./benchmarkTaskSpec";
import {
  BenchmarkTaskInput,
  BenchmarkRunnerConfig,
  BenchmarkPairResult,
  TaskEvaluator,
  ClaudeProcessLauncher,
  RedirectApprovalCallback,
  runMatchedBenchmark,
  toComparisonInput,
} from "./benchmarkRunner";
import { DriftStorage } from "./storage";
import { LocalModelRuntime } from "./localModelRuntime";
import { comparePairedRun, PairedComparisonResult } from "./pairedComparison";

export type TrialOrder = "control-first" | "treatment-first";

export type TrialCondition =
  | "completed"
  | "control_process_failure"
  | "treatment_process_failure"
  | "evaluator_failure"
  | "no_redirect_candidate"
  | "redirect_approved_not_delivered";

/** Independent, objective flags for each stage of the M12 redirect lifecycle the treatment run actually reached -- a run with every flag false is still a valid trial, never an error on its own. */
export interface InterventionOccurrence {
  redirectCandidateOccurred: boolean;
  packetApproved: boolean;
  delivered: boolean;
  consumed: boolean;
}

export interface TrialRecord {
  taskId: string;
  repetitionIndex: number;
  order: TrialOrder;
  controlSessionId: string;
  treatmentSessionId: string;
  /** Identical across every repetition of this task -- the canonical M14A template's own content fingerprint, computed once per task, never per repetition. */
  workspaceFingerprint: string;
  condition: TrialCondition;
  intervention: InterventionOccurrence;
  /** Present only when both sides completed and treatment produced a redirect to compare (see benchmarkRunner.ts's toComparisonInput) -- absent otherwise, never fabricated. */
  comparison: PairedComparisonResult | undefined;
  /** Explains why `comparison` is absent, when it is. */
  comparisonUnavailableReason: string | undefined;
  /** The complete, raw M13C result for this pair -- full auditability, never summarized away. */
  benchmarkResult: BenchmarkPairResult;
}

export interface TrialRunnerConfig {
  storage: DriftStorage;
  modelRuntime: LocalModelRuntime;
  bridgeScriptPath: string;
  launchClaudeTurn: ClaudeProcessLauncher;
  approveRedirect: RedirectApprovalCallback;
  /** A safety ceiling on repetitions actually run, independent of what was requested -- see requirement 10. Never exceeded, regardless of how many repetitions were requested. */
  maxRepetitions?: number;
}

export interface BenchmarkTrialsInput {
  tasks: BenchmarkTaskDefinition[];
  repetitions: number;
  runnerConfig: TrialRunnerConfig;
}

export interface InfrastructureFailure {
  taskId: string;
  repetitionIndex: number;
  error: string;
}

export interface BenchmarkTrialsOutput {
  requestedRepetitions: number;
  /** requestedRepetitions, clamped to runnerConfig.maxRepetitions when that's lower -- never silently exceeded, never silently reduced without being reported here. */
  effectiveRepetitions: number;
  /** Every individual trial actually run, in the exact deterministic order they were executed. Never averaged, scored, or otherwise collapsed. */
  trials: TrialRecord[];
  /**
   * Set only when runMatchedBenchmark itself threw (an infrastructure-level
   * failure -- e.g. the runtime failed to start, hook installation failed,
   * the workspace template doesn't exist) rather than returning its normal
   * result shape. On this, the whole run stops immediately: no further
   * repetitions or tasks are attempted, since continuing would just spend
   * more real Claude calls against a broken environment. A single failed
   * Claude CLI invocation within an otherwise-normal trial is NOT this --
   * that is recorded as a completed trial with condition
   * "control_process_failure"/"treatment_process_failure" and the run
   * continues.
   */
  stoppedDueToInfrastructureFailure: InfrastructureFailure | undefined;
}

function orderForRepetition(repetitionIndex: number): TrialOrder {
  return repetitionIndex % 2 === 0 ? "control-first" : "treatment-first";
}

/** Adapts M14A's command-based evaluator spec into the function-shaped TaskEvaluator M13C's runner expects -- delegates entirely to runTaskEvaluator (M14A), never reimplementing evaluator logic here. */
function adaptEvaluator(task: BenchmarkTaskDefinition): TaskEvaluator {
  return {
    name: task.evaluator.command,
    evaluate: (workspaceDir: string) => {
      const result = runTaskEvaluator(task, workspaceDir);
      return { passed: result.passed, checksPassed: result.checksPassed, checksTotal: result.checksTotal };
    },
  };
}

function deriveIntervention(result: BenchmarkPairResult): InterventionOccurrence {
  const outcome = result.treatment.redirectOutcome;
  const redirectCandidateOccurred = outcome !== "not_attempted" && outcome !== "no_candidate";
  const packetApproved = outcome === "delivered" || outcome === "delivery_failed";
  // M13C's own runTreatment sets "delivered" only once the redirect
  // lifecycle has actually reached "consumed" (see benchmarkRunner.ts) --
  // there is no distinct intermediate state to observe, so both flags are
  // true/false together under the current M13C implementation.
  const delivered = outcome === "delivered";
  const consumed = delivered;
  return { redirectCandidateOccurred, packetApproved, delivered, consumed };
}

function deriveCondition(result: BenchmarkPairResult): TrialCondition {
  if (result.control.claudeError !== undefined) return "control_process_failure";
  if (result.treatment.claudeError !== undefined) return "treatment_process_failure";
  if (result.control.evaluatorError !== undefined || result.treatment.evaluatorError !== undefined) return "evaluator_failure";
  if (result.treatment.redirectOutcome === "delivery_failed") return "redirect_approved_not_delivered";
  if (result.treatment.redirectOutcome === "no_candidate") return "no_redirect_candidate";
  return "completed";
}

function buildComparison(result: BenchmarkPairResult): { comparison: PairedComparisonResult | undefined; reason: string | undefined } {
  const adapted = toComparisonInput(result);
  if (!adapted.success || !adapted.input) {
    return { comparison: undefined, reason: adapted.reason };
  }
  const compared = comparePairedRun(adapted.input);
  if (!compared.success || !compared.comparison) {
    return { comparison: undefined, reason: compared.error };
  }
  return { comparison: compared.comparison, reason: undefined };
}

/**
 * Runs `input.repetitions` matched control/treatment pairs (clamped to
 * `runnerConfig.maxRepetitions` when set) for each of `input.tasks`, in
 * task order, then repetition order -- a single deterministic sequence.
 * Every task starts every repetition from its own canonical
 * workspaceTemplate (M13C's own runMatchedBenchmark creates fresh
 * control/treatment copies and a fresh session/lifecycle per call, so no
 * state from one repetition can reach the next); this function adds
 * nothing that could leak between them.
 */
export async function runBenchmarkTrials(input: BenchmarkTrialsInput): Promise<BenchmarkTrialsOutput> {
  const requestedRepetitions = input.repetitions;
  const effectiveRepetitions = input.runnerConfig.maxRepetitions !== undefined ? Math.min(requestedRepetitions, input.runnerConfig.maxRepetitions) : requestedRepetitions;

  const trials: TrialRecord[] = [];
  let stoppedDueToInfrastructureFailure: InfrastructureFailure | undefined;

  for (const task of input.tasks) {
    let workspaceFingerprint: string;
    try {
      // Computed once per task, reused verbatim by every repetition below --
      // this is what guarantees "every pair starts from the same canonical
      // workspace fingerprint" (requirement 1/3), not a per-repetition
      // recomputation. A failure here (e.g. a workspaceTemplate that
      // doesn't exist) is exactly as much an infrastructure failure as
      // runMatchedBenchmark itself throwing -- neither ever leaves this
      // function as an uncaught exception.
      workspaceFingerprint = computeWorkspaceFingerprint(task.workspaceTemplate, task.volatileFiles);
    } catch (error) {
      stoppedDueToInfrastructureFailure = { taskId: task.id, repetitionIndex: 0, error: error instanceof Error ? error.message : String(error) };
      return { requestedRepetitions, effectiveRepetitions, trials, stoppedDueToInfrastructureFailure };
    }

    for (let repetitionIndex = 0; repetitionIndex < effectiveRepetitions; repetitionIndex++) {
      const order = orderForRepetition(repetitionIndex);

      const taskInput: BenchmarkTaskInput = {
        taskId: task.id,
        workspaceTemplate: task.workspaceTemplate,
        prompt: task.prompt,
        evaluator: adaptEvaluator(task),
      };

      const runnerConfig: BenchmarkRunnerConfig = {
        storage: input.runnerConfig.storage,
        modelRuntime: input.runnerConfig.modelRuntime,
        bridgeScriptPath: input.runnerConfig.bridgeScriptPath,
        settings: { model: task.claude.model, allowedTools: task.claude.allowedTools, permissionMode: task.claude.permissionMode, env: {} },
        launchClaudeTurn: input.runnerConfig.launchClaudeTurn,
        approveRedirect: input.runnerConfig.approveRedirect,
        order,
      };

      let benchmarkResult: BenchmarkPairResult;
      try {
        benchmarkResult = await runMatchedBenchmark(taskInput, runnerConfig);
      } catch (error) {
        stoppedDueToInfrastructureFailure = { taskId: task.id, repetitionIndex, error: error instanceof Error ? error.message : String(error) };
        return { requestedRepetitions, effectiveRepetitions, trials, stoppedDueToInfrastructureFailure };
      }

      const { comparison, reason } = buildComparison(benchmarkResult);

      trials.push({
        taskId: task.id,
        repetitionIndex,
        order,
        controlSessionId: benchmarkResult.control.sessionId,
        treatmentSessionId: benchmarkResult.treatment.sessionId,
        workspaceFingerprint,
        condition: deriveCondition(benchmarkResult),
        intervention: deriveIntervention(benchmarkResult),
        comparison,
        comparisonUnavailableReason: reason,
        benchmarkResult,
      });
    }
  }

  return { requestedRepetitions, effectiveRepetitions, trials, stoppedDueToInfrastructureFailure: undefined };
}
