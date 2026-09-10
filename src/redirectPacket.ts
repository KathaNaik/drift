/**
 * A pure, read-only redirect-packet generator for M10A's redirect_candidate
 * decision state. This module never calls the local model, never writes to
 * storage, and never touches Claude in any way -- it only assembles a
 * compact, human-reviewable packet from evidence that has already been
 * computed: the original trajectory (M5B/M7C), the deterministic findings
 * and validated semantic classification a redirect_candidate window already
 * carries (M9B.2/M9B.3/M10A), and the decision itself. Approving or
 * cancelling the resulting packet is the caller's concern (see
 * extension.ts) -- generation here has no side effects either way.
 *
 * Every field is grounded in already-known facts:
 * - currentState is built only from the objective outcome (success/failure,
 *   result content, Write/Edit state mutations) of the trajectory steps the
 *   window itself points at -- never invented.
 * - avoidRepeating is built only from the deterministic evidence's own
 *   type and data (a command string, a file path, an agent id pairing) --
 *   never a generic "be more efficient" instruction.
 * - suggestedNextAction is a small, class-keyed template drawing only on
 *   the already-validated semantic classification and the same objective
 *   facts -- it asks Claude to reassess or choose a different approach, and
 *   never prescribes a specific fix the trajectory itself didn't support.
 */

import { TrajectoryStepWithUsage, TrajectoryUsage } from "./trajectoryUsageAttribution";
import { SessionAnalysisWindow } from "./sessionAnalysisPipeline";
import { DeterministicEvidence } from "./findingDecisionPolicy";
import { SubagentOverlapFinding } from "./subagentOverlap";
import { ClassificationClass } from "./semanticClassifier";

function isSubagentOverlap(evidence: DeterministicEvidence): evidence is SubagentOverlapFinding {
  return evidence.type === "subagent_overlap";
}

const STATE_MUTATING_TOOL_NAMES = new Set(["Write", "Edit"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reduces a value to a short, single-line summary -- truncated, never a full JSON dump. Independent copy, consistent with the same rule applied throughout M11A/M11B/M11C, kept local so this module stays free of any vscode dependency. */
function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.length} item(s)]`;
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? "…" : String(v)}`)
      .join(", ");
  }
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export interface RedirectPacket {
  sessionId: string;
  /** Exactly the originating window's own stepIndexes -- never recomputed or altered. */
  sourceStepIndexes: number[];
  reasonCodes: string[];
  /** One objective fact per line -- outcomes and state mutations only, from the trajectory steps this window covers. */
  currentState: string[];
  /** The specific repeated behavior Drift's own deterministic evidence establishes -- never a generic instruction. */
  avoidRepeating: string;
  /** A concise, evidence-grounded redirect -- asks Claude to reassess or take a different approach, never a fabricated fix. */
  suggestedNextAction: string;
}

export interface RedirectPacketResult {
  success: boolean;
  packet: RedirectPacket | undefined;
  error: string | undefined;
}

function describeStep(step: TrajectoryStepWithUsage, steps: TrajectoryStepWithUsage[]): string[] {
  if (step.event.type !== "tool_result") return [];
  const data = step.event.data;

  if (Array.isArray(data.toolCalls)) {
    // A PostToolBatch sub-call has no objective per-call failure signal (see
    // M8A's own convention) -- described as "ran", never guessed as pass/fail.
    return (data.toolCalls as unknown[]).filter(isPlainObject).map((call) => {
      const toolName = typeof call.toolName === "string" ? call.toolName : "Tool";
      const toolInput = call.toolInput;
      const hasResult = Object.prototype.hasOwnProperty.call(call, "toolResponse");
      const inputText = toolInput !== undefined ? summarizeValue(toolInput) : undefined;
      const resultText = hasResult ? summarizeValue(call.toolResponse) : undefined;
      return `${toolName}${inputText ? ` (${inputText})` : ""} ran${resultText ? `: ${resultText}` : ""}`;
    });
  }

  const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
  const failed = step.event.hookEventName === "PostToolUseFailure";
  const invocation = step.linkedStepIndex !== undefined ? steps[step.linkedStepIndex] : undefined;
  const toolInput = invocation?.event.data.toolInput;
  const inputText = toolInput !== undefined ? summarizeValue(toolInput) : undefined;
  const hasResult = Object.prototype.hasOwnProperty.call(data, "toolResponse");
  const resultText = hasResult ? summarizeValue(data.toolResponse) : undefined;

  if (failed) {
    return [`${toolName ?? "Tool"}${inputText ? ` (${inputText})` : ""} failed${resultText ? `: ${resultText}` : ""}`];
  }
  if (toolName && STATE_MUTATING_TOOL_NAMES.has(toolName)) {
    return [`State changed: ${toolName}${inputText ? ` (${inputText})` : ""} succeeded${resultText ? `: ${resultText}` : ""}`];
  }
  return [`${toolName ?? "Tool"}${inputText ? ` (${inputText})` : ""} succeeded${resultText ? `: ${resultText}` : ""}`];
}

