/**
 * Enriches an already-built Trajectory (trajectory.ts) with Claude
 * model-usage data, using the exact-identifier correlations from
 * modelUsageCorrelation.ts (M7B). This is a pure read/decorate layer: it
 * never mutates the trajectory it's given, never changes step order or
 * count, and never touches trajectory.ts or normalizedEvent.ts.
 *
 * Attribution rule: a correlated record can only land on a step when its
 * promptId exactly matches the prompt_id of a "user_prompt" step in this
 * same trajectory (the step that represents that prompt/turn). A record
 * that is session-correlated but has no such match — no promptId at all,
 * or a promptId with no matching user_prompt step in this trajectory —
 * stays visible only in the session-level totals, never guessed onto a
 * step. There is no timestamp-based fallback anywhere in this module.
 */

import { DriftRawEvent, DriftStorage } from "./storage";
import { Trajectory, TrajectoryStep } from "./trajectory";
import { correlateModelUsageForSession } from "./modelUsageCorrelation";
import { extractModelUsage, emptyClaudeModelUsage, metricOccurrenceFingerprint, ClaudeModelUsage } from "./claudeTelemetryIngest";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sumDefined(values: (number | undefined)[]): number | undefined {
  const defined = values.filter((v): v is number => typeof v === "number");
  return defined.length === 0 ? undefined : defined.reduce((a, b) => a + b, 0);
}

/**
 * A `claude_code.api_request` log record carries a top-level `attributes`
 * array; a verbatim OTLP metric object (the shape model_usage_events
 * stores for claude_code.token.usage / claude_code.cost.usage, per M7A.1)
 * never does — its attributes live nested under sum/gauge.dataPoints[].
 * An api_request log record always represents its own distinct request,
 * so it's always an objective model call on its own.
 */
function isApiRequestShaped(payload: unknown): boolean {
  return isPlainObject(payload) && Array.isArray(payload.attributes);
}

/**
 * M13D: a live, non-interactive `claude -p` session was confirmed to emit
 * no `claude_code.api_request` log record at all — only periodic
 * `claude_code.token.usage` / `claude_code.cost.usage` metrics (see
 * claudeTelemetryIngest.ts's extractModelUsageFromMetric doc). Since cost
 * is levied per completed, billed API/model request, one genuinely-new
 * (never-before-seen, per metricOccurrenceFingerprint) claude_code.cost.usage
 * occurrence with a real numeric value is objective evidence one model call
 * completed — never inferred from a token count, an arbitrary event count,
 * a prompt count, or a hook count. A `claude_code.token.usage` occurrence
 * is never itself counted as a call (it would double count the very same
 * request its sibling cost.usage occurrence already accounts for) — its
 * only role is contributing token values to the aggregate sums below.
 */
function isGenuineModelCallOccurrence(payload: unknown, isDuplicateMetricOccurrence: boolean): boolean {
  if (isApiRequestShaped(payload)) return true;
  if (isDuplicateMetricOccurrence) return false;
  if (isPlainObject(payload) && payload.name === "claude_code.cost.usage") {
    return extractModelUsage(payload).costUsd !== undefined;
  }
  return false;
}

/** One correlated model-usage record, retained verbatim (plus its recovered usage fields) for auditability. */
export interface AttributedUsageRecord {
  modelUsageEventId: number;
  promptId: string | undefined;
  requestId: string | undefined;
  clientRequestId: string | undefined;
  /** True only for a structurally call-shaped record (see isApiRequestShaped) — the basis for modelCalls. */
  isModelCall: boolean;
  usage: ClaudeModelUsage;
}

/** Aggregated usage over a set of AttributedUsageRecords. A field is undefined when none of the records reported it — never fabricated as zero. */
export interface UsageSummary {
  modelCalls: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheWriteTokens: number | undefined;
  costUsd: number | undefined;
  durationMs: number | undefined;
  /** The exact records summed into this summary, for auditability. */
  records: AttributedUsageRecord[];
}

export interface TrajectoryStepWithUsage extends TrajectoryStep {
  /** Present only when at least one prompt-correlated record was attributed to this step. */
  usage?: UsageSummary;
}

export interface TrajectoryUsage {
  sessionId: string;
  steps: TrajectoryStepWithUsage[];
  /** Sum of every usage record correlated to this session — both step-attributed and session-only. */
  sessionTotals: UsageSummary;
}

/** Exposed for trajectoryFeatures.ts, so a finding spanning several steps can report one combined usage summary using the exact same aggregation rules as a step's own usage. */
export function summarize(records: AttributedUsageRecord[]): UsageSummary {
  return {
    modelCalls: records.filter((r) => r.isModelCall).length,
    inputTokens: sumDefined(records.map((r) => r.usage.inputTokens)),
    outputTokens: sumDefined(records.map((r) => r.usage.outputTokens)),
    cacheReadTokens: sumDefined(records.map((r) => r.usage.cacheReadTokens)),
    cacheWriteTokens: sumDefined(records.map((r) => r.usage.cacheCreationTokens)),
    costUsd: sumDefined(records.map((r) => r.usage.costUsd)),
    durationMs: sumDefined(records.map((r) => r.usage.durationMs)),
    records,
  };
}

