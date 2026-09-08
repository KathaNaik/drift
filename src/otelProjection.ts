import { Trajectory, TrajectoryStep } from "./trajectory";

/**
 * A point-in-time annotation on a span, analogous to an OTel span event.
 * Used for trajectory steps that aren't tool calls (session lifecycle,
 * prompts, subagent/task/compaction, and unknown/generic events) — these
 * are occurrences, not calls with a duration, so they're attached to the
 * root span rather than becoming spans of their own.
 */
export interface OtelSpanEvent {
  name: string;
  timestampUnixMs: number;
  attributes: Record<string, unknown>;
}

/**
 * A deterministic, in-memory projection of one span. This is a data shape
 * only — no OTel SDK, no exporter, no wire format. `spanId`/`traceId` are
 * derived deterministically from the trajectory, not generated at random.
 */
export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixMs: number;
  endTimeUnixMs: number;
  attributes: Record<string, unknown>;
  events: OtelSpanEvent[];
}

/** One session's trajectory projected into one trace. `spans[0]` is the root span. */
export interface OtelTrace {
  traceId: string;
  spans: OtelSpan[];
}

const ROOT_SPAN_ID = "span-root";

function toolSpanId(step: TrajectoryStep): string {
  return `span-${step.index}`;
}

function toolNameOf(event: TrajectoryStep["event"] | undefined): string | undefined {
  return event && typeof event.data.toolName === "string" ? event.data.toolName : undefined;
}

function buildToolSpan(traceId: string, step: TrajectoryStep, linkedStep: TrajectoryStep | undefined): OtelSpan {
  const invocationEvent = step.event.type === "tool_invocation" ? step.event : linkedStep?.event;
  const resultEvent = step.event.type === "tool_result" ? step.event : linkedStep?.event;

  const startTimeUnixMs = invocationEvent?.timestamp ?? resultEvent!.timestamp;
  const endTimeUnixMs = resultEvent?.timestamp ?? invocationEvent!.timestamp;

  return {
    traceId,
    spanId: toolSpanId(step),
    parentSpanId: ROOT_SPAN_ID,
    name: toolNameOf(invocationEvent) ?? toolNameOf(resultEvent) ?? "tool_call",
    startTimeUnixMs,
    endTimeUnixMs,
    attributes: {
      toolUseId: step.toolUseId,
      incomplete: invocationEvent === undefined || resultEvent === undefined,
    },
    events: [],
  };
}

function buildSpanEvent(step: TrajectoryStep): OtelSpanEvent {
  return {
    name: step.event.hookEventName,
    timestampUnixMs: step.event.timestamp,
    attributes: { normalizedType: step.event.type, ...step.event.data },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A tool_result step with no singular toolUseId of its own (PostToolBatch)
 * reports several tool calls under data.toolCalls. Trajectory semantics are
 * unchanged — this step is still a plain root-span event — but each real
 * tool call it reports still becomes its own child span, using whatever
 * toolUseId/name/timestamp that call's own entry carries. All entries share
 * the batch event's single timestamp: Drift has no finer-grained timing for
 * calls reported this way, so none is fabricated.
 */
function buildBatchChildSpans(traceId: string, step: TrajectoryStep): OtelSpan[] {
  const toolCalls = step.event.data.toolCalls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.map((call, entryIndex) => {
    const entry = isPlainObject(call) ? call : {};
    const toolUseId = typeof entry.toolUseId === "string" ? entry.toolUseId : undefined;
    const toolName = typeof entry.toolName === "string" ? entry.toolName : undefined;

    return {
      traceId,
      spanId: `${toolSpanId(step)}-${entryIndex}`,
      parentSpanId: ROOT_SPAN_ID,
      name: toolName ?? "tool_call",
      startTimeUnixMs: step.event.timestamp,
      endTimeUnixMs: step.event.timestamp,
      attributes: {
        toolUseId,
        incomplete: !("toolResponse" in entry),
      },
      events: [],
    };
  });
}

/**
 * Projects one accepted M5B trajectory into one OTel-shaped trace: one
 * trace per session, one span per tool call (paired invocation/result, or
 * whichever side is present for an incomplete call), one additional child
 * span per real tool call reported inside a PostToolBatch event, and every
 * trajectory step (including the batch event itself) preserved as a span
 * event on the root span so nothing — including unknown/generic events —
 * is dropped.
 *
 * Pure and deterministic: span/trace ids are derived from the trajectory's
 * own session id and step indices, never randomly generated, and neither
 * the trajectory nor its events are modified.
 */
export function buildOtelTrace(trajectory: Trajectory): OtelTrace {
  const traceId = trajectory.sessionId;
  const spans: OtelSpan[] = [];
  const rootEvents: OtelSpanEvent[] = [];
  const timestamps: number[] = [];

  for (const step of trajectory.steps) {
    timestamps.push(step.event.timestamp);

    if (step.toolUseId === undefined) {
      rootEvents.push(buildSpanEvent(step));
      spans.push(...buildBatchChildSpans(traceId, step));
      continue;
    }

    const isResultAlreadyCoveredByItsInvocation = step.event.type === "tool_result" && step.linkedStepIndex !== undefined;
    if (isResultAlreadyCoveredByItsInvocation) {
      continue;
    }

    const linkedStep = step.linkedStepIndex !== undefined ? trajectory.steps[step.linkedStepIndex] : undefined;
    spans.push(buildToolSpan(traceId, step, linkedStep));
  }

  const rootSpan: OtelSpan = {
    traceId,
    spanId: ROOT_SPAN_ID,
    name: "session",
    startTimeUnixMs: timestamps.length > 0 ? Math.min(...timestamps) : 0,
    endTimeUnixMs: timestamps.length > 0 ? Math.max(...timestamps) : 0,
    attributes: { sessionId: trajectory.sessionId },
    events: rootEvents,
  };

  return { traceId, spans: [rootSpan, ...spans] };
}
