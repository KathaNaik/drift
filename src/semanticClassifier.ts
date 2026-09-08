/**
 * A constrained semantic classifier for one trajectory "window" (a focus
 * step or small set of them, e.g. everything an M8A/M8B finding points
 * at), built entirely on the local model runtime (localModelRuntime.ts).
 * There is no cloud fallback: the only model this module ever calls is
 * whatever LocalModelRuntime the caller passes in.
 *
 * M9B.1 fix: an earlier version of this module pre-decided the class (and
 * every other output field) deterministically from M8A/M8B findings, and
 * only used the model to format that already-decided answer into JSON --
 * verified directly, the model would echo literally any stated category,
 * including a fabricated one contradicting the window it was shown. That
 * version moved to raw findings-as-evidence plus isolated fact-check
 * calls (e.g. "did a Write happen between these attempts?"), each handed
 * to the final call as a plain declarative sentence.
 *
 * M9B.2 fix: those fact sentences, though genuinely model-derived, were
 * themselves too conclusion-shaped -- verified directly, "a relevant file
 * WAS changed" got treated as decisive for productive_retry even when the
 * very same window showed the retry itself still failing, and "NOTHING
 * was changed" got treated as decisive for stalled_retry even when the
 * retry had actually succeeded. The retry's own outcome, sitting right in
 * the window, was being ignored in favor of the one strongly-worded
 * sentence. This version removes fact sentences entirely. Evidence is now
 * a single flat, neutral JSON object -- attempts (each with its own
 * outcome), stateChangesBetweenAttempts, newEvidenceBetweenAttempts,
 * newHypothesisSignals, and deterministicFindings -- presented as peers in
 * one call, with no field phrased as a recommendation or given more
 * weight than another in how it's worded.
 *
 * Because a small local model volunteering the fully correct class from
 * peer evidence still isn't perfectly reliable, this version also adds a
 * second, independent line of defense: strict semantic consistency
 * validation. productive_retry, stalled_retry, and duplicate_subagent_work
 * each carry an objective invariant computed from the SAME attempts data
 * the model saw (never asked of the model, so it's already 100% known) --
 * a retry outcome, or a distinct-agent count. A classification that
 * violates its own class's invariant is rejected outright as a safe
 * failure, never silently coerced into some other class, so a later
 * policy layer can never consume a self-contradictory result.
 *
 * M9B.3 fix: the consistency validator only covered `class` -- verified
 * directly, the model could (and did) return newEvidence:false even when
 * newEvidenceBetweenAttempts, built by plain string comparison and
 * already shown to the model as evidence, plainly contained a changed
 * failure. The same "reject, never rewrite" veto now also covers
 * newEvidence (and, symmetrically, newHypothesis): when the objective
 * evidence array is non-empty, the corresponding output field cannot
 * legitimately be false. The reverse is never enforced -- an empty array
 * only means nothing objective was detected, not that nothing relevant
 * happened, so the model stays free to say true from its own reading of
 * the window. semanticRedundancy and progress remain entirely
 * unconstrained, as does newEvidence/newHypothesis whenever their
 * corresponding evidence array is empty.
 *
 * TypeScript's role throughout is: build neutral evidence (compact,
 * truncated, deterministic), send one real inference call, strictly
 * validate the JSON shape, then strictly validate internal consistency.
 * It never decides or fills in the semantic answer itself.
 */

import { DriftRawEvent, DriftStorage } from "./storage";
import { LocalModelRuntime } from "./localModelRuntime";
import { TrajectoryStepWithUsage, TrajectoryUsage, UsageSummary, AttributedUsageRecord, summarize } from "./trajectoryUsageAttribution";
import { TrajectoryFeatureFinding } from "./trajectoryFeatures";
import { SubagentOverlapFinding } from "./subagentOverlap";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export type Progress = "none" | "low" | "meaningful";
export type SemanticRedundancy = "low" | "medium" | "high";
export type ClassificationClass =
  | "productive_retry"
  | "stalled_retry"
  | "new_exploration"
  | "redundant_exploration"
  | "duplicate_subagent_work";

/** The exact required output shape. Every field is strictly validated before this type is ever produced. */
export interface SemanticClassification {
  progress: Progress;
  newEvidence: boolean;
  newHypothesis: boolean;
  semanticRedundancy: SemanticRedundancy;
  class: ClassificationClass;
}

