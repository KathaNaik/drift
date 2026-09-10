/**
 * A pure, read-only end-of-session report builder. Every field here comes
 * directly from data other modules already computed -- the stored
 * trajectory (M5B), M7C usage attribution, and the latest M10B
 * SessionAnalysis when one exists (M11A/M11B already hold it in memory) --
 * this module derives nothing new about what a session "means" and adds no
 * detector, policy, or scoring logic of its own. Building a report never
 * touches the local model and never writes to storage.
 *
 * Terminology matters here: Drift has not run a controlled intervention
 * experiment, so nothing in this module (or its presentation layer) may
 * claim compute was "saved" or "avoided", or attach an energy/sustainability
 * figure. Findings are reported as "detected patterns", never as prevented
 * waste.
 */

import { DriftRawEvent } from "./storage";
import { TrajectoryStepWithUsage, TrajectoryUsage, UsageSummary } from "./trajectoryUsageAttribution";
import { SessionAnalysis } from "./sessionAnalysisPipeline";
import { DecisionState } from "./findingDecisionPolicy";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawAgentId(rawEvent: DriftRawEvent | undefined): string | undefined {
  if (!rawEvent || !isPlainObject(rawEvent.payload)) return undefined;
  return typeof rawEvent.payload.agent_id === "string" ? rawEvent.payload.agent_id : undefined;
}

/** Reduces a value to a short, single-line summary -- truncated, never a full JSON dump. Mirrors the same compactness rule the M11A/M11B views already apply, kept as an independent copy here so this module stays free of any vscode dependency and remains directly unit-testable. */
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

export interface SessionSummary {
  sessionId: string;
  totalSteps: number;
  toolCallCount: number;
  /** Distinct subagent count, present only when at least one step carries a real agent_id -- absent (never 0-as-a-guess) when no subagent activity was observed at all. */
  subagentCount: number | undefined;
}

export interface FindingsSummary {
  observeCount: number;
  findingCount: number;
  redirectCandidateCount: number;
  /** Every deterministic finding/overlap type observed across all analysis windows (any state), with how many times each occurred. */
  evidenceTypeCounts: Record<string, number>;
  /** Distinct semantic classes observed among successfully classified windows (any state), ascending. */
  semanticClassesObserved: string[];
}

export interface EvidenceSummaryEntry {
  state: Exclude<DecisionState, "observe">;
  stepIndexes: number[];
  deterministicEvidenceTypes: string[];
  /** Present only when that window's semantic classification succeeded and passed validation. */
  semanticClass: string | undefined;
  reasonCodes: string[];
  attributedUsage: UsageSummary | undefined;
}

export interface SessionOutcome {
  /** The last tool call in the trajectory with a definitive, single-call success/failure signal (a PostToolBatch sub-call has none, per M8A's own convention, and is skipped when looking for this). */
  finalToolCall: { stepIndex: number; toolName: string | undefined; inputSummary: string | undefined; outcome: "success" | "failure" } | undefined;
  /** Verbatim from the session's own SessionEnd event, when one was recorded. */
  sessionEndReason: string | undefined;
}

export interface SessionReport {
  sessionId: string;
  summary: SessionSummary;
  /** Exactly trajectoryUsage.sessionTotals -- the same M7C totals, never recomputed or approximated. */
  usage: UsageSummary;
  outcome: SessionOutcome;
  /** Undefined specifically means "no M10B analysis has been run for this session yet" -- distinct from a real analysis that simply found nothing notable (all-Observe), which reports real, all-zero-elsewhere counts instead. */
  findings: FindingsSummary | undefined;
  /** Undefined under the same "no analysis yet" condition as `findings`; an empty array is a real, valid report of "analyzed, no Finding/Redirect Candidate windows". */
  evidenceSummary: EvidenceSummaryEntry[] | undefined;
}

function countToolCalls(steps: TrajectoryStepWithUsage[]): number {
  let count = 0;
  for (const step of steps) {
    if (step.event.type === "tool_invocation") {
      count++;
      continue;
    }
    if (step.event.type === "tool_result") {
      const data = step.event.data;
      if (Array.isArray(data.toolCalls)) {
        count += data.toolCalls.length;
      } else if (step.linkedStepIndex === undefined) {
        // An orphan result with no matching invocation step is still one real call.
        count++;
      }
    }
  }
  return count;
}

function countDistinctSubagents(steps: TrajectoryStepWithUsage[], rawEventsById: Map<number, DriftRawEvent>): number | undefined {
  const agentIds = new Set<string>();
  for (const step of steps) {
    const id = rawAgentId(rawEventsById.get(step.event.rawEventId));
    if (id !== undefined) agentIds.add(id);
  }
  return agentIds.size > 0 ? agentIds.size : undefined;
}