/** Only objective outcomes and state mutations from the exact steps the window covers -- nothing about the involved steps is invented or inferred beyond what the trajectory itself already records. */
function buildCurrentState(trajectoryUsage: TrajectoryUsage, stepIndexes: number[]): string[] {
  const steps = trajectoryUsage.steps;
  const lines: string[] = [];
  for (const index of [...stepIndexes].sort((a, b) => a - b)) {
    const step = steps[index];
    if (!step) continue;
    lines.push(...describeStep(step, steps));
  }
  return lines;
}

const EVIDENCE_DESCRIPTIONS: Record<string, (evidence: DeterministicEvidence) => string> = {
  repeated_command: (e) => `Repeated command: "${String(e.evidence.normalizedCommand ?? summarizeValue(e.evidence))}" run ${e.evidence.occurrences ?? "multiple"} times`,
  repeated_failure: (e) =>
    `Repeated identical failing command: ${String(e.evidence.toolName ?? "a tool")} (${summarizeValue(e.evidence.toolInput)}) failed the same way ${e.evidence.occurrences ?? "multiple"} times: ${summarizeValue(e.evidence.failureResponse)}`,
  retry_without_state_change: (e) => `Retried ${String(e.evidence.toolName ?? "a tool")} (${summarizeValue(e.evidence.toolInput)}) again with no state change in between`,
  repeated_context: (e) => `Reused identical result for ${String(e.evidence.toolName ?? "a tool")} (${summarizeValue(e.evidence.toolInput)}) ${e.evidence.occurrences ?? "multiple"} times`,
  unchanged_file_reread: (e) => `Reread unchanged file: ${String(e.evidence.filePath ?? summarizeValue(e.evidence))}`,
  subagent_overlap: (e) => {
    const agentIds = isSubagentOverlap(e) ? e.agentIds : [];
    const kind = e.evidence.overlapKind === "same_tool_input" ? "the same call" : "equivalent work";
    return `Duplicate subagent work: ${agentIds.join(" and ") || "multiple agents"} both performed ${kind} on ${String(e.evidence.toolName ?? "a tool")}`;
  },
};

/** The specific repeated behavior this window's own deterministic evidence establishes -- one description per distinct evidence type present, joined together. Never a generic "be more efficient" instruction, and never invented when no evidence is present. */
function buildAvoidRepeating(deterministicEvidence: DeterministicEvidence[]): string {
  const seen = new Set<string>();
  const descriptions: string[] = [];
  for (const evidence of deterministicEvidence) {
    if (seen.has(evidence.type)) continue;
    seen.add(evidence.type);
    const describe = EVIDENCE_DESCRIPTIONS[evidence.type];
    descriptions.push(describe ? describe(evidence) : `Repeated pattern detected: ${evidence.type}`);
  }
  return descriptions.length > 0 ? descriptions.join("; ") : "No specific repeated behavior was evidenced.";
}

const NEXT_ACTION_BY_CLASS: Partial<Record<ClassificationClass, string>> = {
  stalled_retry: "Stop retrying the same command as-is. Reassess why it keeps failing given the result above, and choose a different diagnostic step or approach before trying again.",
  duplicate_subagent_work: "Coordinate the subagents involved instead of repeating the same work independently -- confirm which agent owns this task before continuing.",
  redundant_exploration: "This exploration has already produced the same result with no new information. Inspect different evidence or move to a different part of the task.",
};

