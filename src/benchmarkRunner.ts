/**
 * A reproducible benchmark runner: executes one coding task twice, once as a
 * control (Drift capture only, no analysis, no redirect) and once as a
 * treatment (Drift capture + real M9B/M10B analysis + the real M12A/M12B
 * human-approved redirect approval/injection lifecycle), from two
 * byte-equivalent starting workspaces, and produces measurements that feed
 * directly into M13B's comparePairedRun().
 *
 * This module never invents a benchmark-only redirect mechanism: the
 * treatment path calls the exact same generateRedirectPacket,
 * RedirectLifecycleManager, and runtime.ts injection machinery the product
 * uses -- the only thing standing in for a human here is the caller-supplied
 * `approveRedirect` callback, which plays the same role
 * runPrepareRedirectCommand's `showPacketAndConfirm` plays in extension.ts.
 *
 * Control never runs analyzeSession and never touches the redirect
 * lifecycle at all for its own session -- not merely "declines" a redirect,
 * but is structurally never offered one, since only the treatment session id
 * is ever passed to `lifecycle.prepare()`.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as child_process from "child_process";
import { DriftStorage } from "./storage";
import { normalizeRawEvent } from "./normalizedEvent";
import { buildTrajectory } from "./trajectory";
import { attributeUsageToTrajectory, TrajectoryUsage, UsageSummary } from "./trajectoryUsageAttribution";
import { LocalModelRuntime } from "./localModelRuntime";
import { analyzeSession, SessionAnalysis } from "./sessionAnalysisPipeline";
import { generateRedirectPacket, formatInjectedRedirectContext, RedirectPacket } from "./redirectPacket";
import { RedirectLifecycleManager } from "./redirectLifecycle";
import { startRuntime, DriftRuntime, RedirectInjectionHook } from "./runtime";
import { installClaudeHooks } from "./hookInstaller";
import { buildInterventionRecord, DriftOverhead, InterventionRecord, LocalInferenceUsage } from "./interventionMeasurement";
import { TaskResult, PairedComparisonInput } from "./pairedComparison";

export interface TaskEvaluatorResult {
  passed: boolean;
  checksPassed?: number;
  checksTotal?: number;
}

/** An explicit, objective benchmark evaluator -- inspects the finished workspace itself (tests, file contents, command exit status). Never asks Claude whether it succeeded. */
export interface TaskEvaluator {
  name: string;
  evaluate: (workspaceDir: string) => TaskEvaluatorResult | Promise<TaskEvaluatorResult>;
}

export interface BenchmarkTaskInput {
  taskId: string;
  workspaceTemplate: string;
  prompt: string;
  evaluator: TaskEvaluator;
}

/** Settings recorded verbatim in the result and applied identically to both control and treatment turns. */
export interface ClaudeRunSettings {
  model: string;
  allowedTools: string[];
  permissionMode: string;
  env: Record<string, string>;
}

export interface ClaudeTurnOptions {
  workspaceDir: string;
  sessionId: string;
  prompt: string;
  /** true for treatment's second turn, which continues the same session after a redirect was approved. */
  resume: boolean;
  settings: ClaudeRunSettings;
}

export interface ClaudeTurnResult {
  success: boolean;
  error: string | undefined;
}

/** The runner's only external-process boundary. The real default (createRealClaudeLauncher) spawns the actual `claude` CLI; tests inject a fake that exercises the real Drift runtime/storage/M12 lifecycle without spawning a process. */
export type ClaudeProcessLauncher = (options: ClaudeTurnOptions) => Promise<ClaudeTurnResult>;

/** Plays the same role extension.ts's runPrepareRedirectCommand gives a human reviewer -- the real RedirectPacket is generated first, this callback only decides approve/cancel. */
export type RedirectApprovalCallback = (packet: RedirectPacket) => boolean | Promise<boolean>;