function buildSummary(trajectoryUsage: TrajectoryUsage, rawEventsById: Map<number, DriftRawEvent>): SessionSummary {
  return {
    sessionId: trajectoryUsage.sessionId,
    totalSteps: trajectoryUsage.steps.length,
    toolCallCount: countToolCalls(trajectoryUsage.steps),
    subagentCount: countDistinctSubagents(trajectoryUsage.steps, rawEventsById),
  };
}

/** Exported for interventionMeasurement.ts (M13A), which needs the exact same objective outcome logic for its own, unrelated record shape. */
export function buildOutcome(trajectoryUsage: TrajectoryUsage): SessionOutcome {
  const steps = trajectoryUsage.steps;
  let finalToolCall: SessionOutcome["finalToolCall"];

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.event.type !== "tool_result") continue;
    const data = step.event.data;
    if (Array.isArray(data.toolCalls)) continue; // a PostToolBatch has no single objective outcome (see M8A convention)

    const outcome: "success" | "failure" = step.event.hookEventName === "PostToolUseFailure" ? "failure" : "success";
    const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
    const invocation = step.linkedStepIndex !== undefined ? steps[step.linkedStepIndex] : undefined;
    const toolInput = invocation?.event.data.toolInput;
    finalToolCall = { stepIndex: step.index, toolName, inputSummary: toolInput !== undefined ? summarizeValue(toolInput) : undefined, outcome };
    break;
  }

  let sessionEndReason: string | undefined;
  for (const step of steps) {
    if (step.event.type === "session_end" && typeof step.event.data.reason === "string") {
      sessionEndReason = step.event.data.reason;
    }
  }

  return { finalToolCall, sessionEndReason };
}

function buildFindingsSummary(analysis: SessionAnalysis): FindingsSummary {
  const evidenceTypeCounts: Record<string, number> = {};
  const semanticClasses = new Set<string>();
  let observeCount = 0;
  let findingCount = 0;
  let redirectCandidateCount = 0;

  for (const window of analysis.analyses) {
    if (window.decision.state === "observe") observeCount++;
    else if (window.decision.state === "finding") findingCount++;
    else redirectCandidateCount++;

    for (const evidence of [...window.deterministicFindings, ...window.subagentOverlaps]) {
      evidenceTypeCounts[evidence.type] = (evidenceTypeCounts[evidence.type] ?? 0) + 1;
    }
    if (window.semanticResult.success && window.semanticResult.classification) {
      semanticClasses.add(window.semanticResult.classification.class);
    }
  }

  return {
    observeCount,
    findingCount,
    redirectCandidateCount,
    evidenceTypeCounts,
    semanticClassesObserved: [...semanticClasses].sort(),
  };
}

function buildEvidenceSummary(analysis: SessionAnalysis): EvidenceSummaryEntry[] {
  return analysis.analyses
    .filter((w): w is typeof w & { decision: { state: Exclude<DecisionState, "observe"> } } => w.decision.state !== "observe")
    .map((window) => ({
      state: window.decision.state,
      stepIndexes: [...window.stepIndexes],
      deterministicEvidenceTypes: [...new Set([...window.deterministicFindings.map((f) => f.type), ...window.subagentOverlaps.map((o) => o.type)])],
      semanticClass: window.semanticResult.success && window.semanticResult.classification ? window.semanticResult.classification.class : undefined,
      reasonCodes: [...window.decision.reasonCodes],
      attributedUsage: window.decision.attributedUsage,
    }));
}

/**
 * Builds one session's end-of-session report. Pure: never mutates
 * `trajectoryUsage`/`rawEventsById`/`analysis`, never touches the local
 * model, never reads or writes storage, and always returns the same
 * result for the same input. `analysis` is only ever used when it belongs
 * to this exact session (`analysis.sessionId === trajectoryUsage.sessionId`)
 * -- a leftover analysis for a different session is treated the same as no
 * analysis at all, so the report never misattributes someone else's
 * findings.
 */
export function buildSessionReport(trajectoryUsage: TrajectoryUsage, rawEventsById: Map<number, DriftRawEvent>, analysis: SessionAnalysis | undefined): SessionReport {
  const matchingAnalysis = analysis && analysis.sessionId === trajectoryUsage.sessionId ? analysis : undefined;

  return {
    sessionId: trajectoryUsage.sessionId,
    summary: buildSummary(trajectoryUsage, rawEventsById),
    usage: trajectoryUsage.sessionTotals,
    outcome: buildOutcome(trajectoryUsage),
    findings: matchingAnalysis ? buildFindingsSummary(matchingAnalysis) : undefined,
    evidenceSummary: matchingAnalysis ? buildEvidenceSummary(matchingAnalysis) : undefined,
  };
}
