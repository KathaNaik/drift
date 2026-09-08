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
import { extractModelUsage, ClaudeModelUsage } from "./claudeTelemetryIngest";

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
 * That structural difference is what "one model call" means here: a
 * metric data point is a redundant aggregate signal, not itself a call,
 * and (per M7B) can never carry a promptId/requestId anyway. Counting it
 * as a call, or trying to recover a token count from it, would either
 * double count against its sibling api_request record or fabricate a
 * number this milestone has no extraction path for — so it contributes
 * to neither modelCalls nor the token/cost sums, though it still appears
 * in `records` for auditability.
 */
function isApiRequestShaped(payload: unknown): boolean {
  return isPlainObject(payload) && Array.isArray(payload.attributes);
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

  for (const correlation of correlations) {
    // A correlation's sessionId is only set when it's a confirmed member of
    // this exact session (see modelUsageCorrelation.ts) — anything else is
    // not this session's usage to total, even though the query was scoped
    // to this session id.
    if (correlation.sessionId !== sessionId) {
      continue;
    }

    const usageEvent = modelUsageEventsById.get(correlation.modelUsageEventId);
    const record: AttributedUsageRecord = {
      modelUsageEventId: correlation.modelUsageEventId,
      promptId: correlation.promptId,
      requestId: correlation.requestId,
      clientRequestId: correlation.clientRequestId,
      isModelCall: isApiRequestShaped(usageEvent?.payload),
      usage: extractModelUsage(usageEvent?.payload),
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