/**
 * Builds a `prompt_id -> step index` map for a trajectory's own
 * "user_prompt" steps, by looking each step's raw event back up in
 * storage (NormalizedEvent itself carries no promptId field). If more
 * than one user_prompt step somehow shares a prompt_id, the first one in
 * trajectory order wins — a fixed, deterministic tie-break, not a guess
 * about identity, since the match itself is still an exact string equality.
 */
function buildPromptStepIndex(trajectory: Trajectory, rawEventsById: Map<number, DriftRawEvent>): Map<string, number> {
  const index = new Map<string, number>();
  for (const step of trajectory.steps) {
    if (step.event.type !== "user_prompt") continue;
    const rawEvent = rawEventsById.get(step.event.rawEventId);
    const promptId = isPlainObject(rawEvent?.payload) ? str(rawEvent.payload.prompt_id) : undefined;
    if (promptId !== undefined && !index.has(promptId)) {
      index.set(promptId, step.index);
    }
  }
  return index;
}

/**
 * Enriches `trajectory` with Claude model-usage data drawn from storage.
 * Pure and deterministic: the same trajectory and storage contents always
 * produce the same result. Step order, count, and content are preserved
 * exactly — only an optional `usage` field is added to each step.
 */
export function attributeUsageToTrajectory(trajectory: Trajectory, storage: DriftStorage): TrajectoryUsage {
  const sessionId = trajectory.sessionId;
  const sessionData = storage.getSession(sessionId);

  const rawEventsById = new Map<number, DriftRawEvent>();
  for (const rawEvent of sessionData?.events ?? []) {
    rawEventsById.set(rawEvent.id, rawEvent);
  }
  const promptStepIndex = buildPromptStepIndex(trajectory, rawEventsById);

  const modelUsageEventsById = new Map(storage.getModelUsageEvents(sessionId).map((e) => [e.id, e]));
  const correlations = correlateModelUsageForSession(sessionId, storage);

  const stepRecords = new Map<number, AttributedUsageRecord[]>();
  const allRecords: AttributedUsageRecord[] = [];
  // Scoped to this one attributeUsageToTrajectory call, i.e. to this one
  // session — a fingerprint seen for a different session's own call can
  // never suppress this session's occurrence (see modelUsageCorrelation.ts's
  // own per-session correlation, which already keeps sessionId exact-match
  // only, never a timestamp-based guess).
  const seenMetricOccurrences = new Set<string>();

  for (const correlation of correlations) {
    // A correlation's sessionId is only set when it's a confirmed member of
    // this exact session (see modelUsageCorrelation.ts) — anything else is
    // not this session's usage to total, even though the query was scoped
    // to this session id.
    if (correlation.sessionId !== sessionId) {
      continue;
    }

    const usageEvent = modelUsageEventsById.get(correlation.modelUsageEventId);
    const payload = usageEvent?.payload;

    // A metric occurrence's fingerprint is shared by every stored row that
    // describes the SAME real occurrence — either sibling rows from one
    // multi-data-point export (M7A.1 stores one row per data point) or the
    // identical delta window re-exported on a later periodic tick (observed
    // live in M13D-LIVE). Only the first-seen row contributes real usage;
    // later duplicates are still kept in `records` for auditability, but
    // with usage left empty rather than fabricated as a second real event.
    const fingerprint = metricOccurrenceFingerprint(payload);
    const isDuplicateMetricOccurrence = fingerprint !== undefined && seenMetricOccurrences.has(fingerprint);
    if (fingerprint !== undefined) {
      seenMetricOccurrences.add(fingerprint);
    }

    const record: AttributedUsageRecord = {
      modelUsageEventId: correlation.modelUsageEventId,
      promptId: correlation.promptId,
      requestId: correlation.requestId,
      clientRequestId: correlation.clientRequestId,
      isModelCall: isGenuineModelCallOccurrence(payload, isDuplicateMetricOccurrence),
      usage: isDuplicateMetricOccurrence ? emptyClaudeModelUsage() : extractModelUsage(payload),
    };
    allRecords.push(record);

    if (record.promptId !== undefined) {
      const stepIndex = promptStepIndex.get(record.promptId);
      if (stepIndex !== undefined) {
        const existing = stepRecords.get(stepIndex);
        if (existing) {
          existing.push(record);
        } else {
          stepRecords.set(stepIndex, [record]);
        }
      }
    }
  }

  const steps: TrajectoryStepWithUsage[] = trajectory.steps.map((step) => {
    const records = stepRecords.get(step.index);
    return records && records.length > 0 ? { ...step, usage: summarize(records) } : { ...step };
  });

  return { sessionId, steps, sessionTotals: summarize(allRecords) };
}