export interface ClassificationResult {
  /** Present only when classification succeeded and passed both schema and semantic-consistency validation. */
  classification: SemanticClassification | undefined;
  /** The model's raw response text from the classification call, kept for auditability regardless of success. */
  raw: string | undefined;
  success: boolean;
  error: string | undefined;
}

/** Everything needed to classify one window. Never mutated by this module. */
export interface ClassificationRequest {
  trajectoryUsage: TrajectoryUsage;
  features: TrajectoryFeatureFinding[];
  overlaps: SubagentOverlapFinding[];
  /** The step indexes this classification concerns -- typically one finding's stepIndexes, or a single step of interest. */
  focusStepIndexes: number[];
}

const DEFAULT_MAX_OUTPUT_TOKENS = 300;
const RESULT_SNIPPET_MAX_CHARS = 80;

const VALID_PROGRESS = new Set<string>(["none", "low", "meaningful"]);
const VALID_REDUNDANCY = new Set<string>(["low", "medium", "high"]);
const VALID_CLASSES = new Set<string>([
  "productive_retry",
  "stalled_retry",
  "new_exploration",
  "redundant_exploration",
  "duplicate_subagent_work",
]);

const CLASSIFICATION_JSON_SCHEMA = {
  name: "trajectory_classification",
  schema: {
    type: "object",
    properties: {
      progress: { type: "string", enum: ["none", "low", "meaningful"] },
      newEvidence: { type: "boolean" },
      newHypothesis: { type: "boolean" },
      semanticRedundancy: { type: "string", enum: ["low", "medium", "high"] },
      class: {
        type: "string",
        enum: ["productive_retry", "stalled_retry", "new_exploration", "redundant_exploration", "duplicate_subagent_work"],
      },
    },
    required: ["progress", "newEvidence", "newHypothesis", "semanticRedundancy", "class"],
    additionalProperties: false,
  },
};

/** Strictly validates an arbitrary value against the required output shape. Never coerces or guesses a field's value -- anything not exactly right fails the whole result. */
function validateClassification(value: unknown): SemanticClassification | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.progress !== "string" || !VALID_PROGRESS.has(value.progress)) return undefined;
  if (typeof value.newEvidence !== "boolean") return undefined;
  if (typeof value.newHypothesis !== "boolean") return undefined;
  if (typeof value.semanticRedundancy !== "string" || !VALID_REDUNDANCY.has(value.semanticRedundancy)) return undefined;
  if (typeof value.class !== "string" || !VALID_CLASSES.has(value.class)) return undefined;

  return {
    progress: value.progress as Progress,
    newEvidence: value.newEvidence,
    newHypothesis: value.newHypothesis,
    semanticRedundancy: value.semanticRedundancy as SemanticRedundancy,
    class: value.class as ClassificationClass,
  };
}

function rawAgentId(rawEvent: DriftRawEvent | undefined): string | undefined {
  return isPlainObject(rawEvent?.payload) ? str(rawEvent.payload.agent_id) : undefined;
}

/** Safely truncates a tool response of unknown shape (string, object, etc.) to a short snippet -- enough to compare across occurrences, never the full content. */
function summarizeResult(toolResponse: unknown): string | undefined {
  const text = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
  if (typeof text !== "string") return undefined;
  return text.length > RESULT_SNIPPET_MAX_CHARS ? `${text.slice(0, RESULT_SNIPPET_MAX_CHARS)}...` : text;
}

/** Reduces a tool's input to its single most identifying field when there's an obvious one, for compactness -- falls back to the whole (already small) object otherwise. */
function summarizeInput(toolInput: unknown): unknown {
  if (!isPlainObject(toolInput)) return toolInput;
  if (typeof toolInput.command === "string") return toolInput.command;
  if (typeof toolInput.file_path === "string") return toolInput.file_path;
  if (typeof toolInput.pattern === "string") return toolInput.pattern;
  return toolInput;
}

interface StepSummary {
  index: number;
  hookEventName: string;
  toolName: string | undefined;
  /** "success"/"failure" only for tool_result steps; undefined for anything else (prompts, lifecycle events, etc). */
  outcome: "success" | "failure" | undefined;
  /** Read directly from the raw hook event's own agent_id field (see subagentOverlap.ts) -- undefined for main-thread steps. Always shown in the window text, even when absent: empirically, omitting it made the model noticeably less reliable even on unrelated questions. */
  agentId: string | undefined;
  /** A short, safely-truncated snippet of the tool's result content, when this step has one. Never the full raw response. */
  resultSnippet: string | undefined;
}

