/**
 * Correlates persisted Claude Code model-usage telemetry (M7A) with Drift's
 * own hook-based sessions. This is a pure read layer over already-stored
 * data — it never writes to model_usage_events, raw_events, or sessions,
 * and it never mutates anything it reads. Telemetry that can't be
 * correlated is not dropped by this module; it's simply returned with the
 * corresponding field left undefined, exactly like the fields
 * claudeTelemetryIngest.ts already leaves undefined for absent attributes.
 *
 * Only exact identifier matches are used. There is deliberately no
 * timestamp-proximity fallback: a correlation is either backed by a value
 * Claude itself reported (session.id, prompt.id, request_id,
 * client_request_id), or it isn't made at all.
 */

import { DriftStorage, DriftModelUsageEvent } from "./storage";
import { attributesToMap } from "./claudeTelemetryIngest";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * A log record's attributes live at `payload.attributes`. A metric object
 * (the verbatim form model_usage_events stores per M7A.1) has no top-level
 * `attributes` field at all — its data points do — so this naturally
 * yields {} for metrics, which is correct: request_id/client_request_id/
 * prompt.id are documented as event-only attributes and are never expected
 * on a metric.
 */
function payloadAttributes(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    return {};
  }
  return attributesToMap(payload.attributes);
}

/** One hook event's own prompt_id, when it has one — Drift's independent, hook-side record of "prompts we actually saw" for a session. */
function hookPromptId(rawHookPayload: unknown): string | undefined {
  return isPlainObject(rawHookPayload) ? str(rawHookPayload.prompt_id) : undefined;
}

export interface ModelUsageCorrelation {
  /** The model_usage_events row this correlation describes. */
  modelUsageEventId: number;
  /** Set only when the telemetry's session is a real Drift session with at least one hook-derived event — not merely a row created by telemetry ingestion itself. */
  sessionId: string | undefined;
  /** Set only when the telemetry's prompt.id matches a prompt_id Drift actually observed via a hook event in that same session. */
  promptId: string | undefined;
  /** Propagated verbatim when present. Drift has no independent hook-side record of API request ids to validate these against, so "present" is the entire criterion. */
  requestId: string | undefined;
  clientRequestId: string | undefined;
}

/**
 * Correlates one already-persisted model-usage telemetry event. Pure and
 * deterministic: the same event and storage contents always produce the
 * same result, and nothing here is inferred from timing.
 */
export function correlateModelUsageEvent(
  event: DriftModelUsageEvent,
  storage: DriftStorage
): ModelUsageCorrelation {
  const attributes = payloadAttributes(event.payload);
  const requestId = str(attributes["request_id"]);
  const clientRequestId = str(attributes["client_request_id"]);

  const notCorrelated: ModelUsageCorrelation = {
    modelUsageEventId: event.id,
    sessionId: undefined,
    promptId: undefined,
    requestId,
    clientRequestId,
  };

  if (!event.sessionId) {
    return notCorrelated;
  }

  const sessionData = storage.getSession(event.sessionId);
  if (!sessionData || sessionData.events.length === 0) {
    // A session row can exist purely because telemetry ingestion called
    // ensureSession() for it — that's not a "Drift hook session".
    return notCorrelated;
  }

  const telemetryPromptId = str(attributes["prompt.id"]);
  let promptId: string | undefined;
  if (telemetryPromptId) {
    const knownPromptIds = new Set(
      sessionData.events.map((e) => hookPromptId(e.payload)).filter((id): id is string => id !== undefined)
    );
    if (knownPromptIds.has(telemetryPromptId)) {
      promptId = telemetryPromptId;
    }
  }

  return { modelUsageEventId: event.id, sessionId: event.sessionId, promptId, requestId, clientRequestId };
}

/**
 * Correlates every model-usage telemetry event stored for one session, in
 * the same order storage.getModelUsageEvents returns them. Multiple calls
 * sharing one prompt are never merged — each stays its own entry.
 */
export function correlateModelUsageForSession(sessionId: string, storage: DriftStorage): ModelUsageCorrelation[] {
  return storage.getModelUsageEvents(sessionId).map((event) => correlateModelUsageEvent(event, storage));
}
