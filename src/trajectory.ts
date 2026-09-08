import { NormalizedEvent } from "./normalizedEvent";

/**
 * One step in a reconstructed trajectory, corresponding 1:1 with a single
 * NormalizedEvent from the input, at the same position. Grouping a tool
 * invocation with its result is represented as a cross-reference between
 * two steps (`toolUseId` + `linkedStepIndex`), never by moving, merging, or
 * dropping either event.
 */
export interface TrajectoryStep {
  /** Position of this step in `Trajectory.steps` (mirrors input order). */
  index: number;
  event: NormalizedEvent;
  /** Set when this event carries a stable tool use id (invocation or result). */
  toolUseId?: string;
  /** Index of the paired invocation/result step, if one has been matched. */
  linkedStepIndex?: number;
}

/** One session's events, reconstructed into an ordered sequence of steps. */
export interface Trajectory {
  sessionId: string;
  steps: TrajectoryStep[];
}

function toolUseIdOf(event: NormalizedEvent): string | undefined {
  return typeof event.data.toolUseId === "string" ? event.data.toolUseId : undefined;
}

/**
 * Reconstructs one session's trajectory from its normalized events. The
 * output has exactly one step per session-matching input event, in exactly
 * the order given — grouping never reorders or collapses events, it only
 * links a tool_result step back to its tool_invocation step (or vice versa)
 * by stable tool use id when both are present.
 *
 * Only events whose `sessionId` matches `sessionId` are considered, so
 * passing a mixed-session array can never leak another session's steps into
 * the result. Pure and deterministic: the same input always produces the
 * same output, and neither the input events nor their `data` are modified.
 */
export function buildTrajectory(sessionId: string, events: NormalizedEvent[]): Trajectory {
  const steps: TrajectoryStep[] = [];
  const pendingToolCallIndex = new Map<string, number>();

  for (const event of events) {
    if (event.sessionId !== sessionId) {
      continue;
    }

    const toolUseId = toolUseIdOf(event);
    const stepIndex = steps.length;

    if (event.type === "tool_invocation" && toolUseId !== undefined) {
      steps.push({ index: stepIndex, event, toolUseId });
      pendingToolCallIndex.set(toolUseId, stepIndex);
      continue;
    }

    if (event.type === "tool_result" && toolUseId !== undefined) {
      const invocationIndex = pendingToolCallIndex.get(toolUseId);
      const invocationStep = invocationIndex !== undefined ? steps[invocationIndex] : undefined;

      if (invocationStep !== undefined && invocationStep.linkedStepIndex === undefined) {
        steps.push({ index: stepIndex, event, toolUseId, linkedStepIndex: invocationIndex });
        steps[invocationIndex!] = { ...invocationStep, linkedStepIndex: stepIndex };
        pendingToolCallIndex.delete(toolUseId);
      } else {
        // No open invocation waiting for this id: an orphan result, kept as
        // its own unlinked step rather than dropped.
        steps.push({ index: stepIndex, event, toolUseId });
      }
      continue;
    }

    steps.push({ index: stepIndex, event });
  }

  return { sessionId, steps };
}