/** A concise, evidence-grounded suggestion -- keyed off the already-validated semantic classification when present, otherwise a neutral fallback grounded only in the objective fact that progress has stalled. Never prescribes a specific fix the trajectory itself doesn't support. */
function buildSuggestedNextAction(window: SessionAnalysisWindow): string {
  const classification = window.semanticResult.success ? window.semanticResult.classification : undefined;
  if (classification) {
    const templated = NEXT_ACTION_BY_CLASS[classification.class];
    if (templated) return templated;
  }
  return "Reassess the current approach before continuing -- the repeated pattern above has not produced new progress.";
}

/**
 * Generates a redirect packet for one redirect_candidate analysis window.
 * Pure and deterministic: the same inputs always produce the same packet,
 * nothing is mutated, and no local model call is made or required.
 *
 * Rejects (never fabricates a packet) when:
 * - `window.decision.state` is not "redirect_candidate" (Observe/Finding
 *   analyses can never produce a packet), or
 * - `sessionId` doesn't match either the window's own recorded session
 *   (`window.decision.sessionId`) or the trajectory passed in
 *   (`trajectoryUsage.sessionId`) -- a stale or mismatched analysis is
 *   never silently applied to a different session.
 */
export function generateRedirectPacket(sessionId: string, window: SessionAnalysisWindow, trajectoryUsage: TrajectoryUsage): RedirectPacketResult {
  if (window.decision.sessionId !== sessionId || trajectoryUsage.sessionId !== sessionId) {
    return {
      success: false,
      packet: undefined,
      error: `session mismatch: requested sessionId "${sessionId}" does not match the analysis (session "${window.decision.sessionId}") and/or trajectory (session "${trajectoryUsage.sessionId}")`,
    };
  }

  if (window.decision.state !== "redirect_candidate") {
    return {
      success: false,
      packet: undefined,
      error: `redirect packets can only be generated for redirect_candidate analyses, got "${window.decision.state}"`,
    };
  }

  const deterministicEvidence: DeterministicEvidence[] = [...window.deterministicFindings, ...window.subagentOverlaps];

  const packet: RedirectPacket = {
    sessionId,
    sourceStepIndexes: [...window.stepIndexes],
    reasonCodes: [...window.decision.reasonCodes],
    currentState: buildCurrentState(trajectoryUsage, window.stepIndexes),
    avoidRepeating: buildAvoidRepeating(deterministicEvidence),
    suggestedNextAction: buildSuggestedNextAction(window),
  };

  return { success: true, packet, error: undefined };
}

/**
 * The exact compact context block M12B injects into Claude's next
 * UserPromptSubmit for the approved session -- currentState, avoidRepeating,
 * and suggestedNextAction only. Deliberately excludes sessionId,
 * sourceStepIndexes, and reasonCodes (all shown in the human review text
 * from formatRedirectPacketText, never in what Claude itself sees) --
 * per M12B: no Drift internal scores, reasonCodes, token statistics, raw
 * trajectory JSON, or hidden classifier output may leak into injected
 * context.
 */
export function formatInjectedRedirectContext(packet: RedirectPacket): string {
  return [
    "DRIFT REDIRECT",
    "",
    "Current state:",
    packet.currentState.length > 0 ? packet.currentState.join("\n") : "(no objective state established)",
    "",
    "Avoid repeating:",
    packet.avoidRepeating,
    "",
    "Suggested next action:",
    packet.suggestedNextAction,
    "",
    "This is guidance, not a forced command.",
  ].join("\n");
}

/** A compact, human-readable rendering of a packet for review before Approve/Cancel -- never a raw JSON dump. */
export function formatRedirectPacketText(packet: RedirectPacket): string {
  const lines = [
    `Drift redirect packet -- session ${packet.sessionId}`,
    `Source steps: ${packet.sourceStepIndexes.join(", ")}`,
    "",
    "Current state:",
    ...(packet.currentState.length > 0 ? packet.currentState.map((line) => `- ${line}`) : ["  (no objective state established)"]),
    "",
    `Avoid repeating: ${packet.avoidRepeating}`,
    "",
    `Suggested next action: ${packet.suggestedNextAction}`,
    "",
    `Reason codes: ${packet.reasonCodes.join(", ")}`,
  ];
  return lines.join("\n");
}