export interface BenchmarkRunnerConfig {
  /** Reused across the whole benchmark pair -- both sessions' raw events, model-usage events, and hook traffic land in this one store, partitioned by session id exactly as in production. */
  storage: DriftStorage;
  /** The packaged local model, reused for the treatment run's real M9B/M10B analysis. */
  modelRuntime: LocalModelRuntime;
  bridgeScriptPath: string;
  settings: ClaudeRunSettings;
  launchClaudeTurn: ClaudeProcessLauncher;
  approveRedirect: RedirectApprovalCallback;
  /**
   * Which side runs first, wall-clock. Defaults to "control-first" (this
   * runner's original, unchanged behavior) when omitted -- M14B sets this
   * explicitly to alternate order across repeated trials and reduce
   * systematic ordering effects. The task prompt/config passed to each side
   * is identical either way; only the wall-clock sequence changes.
   */
  order?: "control-first" | "treatment-first";
}

export interface RunSideResult {
  sessionId: string;
  workspace: string;
  startedAt: number;
  completedAt: number;
  elapsedMs: number;
  /** undefined only when the Claude run itself failed before producing any usable session data. */
  usage: UsageSummary | undefined;
  /** undefined when the Claude run failed outright, or the evaluator itself threw (see evaluatorError). */
  taskResult: TaskResult | undefined;
  /** Set when the Claude CLI invocation failed -- recorded, never thrown. */
  claudeError: string | undefined;
  /** Set when the evaluator itself threw -- distinct from an evaluator that ran and reported passed: false. */
  evaluatorError: string | undefined;
}

export type RedirectOutcome = "not_attempted" | "no_candidate" | "rejected" | "delivered" | "delivery_failed";

export interface TreatmentRunSideResult extends RunSideResult {
  driftOverhead: DriftOverhead | undefined;
  intervention: InterventionRecord | undefined;
  /** An honest record of what actually happened on the redirect path for this run -- never silently defaulted to "delivered". */
  redirectOutcome: RedirectOutcome;
}

export interface BenchmarkPairResult {
  taskId: string;
  settings: ClaudeRunSettings;
  control: RunSideResult;
  treatment: TreatmentRunSideResult;
}

export interface ComparisonAdapterResult {
  success: boolean;
  input: PairedComparisonInput | undefined;
  reason: string | undefined;
}

/**
 * The real default ClaudeProcessLauncher: spawns the actual `claude` CLI
 * non-interactively, one process per turn. `resume` uses `--resume
 * <sessionId>` (matching real Claude Code's own resume flag) instead of
 * `--session-id` -- Claude Code does not accept both for the same
 * invocation. Never throws: a spawn error or non-zero exit both resolve to
 * `{success: false, error}`, so a Claude process failure can never crash
 * the runner.
 */
export function createRealClaudeLauncher(claudeBinary = "claude"): ClaudeProcessLauncher {
  return (options) =>
    new Promise<ClaudeTurnResult>((resolve) => {
      const args = ["-p", options.prompt, "--output-format", "json", "--model", options.settings.model, "--permission-mode", options.settings.permissionMode];
      if (options.settings.allowedTools.length > 0) {
        args.push("--allowedTools", options.settings.allowedTools.join(","));
      }
      if (options.resume) {
        args.push("--resume", options.sessionId);
      } else {
        args.push("--session-id", options.sessionId);
      }

      let child: child_process.ChildProcess;
      try {
        child = child_process.spawn(claudeBinary, args, { cwd: options.workspaceDir, env: { ...process.env, ...options.settings.env } });
      } catch (error) {
        resolve({ success: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }

      child.on("error", (error) => resolve({ success: false, error: error.message }));
      child.on("exit", (code) => {
        resolve(code === 0 ? { success: true, error: undefined } : { success: false, error: `claude exited with code ${code}` });
      });
    });
}

function buildTrajectoryUsage(sessionId: string, storage: DriftStorage): TrajectoryUsage {
  const sessionData = storage.getSession(sessionId);
  const normalized = (sessionData?.events ?? []).map(normalizeRawEvent);
  const trajectory = buildTrajectory(sessionId, normalized);
  return attributeUsageToTrajectory(trajectory, storage);
}

function createWorkspaceFromTemplate(templateDir: string, label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `drift-benchmark-${label}-`));
  fs.cpSync(templateDir, dir, { recursive: true });
  return dir;
}

