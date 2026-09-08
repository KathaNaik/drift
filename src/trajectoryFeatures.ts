/**
 * Pure, deterministic feature extraction over an attributed trajectory
 * (trajectoryUsageAttribution.ts). Every feature here is evidence of an
 * OBJECTIVELY observable pattern — identical inputs, identical outputs,
 * identical failures — recovered only from data Claude's own hooks already
 * reported. Nothing here classifies a finding as "waste" or assigns it a
 * confidence score: that judgment is explicitly out of scope for this
 * milestone, and nothing here uses an LLM or infers what the agent meant to
 * do. nothing here mutates the trajectory it reads.
 *
 * A tool call's observable identity is (toolName, toolInput); its result,
 * when one exists, is toolResponse. Two hook shapes carry this: a linked
 * PreToolUse/PostToolUse(Failure) pair (toolInput lives on the invocation
 * step, toolResponse on the result step), and a PostToolBatch step, whose
 * `data.toolCalls[]` already carries both per sub-call in one step. Failure
 * itself is read structurally — hookEventName === "PostToolUseFailure" —
 * never guessed from a tool response's shape, since that would mean
 * inferring semantic meaning content this module deliberately avoids. A
 * PostToolBatch sub-call therefore has no objective failure signal (there
 * is no "PostToolBatchFailure" hook event) and is excluded from the two
 * failure-based detectors, though it still participates in the others.
 */

