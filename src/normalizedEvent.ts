import { DriftRawEvent } from "./storage";
import { normalizeClaudeEvent } from "./claudeEventMapper";

/**
 * Small, fixed set of provider-independent event categories. Later
 * providers map their own event names onto this same set rather than
 * extending it with provider-specific variants.
 */
export type NormalizedEventType =
  | "session_start"
  | "session_end"
  | "user_prompt"
  | "tool_invocation"
  | "tool_result"
  | "subagent_lifecycle"
  | "task_lifecycle"
  | "compaction"
  | "generic";

/**
 * Provider-independent view of a captured event. The raw hook JSON in
 * storage remains the source of truth; this is a small, stable read model
 * derived from it. `rawEventId` ties a normalized event back to the exact
 * `raw_events` row it was derived from.
 */
export interface NormalizedEvent {
  sessionId: string;
  type: NormalizedEventType;
  source: "claude";
  timestamp: number;
  hookEventName: string;
  data: Record<string, unknown>;
  rawEventId: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derives a NormalizedEvent from an already-persisted raw event. Pure and
 * deterministic: given the same DriftRawEvent, always returns the same
 * result. Never throws, even for a hook_event_name it doesn't recognize.
 */
export function normalizeRawEvent(rawEvent: DriftRawEvent): NormalizedEvent {
  const payload = isRecord(rawEvent.payload) ? rawEvent.payload : {};
  const hookEventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "unknown";

  const { type, data } = normalizeClaudeEvent(hookEventName, payload);

  return {
    sessionId: rawEvent.sessionId,
    type,
    source: "claude",
    timestamp: rawEvent.timestamp,
    hookEventName,
    data,
    rawEventId: rawEvent.id,
  };
}