async function runEvaluator(evaluator: TaskEvaluator, taskId: string, workspaceDir: string): Promise<{ taskResult: TaskResult | undefined; evaluatorError: string | undefined }> {
  try {
    const result = await evaluator.evaluate(workspaceDir);
    return {
      taskResult: { passed: result.passed, checksPassed: result.checksPassed, checksTotal: result.checksTotal, evaluator: evaluator.name, taskId },
      evaluatorError: undefined,
    };
  } catch (error) {
    return { taskResult: undefined, evaluatorError: error instanceof Error ? error.message : String(error) };
  }
}

async function runControl(input: BenchmarkTaskInput, config: BenchmarkRunnerConfig, workspace: string, sessionId: string): Promise<RunSideResult> {
  const startedAt = Date.now();
  const turn = await config.launchClaudeTurn({ workspaceDir: workspace, sessionId, prompt: input.prompt, resume: false, settings: config.settings });
  const completedAt = Date.now();
  const elapsedMs = completedAt - startedAt;

  if (!turn.success) {
    return { sessionId, workspace, startedAt, completedAt, elapsedMs, usage: undefined, taskResult: undefined, claudeError: turn.error, evaluatorError: undefined };
  }

  // No analyzeSession call, no redirect lifecycle involvement of any kind for
  // control -- its session id is never passed to RedirectLifecycleManager,
  // so it is structurally incapable of receiving a redirect, not merely one
  // that happened not to fire.
  const trajectoryUsage = buildTrajectoryUsage(sessionId, config.storage);
  const { taskResult, evaluatorError } = await runEvaluator(input.evaluator, input.taskId, workspace);

  return { sessionId, workspace, startedAt, completedAt, elapsedMs, usage: trajectoryUsage.sessionTotals, taskResult, claudeError: undefined, evaluatorError };
}