function summarizeStep(step: TrajectoryStepWithUsage, rawEventsById: Map<number, DriftRawEvent>): StepSummary {
  const data = step.event.data;
  const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
  const outcome: "success" | "failure" | undefined =
    step.event.type === "tool_result" ? (step.event.hookEventName === "PostToolUseFailure" ? "failure" : "success") : undefined;
  const agentId = rawAgentId(rawEventsById.get(step.event.rawEventId));
  const resultSnippet = Object.prototype.hasOwnProperty.call(data, "toolResponse") ? summarizeResult(data.toolResponse) : undefined;
  return { index: step.index, hookEventName: step.event.hookEventName, toolName, outcome, agentId, resultSnippet };
}

/** The focus steps plus a little preceding context -- never the full trajectory, and never more than a short, truncated snippet of any step's result content (see summarizeResult). Kept alongside the structured evidence below as compact trajectory context. */
function buildStepWindow(
  steps: TrajectoryStepWithUsage[],
  focusStepIndexes: number[],
  rawEventsById: Map<number, DriftRawEvent>,
  lookback = 3
): StepSummary[] {
  const minFocus = Math.min(...focusStepIndexes);
  const maxFocus = Math.max(...focusStepIndexes);
  const start = Math.max(0, minFocus - lookback);
  const summaries: StepSummary[] = [];
  for (let i = start; i <= maxFocus && i < steps.length; i++) {
    summaries.push(summarizeStep(steps[i], rawEventsById));
  }
  return summaries;
}

function formatWindow(stepWindow: StepSummary[]): string {
  return stepWindow
    .map(
      (s) =>
        `- step ${s.index}: ${s.hookEventName}${s.toolName ? ` (${s.toolName})` : ""}${s.outcome ? ` -> ${s.outcome}` : ""} agent=${s.agentId ?? "(none)"}${s.resultSnippet !== undefined ? ` result="${s.resultSnippet}"` : ""}`
    )
    .join("\n");
}

function overlapsFocus(indexes: number[], focusStepIndexes: number[]): boolean {
  return indexes.some((i) => focusStepIndexes.includes(i));
}

interface FindingEvidence {
  type: string;
  involvedSteps: number[];
  evidence: Record<string, unknown>;
}

/**
 * Every M8A/M8B finding that covers the focus window, as raw structural
 * evidence only -- type, involved steps, and the finding's own objective
 * evidence field -- never as a conclusion or a suggested class. The
 * classification prompt explicitly labels this as a claim to verify
 * against "attempts", not to trust blindly.
 *
 * When a subagent_overlap finding covers the exact same steps as an M8A
 * repetition-shaped finding, the repetition finding is dropped: the same
 * underlying event -- the same command occurring more than once -- is
 * what both detectors are independently describing, so the repetition
 * finding adds no information the overlap finding doesn't already carry,
 * and was observed to pull classification toward redundant_exploration
 * purely from the word "repeated" in the finding type.
 */
function collectFindingEvidence(
  features: TrajectoryFeatureFinding[],
  overlaps: SubagentOverlapFinding[],
  focusStepIndexes: number[]
): FindingEvidence[] {
  // M8B can report several subagent_overlap findings for the exact same
  // steps (e.g. both same_tool_input and same_result_fingerprint) --
  // structurally correct, but verified directly to have the same
  // confusing effect on the model as showing an M8A repetition finding
  // alongside an overlap finding does: only the first is kept.
  const seenOverlapStepKeys = new Set<string>();
  const relevantOverlaps = overlaps.filter((o) => {
    if (!overlapsFocus(o.stepIndexes, focusStepIndexes)) return false;
    const key = o.stepIndexes.join(",");
    if (seenOverlapStepKeys.has(key)) return false;
    seenOverlapStepKeys.add(key);
    return true;
  });
  const overlapStepKey = new Set(relevantOverlaps.map((o) => o.stepIndexes.join(",")));

  const relevantFeatures = features.filter(
    (f) =>
      overlapsFocus(f.stepIndexes, focusStepIndexes) &&
      !(
        (f.type === "repeated_command" || f.type === "repeated_context" || f.type === "unchanged_file_reread" || f.type === "retry_without_state_change") &&
        overlapStepKey.has(f.stepIndexes.join(","))
      )
  );

  return [...relevantFeatures, ...relevantOverlaps].map((f) => ({ type: f.type, involvedSteps: f.stepIndexes, evidence: f.evidence }));
}