import { TrajectoryStepWithUsage, TrajectoryUsage, UsageSummary, AttributedUsageRecord, summarize } from "./trajectoryUsageAttribution";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Key-order-independent JSON form, so two structurally equal objects always compare equal regardless of how their keys happen to be ordered. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalKey(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function groupBy<T>(items: T[], keyFn: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (key === undefined) continue;
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

export type TrajectoryFeatureType =
  | "unchanged_file_reread"
  | "repeated_command"
  | "repeated_failure"
  | "retry_without_state_change"
  | "repeated_context";

/** One piece of evidence — never a verdict. Fields beyond type/sessionId/stepIndexes/evidence vary only by what's objectively true of the underlying calls. */
export interface TrajectoryFeatureFinding {
  type: TrajectoryFeatureType;
  sessionId: string;
  /** Every original trajectory step this finding is grounded in, ascending, deduplicated. */
  stepIndexes: number[];
  evidence: Record<string, unknown>;
  /** Combined attributed usage across the involved steps, when any of them carry usage (see trajectoryUsageAttribution.ts). Absent, never fabricated as zero, when none do. */
  usage?: UsageSummary;
}

/** One tool call recovered from the trajectory, merging its invocation and result sides when both exist. */
interface ToolCallObservation {
  stepIndexes: number[];
  /** The step used to order this observation relative to others — the invocation step when one exists, otherwise the result/batch step. */
  primaryIndex: number;
  /** Position among sibling sub-calls sharing the same primaryIndex — i.e. within one PostToolBatch's `toolCalls` array, in the order Claude itself reported them (true execution order). Always 0 outside a batch, where primaryIndex alone is already unique. */
  subIndex: number;
  toolName: string | undefined;
  toolInput: Record<string, unknown> | undefined;
  hasResult: boolean;
  toolResponse: unknown;
  /** True only when structurally confirmed via hookEventName === "PostToolUseFailure" — never inferred from response content. Always false for a PostToolBatch sub-call, which has no per-sub-call failure signal at all (see module doc). */
  failed: boolean;
}

/** Full execution order, including position within a shared PostToolBatch step. */
function compareOrder(a: ToolCallObservation, b: ToolCallObservation): number {
  return a.primaryIndex - b.primaryIndex || a.subIndex - b.subIndex;
}

function toolCallFieldsFromData(data: Record<string, unknown>): {
  toolName: string | undefined;
  toolInput: Record<string, unknown> | undefined;
  hasResult: boolean;
  toolResponse: unknown;
} {
  const toolName = str(data.toolName);
  const toolInput = isPlainObject(data.toolInput) ? data.toolInput : undefined;
  const hasResult = Object.prototype.hasOwnProperty.call(data, "toolResponse");
  return { toolName, toolInput, hasResult, toolResponse: hasResult ? data.toolResponse : undefined };
}

function buildObservations(steps: TrajectoryStepWithUsage[]): ToolCallObservation[] {
  const observations: ToolCallObservation[] = [];
  const consumed = new Set<number>();

  for (const step of steps) {
    if (consumed.has(step.index)) continue;

    if (step.event.type === "tool_invocation") {
      if (step.linkedStepIndex !== undefined) {
        const resultStep = steps[step.linkedStepIndex];
        consumed.add(resultStep.index);
        const fields = toolCallFieldsFromData(resultStep.event.data);
        observations.push({
          stepIndexes: [step.index, resultStep.index].sort((a, b) => a - b),
          primaryIndex: step.index,
          subIndex: 0,
          toolName: fields.toolName,
          toolInput: fields.toolInput,
          hasResult: fields.hasResult,
          toolResponse: fields.toolResponse,
          failed: resultStep.event.hookEventName === "PostToolUseFailure",
        });
      } else {
        const fields = toolCallFieldsFromData(step.event.data);
        observations.push({
          stepIndexes: [step.index],
          primaryIndex: step.index,
          subIndex: 0,
          toolName: fields.toolName,
          toolInput: fields.toolInput,
          hasResult: false,
          toolResponse: undefined,
          failed: false,
        });
      }
      continue;
    }

    if (step.event.type === "tool_result") {
      const data = step.event.data;
      if (Array.isArray(data.toolCalls)) {
        data.toolCalls.forEach((call: unknown, subIndex: number) => {
          if (!isPlainObject(call)) return;
          const toolName = str(call.toolName);
          const toolInput = isPlainObject(call.toolInput) ? call.toolInput : undefined;
          const hasResult = Object.prototype.hasOwnProperty.call(call, "toolResponse");
          observations.push({
            stepIndexes: [step.index],
            primaryIndex: step.index,
            // The batch's `toolCalls` array order is Claude's own reported
            // execution order for these sub-calls — using it as-is is
            // reading given data, not inferring anything about it.
            subIndex,
            toolName,
            toolInput,
            hasResult,
            toolResponse: hasResult ? call.toolResponse : undefined,
            // No per-sub-call failure signal exists for a batch (see module doc).
            failed: false,
          });
        });
      } else {
        const fields = toolCallFieldsFromData(data);
        observations.push({
          stepIndexes: [step.index],
          primaryIndex: step.index,
          subIndex: 0,
          toolName: fields.toolName,
          toolInput: fields.toolInput,
          hasResult: fields.hasResult,
          toolResponse: fields.toolResponse,
          failed: step.event.hookEventName === "PostToolUseFailure",
        });
      }
    }
  }

  observations.sort(compareOrder);
  return observations;
}

function allStepIndexes(observations: ToolCallObservation[]): number[] {
  const set = new Set<number>();
  for (const observation of observations) {
    for (const index of observation.stepIndexes) set.add(index);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Per M7C, usage is only ever attached to a "user_prompt" step — never to
 * the tool_invocation/tool_result steps a feature finding actually points
 * at. So "usage for the involved steps" has to be resolved through each
 * step's own turn: the nearest preceding user_prompt step in trajectory
 * order (a UserPromptSubmit always starts a new turn, and everything after
 * it belongs to that turn until the next one). This is a purely structural,
 * position-based rule — it reads no raw data and infers nothing about what
 * any step means — so it stays consistent with a step's real owning turn
 * without this module needing storage access.
 */
function buildOwnerPromptIndex(steps: TrajectoryStepWithUsage[]): number[] {
  const owner: number[] = [];
  let current = -1;
  for (const step of steps) {
    if (step.event.type === "user_prompt") current = step.index;
    owner.push(current);
  }
  return owner;
}

function usageForSteps(steps: TrajectoryStepWithUsage[], ownerPromptIndex: number[], stepIndexes: number[]): UsageSummary | undefined {
  const ownerIndexes = new Set<number>();
  for (const index of stepIndexes) {
    const owner = ownerPromptIndex[index];
    if (owner !== -1) ownerIndexes.add(owner);
  }

  const records: AttributedUsageRecord[] = [];
  for (const ownerIndex of ownerIndexes) {
    const usage = steps[ownerIndex]?.usage;
    if (usage) records.push(...usage.records);
  }
  return records.length > 0 ? summarize(records) : undefined;
}

/**
 * Same file, read again, with byte-identical content between this read and
 * its own immediately preceding read of that same file — never compared
 * against any earlier, non-adjacent read, so a read that changed and later
 * reverted is not mistaken for "nothing changed between these two reads."
 */
function detectUnchangedFileReread(
  observations: ToolCallObservation[],
  sessionId: string,
  steps: TrajectoryStepWithUsage[],
  ownerPromptIndex: number[]
): TrajectoryFeatureFinding[] {
  const findings: TrajectoryFeatureFinding[] = [];
  const byFile = groupBy(
    observations.filter((o) => o.toolName === "Read" && o.hasResult && typeof o.toolInput?.file_path === "string"),
    (o) => str(o.toolInput!.file_path)
  );

  for (const [filePath, reads] of byFile) {
    for (let i = 1; i < reads.length; i++) {
      const previous = reads[i - 1];
      const current = reads[i];
      if (canonicalKey(previous.toolResponse) !== canonicalKey(current.toolResponse)) continue;

      const stepIndexes = allStepIndexes([previous, current]);
      findings.push({
        type: "unchanged_file_reread",
        sessionId,
        stepIndexes,
        evidence: { toolName: "Read", filePath },
        usage: usageForSteps(steps, ownerPromptIndex, stepIndexes),
      });
    }
  }
  return findings;
}

/** The same normalized shell command, executed again anywhere later in the trajectory — no adjacency required. */
function detectRepeatedCommand(
  observations: ToolCallObservation[],
  sessionId: string,
  steps: TrajectoryStepWithUsage[],
  ownerPromptIndex: number[]
): TrajectoryFeatureFinding[] {
  const findings: TrajectoryFeatureFinding[] = [];
  const candidates = observations.filter((o) => typeof o.toolInput?.command === "string");
  const groups = groupBy(candidates, (o) => `${o.toolName ?? ""} ${normalizeCommand(o.toolInput!.command as string)}`);

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const stepIndexes = allStepIndexes(group);
    findings.push({
      type: "repeated_command",
      sessionId,
      stepIndexes,
      evidence: {
        toolName: group[0].toolName,
        normalizedCommand: normalizeCommand(group[0].toolInput!.command as string),
        occurrences: group.length,
      },
      usage: usageForSteps(steps, ownerPromptIndex, stepIndexes),
    });
  }
  return findings;
}

/** The same tool + input combination structurally failed (hookEventName === "PostToolUseFailure") more than once, with byte-identical failure output each time. */
function detectRepeatedFailure(
  observations: ToolCallObservation[],
  sessionId: string,
  steps: TrajectoryStepWithUsage[],
  ownerPromptIndex: number[]
): TrajectoryFeatureFinding[] {
  const findings: TrajectoryFeatureFinding[] = [];
  const failed = observations.filter((o) => o.failed && o.hasResult);
  const groups = groupBy(
    failed,
    (o) => `${o.toolName ?? ""} ${canonicalKey(o.toolInput)} ${canonicalKey(o.toolResponse)}`
  );

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const stepIndexes = allStepIndexes(group);
    findings.push({
      type: "repeated_failure",
      sessionId,
      stepIndexes,
      evidence: {
        toolName: group[0].toolName,
        toolInput: group[0].toolInput,
        failureResponse: group[0].toolResponse,
        occurrences: group.length,
      },
      usage: usageForSteps(steps, ownerPromptIndex, stepIndexes),
    });
  }
  return findings;
}

/**
 * Claude Code's own built-in tools that mutate filesystem/config state, as
 * named directly in this milestone's own examples. This is a fixed,
 * publicly-documented set of tool identities -- the same kind of structural
 * fact as treating hookEventName === "PostToolUseFailure" as "this failed"
 * -- not an inference about what any particular call was for. Bash is
 * deliberately excluded: an arbitrary shell command may or may not mutate
 * state, and telling those cases apart would mean reading the command's
 * semantics, which this module does not do.
 */
const STATE_MUTATING_TOOL_NAMES = new Set(["Write", "Edit"]);

/** An observation counts as a relevant state mutation only if it's structurally confirmed both mutating (by tool identity) and not itself a failure (a failed Write/Edit didn't actually change anything) -- never inferred from response content. */
function isRelevantStateMutation(observation: ToolCallObservation): boolean {
  return observation.toolName !== undefined && STATE_MUTATING_TOOL_NAMES.has(observation.toolName) && !observation.failed;
}

/**
 * A failed call, then the exact same tool + input attempted again with no
 * relevant state mutation (see isRelevantStateMutation) occurring between
 * them, in true execution order -- which, inside a PostToolBatch, follows
 * that batch's own toolCalls array order rather than trajectory step
 * index, since multiple sub-calls of one batch share a single step (see
 * subIndex). A read-only or unrelated intervening call -- batched or not
 * -- does not suppress this on its own: only a structurally-confirmed
 * Write/Edit that itself did not fail counts, since judging any other
 * call's relevance would mean inferring intent this module does not do.
 */
function detectRetryWithoutStateChange(
  observations: ToolCallObservation[],
  sessionId: string,
  steps: TrajectoryStepWithUsage[],
  ownerPromptIndex: number[]
): TrajectoryFeatureFinding[] {
  const findings: TrajectoryFeatureFinding[] = [];
  const byIdentity = groupBy(
    observations.filter((o) => o.toolInput !== undefined),
    (o) => `${o.toolName ?? ""} ${canonicalKey(o.toolInput)}`
  );

  for (const group of byIdentity.values()) {
    for (let i = 1; i < group.length; i++) {
      const previous = group[i - 1];
      const current = group[i];
      if (!previous.failed) continue;

      const relevantStateMutationHappened = observations.some(
        (o) =>
          o !== previous &&
          o !== current &&
          isRelevantStateMutation(o) &&
          compareOrder(o, previous) > 0 &&
          compareOrder(o, current) < 0
      );
      if (relevantStateMutationHappened) continue;

      const stepIndexes = allStepIndexes([previous, current]);
      findings.push({
        type: "retry_without_state_change",
        sessionId,
        stepIndexes,
        evidence: { toolName: current.toolName, toolInput: current.toolInput },
        usage: usageForSteps(steps, ownerPromptIndex, stepIndexes),
      });
    }
  }
  return findings;
}

/** The identical (tool, input, result) triple consumed more than once anywhere in the trajectory. Excludes the Read tool, which unchanged_file_reread already covers on its own terms. */
function detectRepeatedContext(
  observations: ToolCallObservation[],
  sessionId: string,
  steps: TrajectoryStepWithUsage[],
  ownerPromptIndex: number[]
): TrajectoryFeatureFinding[] {
  const findings: TrajectoryFeatureFinding[] = [];
  const candidates = observations.filter((o) => o.hasResult && o.toolName !== "Read");
  const groups = groupBy(
    candidates,
    (o) => `${o.toolName ?? ""} ${canonicalKey(o.toolInput)} ${canonicalKey(o.toolResponse)}`
  );

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const stepIndexes = allStepIndexes(group);
    findings.push({
      type: "repeated_context",
      sessionId,
      stepIndexes,
      evidence: { toolName: group[0].toolName, toolInput: group[0].toolInput, result: group[0].toolResponse, occurrences: group.length },
      usage: usageForSteps(steps, ownerPromptIndex, stepIndexes),
    });
  }
  return findings;
}

/**
 * Extracts every objective feature finding from an attributed trajectory.
 * Pure and deterministic: the same trajectory usage always produces the
 * same findings, in the same order (sorted by each finding's earliest
 * involved step, then by type). Never mutates `trajectoryUsage`.
 */
export function extractTrajectoryFeatures(trajectoryUsage: TrajectoryUsage): TrajectoryFeatureFinding[] {
  const observations = buildObservations(trajectoryUsage.steps);
  const { sessionId, steps } = trajectoryUsage;
  const ownerPromptIndex = buildOwnerPromptIndex(steps);

  const findings = [
    ...detectUnchangedFileReread(observations, sessionId, steps, ownerPromptIndex),
    ...detectRepeatedCommand(observations, sessionId, steps, ownerPromptIndex),
    ...detectRepeatedFailure(observations, sessionId, steps, ownerPromptIndex),
    ...detectRetryWithoutStateChange(observations, sessionId, steps, ownerPromptIndex),
    ...detectRepeatedContext(observations, sessionId, steps, ownerPromptIndex),
  ];

  findings.sort((a, b) => a.stepIndexes[0] - b.stepIndexes[0] || a.type.localeCompare(b.type));
  return findings;
}