async function runTreatment(input: BenchmarkTaskInput, config: BenchmarkRunnerConfig, workspace: string, sessionId: string, lifecycle: TimestampedRedirectLifecycleManager): Promise<TreatmentRunSideResult> {
  const startedAt = Date.now();

  const firstTurn = await config.launchClaudeTurn({ workspaceDir: workspace, sessionId, prompt: input.prompt, resume: false, settings: config.settings });
  if (!firstTurn.success) {
    const completedAt = Date.now();
    return {
      sessionId,
      workspace,
      startedAt,
      completedAt,
      elapsedMs: completedAt - startedAt,
      usage: undefined,
      taskResult: undefined,
      claudeError: firstTurn.error,
      evaluatorError: undefined,
      driftOverhead: undefined,
      intervention: undefined,
      redirectOutcome: "not_attempted",
    };
  }

  let redirectOutcome: RedirectOutcome = "no_candidate";
  let approvedAt: number | undefined;
  let analysis: SessionAnalysis | undefined;
  let analysisDurationMs: number | undefined;
  let approvedPacket: RedirectPacket | undefined;

  const trajectoryAfterFirstTurn = buildTrajectoryUsage(sessionId, config.storage);
  const analysisStartedAt = Date.now();
  analysis = await analyzeSession(trajectoryAfterFirstTurn, config.storage, config.modelRuntime);
  analysisDurationMs = Date.now() - analysisStartedAt;
  lifecycle.setCurrentAnalysis(analysis);

  const candidateWindow = analysis.analyses.find((w) => w.decision.state === "redirect_candidate");

  if (candidateWindow) {
    const packetResult = generateRedirectPacket(sessionId, candidateWindow, trajectoryAfterFirstTurn);
    if (packetResult.success && packetResult.packet) {
      lifecycle.prepare(packetResult.packet, analysis);
      const approved = await Promise.resolve(config.approveRedirect(packetResult.packet));
      if (approved) {
        approvedAt = Date.now();
        lifecycle.approve(sessionId);
        approvedPacket = packetResult.packet;

        const secondTurn = await config.launchClaudeTurn({ workspaceDir: workspace, sessionId, prompt: "Continue with the task.", resume: true, settings: config.settings });
        if (secondTurn.success && lifecycle.getState(sessionId) === "consumed") {
          redirectOutcome = "delivered";
        } else {
          redirectOutcome = "delivery_failed";
        }
      } else {
        lifecycle.cancel(sessionId);
        redirectOutcome = "rejected";
      }
    } else {
      redirectOutcome = "delivery_failed";
    }
  }

  const completedAt = Date.now();
  const finalTrajectoryUsage = buildTrajectoryUsage(sessionId, config.storage);
  const { taskResult, evaluatorError } = await runEvaluator(input.evaluator, input.taskId, workspace);

  let driftOverhead: DriftOverhead | undefined;
  let intervention: InterventionRecord | undefined;

  if (redirectOutcome === "delivered" && approvedPacket && approvedAt !== undefined && analysis) {
    const deliveredAt = lifecycle.getDeliveredAt(sessionId);
    if (deliveredAt !== undefined) {
      const usageEventTimestamps = new Map(config.storage.getModelUsageEvents(sessionId).map((e) => [e.id, e.timestamp]));
      // analyzeSession makes exactly one classifyWindow call per window (see
      // sessionAnalysisPipeline.ts) -- this is the real count of local
      // inference calls made. Per-call duration/token breakdowns are not
      // exposed by classifyWindow today (the same gap M13A's own design
      // notes identified), so each entry's fields stay undefined rather than
      // fabricated -- localInferenceCount is still real, never zeroed out.
      const localInferenceCalls: LocalInferenceUsage[] = analysis.analyses.map(() => ({ durationMs: undefined, inputTokens: undefined, outputTokens: undefined }));

      const measurement = buildInterventionRecord({
        sessionId,
        packet: approvedPacket,
        approvedAt,
        deliveredAt,
        trajectoryUsage: finalTrajectoryUsage,
        usageEventTimestamps,
        localInferenceCalls,
        analysisDurationMs,
      });

      if (measurement.success && measurement.record) {
        intervention = measurement.record;
        driftOverhead = measurement.record.driftOverhead;
      } else {
        redirectOutcome = "delivery_failed";
      }
    } else {
      redirectOutcome = "delivery_failed";
    }
  }

  return {
    sessionId,
    workspace,
    startedAt,
    completedAt,
    elapsedMs: completedAt - startedAt,
    usage: finalTrajectoryUsage.sessionTotals,
    taskResult,
    claudeError: undefined,
    evaluatorError,
    driftOverhead,
    intervention,
    redirectOutcome,
  };
}

/**
 * Runs one matched control/treatment pair for `input`. Pure orchestration
 * over already-existing modules: it never reimplements M7C usage
 * attribution, M9B/M10B analysis, M12A packet generation, M12B injection, or
 * M13A measurement -- it only wires them together and records real,
 * observed outcomes. Creates and tears down its own DriftRuntime and
 * RedirectLifecycleManager per call so no state (redirect lifecycle
 * included) can leak between benchmark runs; `config.storage` and
 * `config.modelRuntime` are the caller's reusable resources and are never
 * closed here.
 */