/** One objective occurrence of a tool call within the focus window -- the atomic unit the evidence bundle and the consistency validator both key off. */
export interface AttemptEvidence {
  tool: string | undefined;
  input: unknown;
  outcome: "success" | "failure" | undefined;
  resultSummary: string | undefined;
  agentId: string | null;
}

/** Every tool call result within the focus window, in step order -- the objective, per-occurrence record the model (and the consistency validator) reason over. */
function buildAttempts(steps: TrajectoryStepWithUsage[], focusStepIndexes: number[], rawEventsById: Map<number, DriftRawEvent>): AttemptEvidence[] {
  const sorted = [...focusStepIndexes].sort((a, b) => a - b);
  const attempts: AttemptEvidence[] = [];

  for (const index of sorted) {
    const step = steps[index];
    if (!step || step.event.type !== "tool_result") continue;
    const data = step.event.data;
    const agentId = rawAgentId(rawEventsById.get(step.event.rawEventId)) ?? null;

    if (Array.isArray(data.toolCalls)) {
      for (const call of data.toolCalls as unknown[]) {
        if (!isPlainObject(call)) continue;
        const hasResult = Object.prototype.hasOwnProperty.call(call, "toolResponse");
        attempts.push({
          tool: typeof call.toolName === "string" ? call.toolName : undefined,
          input: summarizeInput(call.toolInput),
          // A PostToolBatch sub-call has no objective per-call failure signal (no "PostToolBatchFailure" event
          // exists) -- never inferred from response content, so its outcome is left undefined rather than guessed.
          outcome: undefined,
          resultSummary: hasResult ? summarizeResult(call.toolResponse) : undefined,
          agentId,
        });
      }
      continue;
    }

    attempts.push({
      tool: typeof data.toolName === "string" ? data.toolName : undefined,
      input: summarizeInput(data.toolInput),
      outcome: step.event.hookEventName === "PostToolUseFailure" ? "failure" : "success",
      resultSummary: Object.prototype.hasOwnProperty.call(data, "toolResponse") ? summarizeResult(data.toolResponse) : undefined,
      agentId,
    });
  }

  return attempts;
}

const STATE_MUTATING_TOOL_NAMES = new Set(["Write", "Edit"]);

/** Every successful Write/Edit tool call within the focus window, as a peer evidence array rather than a yes/no fact -- empty, never omitted or worded as a conclusion, when none occurred. */
function buildStateChanges(steps: TrajectoryStepWithUsage[], focusStepIndexes: number[]): Array<{ tool: string; target: string | undefined }> {
  const minFocus = Math.min(...focusStepIndexes);
  const maxFocus = Math.max(...focusStepIndexes);
  const changes: Array<{ tool: string; target: string | undefined }> = [];

  for (let index = minFocus; index <= maxFocus; index++) {
    const step = steps[index];
    if (!step || step.event.type !== "tool_result" || step.event.hookEventName === "PostToolUseFailure") continue;
    const toolName = typeof step.event.data.toolName === "string" ? step.event.data.toolName : undefined;
    if (!toolName || !STATE_MUTATING_TOOL_NAMES.has(toolName)) continue;
    const toolInput = isPlainObject(step.event.data.toolInput) ? step.event.data.toolInput : undefined;
    changes.push({ tool: toolName, target: toolInput && typeof toolInput.file_path === "string" ? toolInput.file_path : undefined });
  }

  return changes;
}

/** Structural, string-level differences between consecutive attempts' results -- purely mechanical comparison, never a semantic judgment of what the difference means. */
function buildNewEvidenceSignals(attempts: AttemptEvidence[]): string[] {
  const signals: string[] = [];
  for (let i = 1; i < attempts.length; i++) {
    if (attempts[i].resultSummary !== attempts[i - 1].resultSummary) {
      signals.push(`result changed from ${JSON.stringify(attempts[i - 1].resultSummary)} to ${JSON.stringify(attempts[i].resultSummary)}`);
    }
  }
  return signals;
}

/** Structural, string-level differences between consecutive attempts' inputs -- signals a changed approach, purely mechanical comparison. */
function buildNewHypothesisSignals(attempts: AttemptEvidence[]): string[] {
  const signals: string[] = [];
  for (let i = 1; i < attempts.length; i++) {
    if (JSON.stringify(attempts[i].input) !== JSON.stringify(attempts[i - 1].input)) {
      signals.push(`input changed from ${JSON.stringify(attempts[i - 1].input)} to ${JSON.stringify(attempts[i].input)}`);
    }
  }
  return signals;
}