export async function runMatchedBenchmark(input: BenchmarkTaskInput, config: BenchmarkRunnerConfig): Promise<BenchmarkPairResult> {
  const controlWorkspace = createWorkspaceFromTemplate(input.workspaceTemplate, "control");
  const treatmentWorkspace = createWorkspaceFromTemplate(input.workspaceTemplate, "treatment");
  const controlSessionId = crypto.randomUUID();
  const treatmentSessionId = crypto.randomUUID();

  const lifecycle = new TimestampedRedirectLifecycleManager();

  const redirectInjectionHook: RedirectInjectionHook = {
    getInjectableContext: (sid) => {
      const packet = lifecycle.getInjectablePacket(sid, lifecycle.currentAnalysis);
      return packet ? formatInjectedRedirectContext(packet) : undefined;
    },
    markConsumed: (sid) => lifecycle.markConsumed(sid),
  };

  const runtime: DriftRuntime = await startRuntime(config.storage, undefined, redirectInjectionHook);

  try {
    installClaudeHooks(path.join(controlWorkspace, ".claude", "settings.local.json"), runtime.port, config.bridgeScriptPath);
    installClaudeHooks(path.join(treatmentWorkspace, ".claude", "settings.local.json"), runtime.port, config.bridgeScriptPath);

    let control: RunSideResult;
    let treatment: TreatmentRunSideResult;
    if (config.order === "treatment-first") {
      treatment = await runTreatment(input, config, treatmentWorkspace, treatmentSessionId, lifecycle);
      control = await runControl(input, config, controlWorkspace, controlSessionId);
    } else {
      control = await runControl(input, config, controlWorkspace, controlSessionId);
      treatment = await runTreatment(input, config, treatmentWorkspace, treatmentSessionId, lifecycle);
    }

    return { taskId: input.taskId, settings: config.settings, control, treatment };
  } finally {
    await runtime.stop();
  }
}

/**
 * Reshapes a completed BenchmarkPairResult into exactly the input
 * comparePairedRun() (M13B) expects, without the caller having to
 * reconstruct identity fields by hand. Never alters M13B's own comparison
 * semantics -- this is pure reshaping. Fails closed (no input produced) when
 * either side never completed, or treatment produced no redirect to
 * compare -- a benchmark run without a delivered redirect is still a valid,
 * honestly-recorded run, just not yet a valid M13B comparison pair.
 */
export function toComparisonInput(result: BenchmarkPairResult): ComparisonAdapterResult {
  if (result.control.usage === undefined || result.control.taskResult === undefined) {
    return { success: false, input: undefined, reason: "control run did not complete (see control.claudeError/evaluatorError)" };
  }
  if (result.treatment.usage === undefined || result.treatment.taskResult === undefined) {
    return { success: false, input: undefined, reason: "treatment run did not complete (see treatment.claudeError/evaluatorError)" };
  }
  if (result.treatment.intervention === undefined || result.treatment.driftOverhead === undefined) {
    return { success: false, input: undefined, reason: `treatment produced no redirect to compare (redirectOutcome: ${result.treatment.redirectOutcome})` };
  }

  const comparisonInput: PairedComparisonInput = {
    taskId: result.taskId,
    control: { sessionId: result.control.sessionId, usage: result.control.usage, taskResult: result.control.taskResult },
    treatment: {
      sessionId: result.treatment.sessionId,
      usage: result.treatment.usage,
      driftOverhead: result.treatment.driftOverhead,
      intervention: result.treatment.intervention,
      taskResult: result.treatment.taskResult,
    },
  };
  return { success: true, input: comparisonInput, reason: undefined };
}

/**
 * A thin timestamp-tracking wrapper around M12B's own RedirectLifecycleManager.
 * The manager itself deliberately carries no clock (see redirectLifecycle.ts)
 * -- this benchmark runner is the first caller that needs approvedAt/deliveredAt
 * to build an M13A InterventionRecord, so it captures them here rather than
 * changing the manager's own contract. Every state transition still goes
 * through the real manager underneath; this only observes it.
 */
class TimestampedRedirectLifecycleManager extends RedirectLifecycleManager {
  currentAnalysis: SessionAnalysis | undefined;
  private deliveredAtBySessionId = new Map<string, number>();

  setCurrentAnalysis(analysis: SessionAnalysis): void {
    this.currentAnalysis = analysis;
  }

  override markConsumed(sessionId: string): void {
    this.deliveredAtBySessionId.set(sessionId, Date.now());
    super.markConsumed(sessionId);
  }

  getDeliveredAt(sessionId: string): number | undefined {
    return this.deliveredAtBySessionId.get(sessionId);
  }
}