/** The complete neutral evidence bundle sent to the model -- every field a peer, none phrased as a recommendation or a stated conclusion. */
export interface EvidenceBundle {
  attempts: AttemptEvidence[];
  stateChangesBetweenAttempts: Array<{ tool: string; target: string | undefined }>;
  newEvidenceBetweenAttempts: string[];
  newHypothesisSignals: string[];
  deterministicFindings: FindingEvidence[];
}

/** Same "nearest preceding user_prompt step" rule trajectoryFeatures.ts/subagentOverlap.ts use, duplicated here for the same reason as the other small helpers in those files. */
function buildOwnerPromptIndex(steps: TrajectoryStepWithUsage[]): number[] {
  const owner: number[] = [];
  let current = -1;
  for (const step of steps) {
    if (step.event.type === "user_prompt") current = step.index;
    owner.push(current);
  }
  return owner;
}

function usageForWindow(steps: TrajectoryStepWithUsage[], focusStepIndexes: number[]): UsageSummary | undefined {
  const ownerPromptIndex = buildOwnerPromptIndex(steps);
  const ownerIndexes = new Set<number>();
  for (const index of focusStepIndexes) {
    const owner = ownerPromptIndex[index];
    if (owner !== undefined && owner !== -1) ownerIndexes.add(owner);
  }

  const records: AttributedUsageRecord[] = [];
  for (const ownerIndex of ownerIndexes) {
    const usage = steps[ownerIndex]?.usage;
    if (usage) records.push(...usage.records);
  }
  return records.length > 0 ? summarize(records) : undefined;
}

function buildClassificationPrompt(evidence: EvidenceBundle, windowText: string, usage: UsageSummary | undefined): string {
  const usageText = usage
    ? `Attributed usage for this window: ${usage.modelCalls} model call(s), ${usage.inputTokens ?? "unknown"} input tokens, ${usage.outputTokens ?? "unknown"} output tokens.`
    : "No model usage is attributed to this window.";

  return `Classify this coding agent situation using ONLY the evidence below. All fields in EVIDENCE are peer facts -- weigh them together, do not favor one field over another.

CLASS MEANINGS:
- productive_retry: the LAST attempt in "attempts" succeeded, and an earlier attempt failed, and stateChangesBetweenAttempts is non-empty.
- stalled_retry: the LAST attempt in "attempts" failed, and an earlier attempt also failed, and stateChangesBetweenAttempts is empty.
- new_exploration: attempts has only one entry, or nothing here repeats prior work.
- redundant_exploration: attempts repeat prior identical work with an empty newEvidenceBetweenAttempts and empty stateChangesBetweenAttempts.
- duplicate_subagent_work: deterministicFindings include a subagent_overlap and the attempts show 2 or more distinct, real agent ids.

EVIDENCE (JSON -- deterministicFindings are automated claims to verify against "attempts", not conclusions to trust blindly):
${JSON.stringify(evidence, null, 2)}

TRAJECTORY WINDOW:
${windowText}

${usageText}

Classify this situation. Base your answer on the LAST attempt's actual outcome above all else.`;
}

/** The objective facts the consistency validator checks against -- computed once, directly from attempts, and never asked of the model. */
interface RetryOutcomeFacts {
  lastAttemptOutcome: "success" | "failure" | undefined;
  distinctAgentCount: number;
}

function computeRetryOutcomeFacts(attempts: AttemptEvidence[]): RetryOutcomeFacts {
  const lastAttemptOutcome = attempts.length > 0 ? attempts[attempts.length - 1].outcome : undefined;
  const distinctAgentCount = new Set(attempts.map((a) => a.agentId).filter((id): id is string => id !== null)).size;
  return { lastAttemptOutcome, distinctAgentCount };
}

/**
 * Post-hoc, purely structural veto over the model's own classification,
 * checked against the same objective facts and evidence the model was
 * given (never re-asked of the model, so these are already 100% known
 * from the trajectory alone). Catches internally contradictory output --
 * e.g. productive_retry when the relevant attempt itself failed, or
 * newEvidence:false when the evidence bundle itself already contains an
 * objectively detected change -- and rejects it outright rather than
 * silently rewriting it to something else: a caller must never receive a
 * classification that contradicts the very evidence it was computed
 * from. This validator only ever rejects; it never derives class from
 * newEvidence, and never forces semanticRedundancy/progress from
 * deterministic evidence -- those remain entirely the model's own
 * judgment, unchecked.
 */
function validateSemanticConsistency(classification: SemanticClassification, facts: RetryOutcomeFacts, evidence: EvidenceBundle): string | undefined {
  if (classification.class === "productive_retry" && facts.lastAttemptOutcome !== "success") {
    return "productive_retry is invalid: the relevant attempt did not succeed";
  }
  if (classification.class === "stalled_retry" && facts.lastAttemptOutcome === "success") {
    return "stalled_retry is invalid: the relevant attempt succeeded";
  }
  if (classification.class === "duplicate_subagent_work" && facts.distinctAgentCount < 2) {
    return "duplicate_subagent_work is invalid: fewer than 2 distinct agents are evidenced";
  }
  // newEvidenceBetweenAttempts/newHypothesisSignals are themselves objective
  // (built by plain string comparison in buildNewEvidenceSignals/
  // buildNewHypothesisSignals, never a semantic judgment) -- when one is
  // non-empty, the model already has, in its own evidence, a fact it cannot
  // legitimately claim didn't happen. The reverse is never enforced: an
  // empty array only means nothing OBJECTIVE was detected, not that
  // nothing relevant happened, so the model remains free to say true from
  // its own reading of the window.
  if (evidence.newEvidenceBetweenAttempts.length > 0 && classification.newEvidence === false) {
    return "newEvidence is invalid: newEvidenceBetweenAttempts contains an objectively detected change, but newEvidence was reported false";
  }
  if (evidence.newHypothesisSignals.length > 0 && classification.newHypothesis === false) {
    return "newHypothesis is invalid: newHypothesisSignals contains an objectively detected change, but newHypothesis was reported false";
  }
  return undefined;
}

/**
 * Classifies one trajectory window using the local model only, in a
 * single real inference pass over neutral, structured evidence -- never
 * a stated category, never a conclusion-shaped fact sentence. Pure with
 * respect to its inputs (never mutates trajectoryUsage/features/overlaps)
 * and deterministic in what it asks: the same request always produces
 * the same prompt, sent at temperature 0 with a JSON-schema grammar
 * constraint, so repeat calls against an unloaded model produce stable
 * output. Never throws -- every failure path (a failed inference call,
 * non-JSON output, output that fails schema validation, output that
 * fails semantic consistency validation) is reported through the
 * returned ClassificationResult instead.
 */
export async function classifyWindow(
  request: ClassificationRequest,
  storage: DriftStorage,
  runtime: LocalModelRuntime,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS
): Promise<ClassificationResult> {
  const { trajectoryUsage, features, overlaps, focusStepIndexes } = request;
  const steps = trajectoryUsage.steps;

  const sessionData = storage.getSession(trajectoryUsage.sessionId);
  const rawEventsById = new Map<number, DriftRawEvent>();
  for (const rawEvent of sessionData?.events ?? []) {
    rawEventsById.set(rawEvent.id, rawEvent);
  }

  const stepWindow = buildStepWindow(steps, focusStepIndexes, rawEventsById);
  const windowText = formatWindow(stepWindow);
  const usage = usageForWindow(steps, focusStepIndexes);

  const attempts = buildAttempts(steps, focusStepIndexes, rawEventsById);
  const evidence: EvidenceBundle = {
    attempts,
    stateChangesBetweenAttempts: buildStateChanges(steps, focusStepIndexes),
    newEvidenceBetweenAttempts: buildNewEvidenceSignals(attempts),
    newHypothesisSignals: buildNewHypothesisSignals(attempts),
    deterministicFindings: collectFindingEvidence(features, overlaps, focusStepIndexes),
  };

  const prompt = buildClassificationPrompt(evidence, windowText, usage);
  const result = await runtime.infer(prompt, { maxTokens: maxOutputTokens, jsonSchema: CLASSIFICATION_JSON_SCHEMA });

  if (!result.record.success || result.text === undefined) {
    return { classification: undefined, raw: result.text, success: false, error: result.record.error ?? "no text returned" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch (error) {
    return {
      classification: undefined,
      raw: result.text,
      success: false,
      error: `model output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const classification = validateClassification(parsed);
  if (!classification) {
    return { classification: undefined, raw: result.text, success: false, error: "model output did not match the required classification schema" };
  }

  const consistencyError = validateSemanticConsistency(classification, computeRetryOutcomeFacts(attempts), evidence);
  if (consistencyError) {
    return { classification: undefined, raw: result.text, success: false, error: consistencyError };
  }

  return { classification, raw: result.text, success: true, error: undefined };
}
