/**
 * Pure detector for structurally duplicated work across subagents, built
 * on top of an attributed trajectory (trajectoryUsageAttribution.ts). This
 * is a separate module from trajectoryFeatures.ts (M8A) rather than an
 * extension of it, so that milestone's five detectors and their shared
 * aggregator are left completely untouched by this one.
 *
 * A handful of small, generic helpers (isPlainObject, str, canonicalize/
 * canonicalKey, groupBy) are intentionally duplicated from
 * trajectoryFeatures.ts rather than imported, for the same reason: nothing
 * in that file needs to change for this module to exist.
 *
 * Claude Code's hook payloads carry `agent_id` (and `agent_type`) directly
 * on PreToolUse/PostToolUse/PostToolUseFailure events fired inside a
 * subagent — a structural fact read straight off the raw event, the same
 * way modelUsageCorrelation.ts and trajectoryUsageAttribution.ts already
 * read prompt_id off raw events. A PostToolBatch event fires once for
 * whichever single agent context is executing it, so its own top-level
 * agent_id applies to every sub-call the batch reports. Tool calls with no
 * agent_id are main-thread work and take no part in this detector — it is
 * only about overlap ACROSS subagents, never main-thread-vs-subagent.
 */

import { DriftRawEvent, DriftStorage } from "./storage";
import { TrajectoryStepWithUsage, TrajectoryUsage, UsageSummary, AttributedUsageRecord, summarize } from "./trajectoryUsageAttribution";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

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

/** Claude Code's built-in tools that mutate filesystem/config state — the same fixed, named set trajectoryFeatures.ts uses for retry_without_state_change, re-declared here rather than imported. */
const STATE_MUTATING_TOOL_NAMES = new Set(["Write", "Edit"]);

export type SubagentOverlapKind = "same_tool_input" | "same_result_fingerprint" | "overlapping_modification_target";

/** One piece of evidence that two or more subagents did structurally duplicated work — never a verdict, and never inferring that the agents shared intent. */
export interface SubagentOverlapFinding {
  type: "subagent_overlap";
  sessionId: string;
  /** Every distinct subagent (by agent_id) involved, ascending. Always at least 2 — that's what makes this "overlap across subagents" rather than plain repetition. */
  agentIds: string[];
  /** Every original trajectory step this finding is grounded in, ascending, deduplicated. */
  stepIndexes: number[];
  evidence: Record<string, unknown>;
  /** Combined attributed usage across the involved steps' owning turns, when any carry usage. Absent, never fabricated as zero, when none do. */
  usage?: UsageSummary;
}

interface AgentToolCallObservation {
  stepIndexes: number[];
  primaryIndex: number;
  /** Position among sibling sub-calls sharing the same primaryIndex, i.e. within one PostToolBatch's toolCalls array. */
  subIndex: number;
  agentId: string;
  toolName: string | undefined;
  toolInput: Record<string, unknown> | undefined;
  hasResult: boolean;
  toolResponse: unknown;
}

function rawAgentId(rawEvent: DriftRawEvent | undefined): string | undefined {
  return isPlainObject(rawEvent?.payload) ? str(rawEvent.payload.agent_id) : undefined;
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

/** Only tool calls with a structurally confirmed agent_id are observed here — main-thread calls (no agent_id) are excluded, since this detector is only about cross-subagent overlap. */
function buildAgentObservations(
  steps: TrajectoryStepWithUsage[],
  rawEventsById: Map<number, DriftRawEvent>
): AgentToolCallObservation[] {
  const observations: AgentToolCallObservation[] = [];
  const consumed = new Set<number>();

  for (const step of steps) {
    if (consumed.has(step.index)) continue;

    if (step.event.type === "tool_invocation") {
      if (step.linkedStepIndex !== undefined) {
        const resultStep = steps[step.linkedStepIndex];
        consumed.add(resultStep.index);
        const agentId = rawAgentId(rawEventsById.get(step.event.rawEventId)) ?? rawAgentId(rawEventsById.get(resultStep.event.rawEventId));
        if (agentId === undefined) continue;

        const fields = toolCallFieldsFromData(resultStep.event.data);
        observations.push({
          stepIndexes: [step.index, resultStep.index].sort((a, b) => a - b),
          primaryIndex: step.index,
          subIndex: 0,
          agentId,
          toolName: fields.toolName,
          toolInput: fields.toolInput,
          hasResult: fields.hasResult,
          toolResponse: fields.toolResponse,
        });
      } else {
        const agentId = rawAgentId(rawEventsById.get(step.event.rawEventId));
        if (agentId === undefined) continue;

        const fields = toolCallFieldsFromData(step.event.data);
        observations.push({
          stepIndexes: [step.index],
          primaryIndex: step.index,
          subIndex: 0,
          agentId,
          toolName: fields.toolName,
          toolInput: fields.toolInput,
          hasResult: false,
          toolResponse: undefined,
        });
      }
      continue;
    }

    if (step.event.type === "tool_result") {
      const data = step.event.data;
      const agentId = rawAgentId(rawEventsById.get(step.event.rawEventId));
      if (agentId === undefined) continue;

      if (Array.isArray(data.toolCalls)) {
        data.toolCalls.forEach((call: unknown, subIndex: number) => {
          if (!isPlainObject(call)) return;
          const toolName = str(call.toolName);
          const toolInput = isPlainObject(call.toolInput) ? call.toolInput : undefined;
          const hasResult = Object.prototype.hasOwnProperty.call(call, "toolResponse");
          observations.push({
            stepIndexes: [step.index],
            primaryIndex: step.index,
            subIndex,
            agentId,
            toolName,
            toolInput,
            hasResult,
            toolResponse: hasResult ? call.toolResponse : undefined,
          });
        });
      } else {
        const fields = toolCallFieldsFromData(data);
        observations.push({
          stepIndexes: [step.index],
          primaryIndex: step.index,
          subIndex: 0,
          agentId,
          toolName: fields.toolName,
          toolInput: fields.toolInput,
          hasResult: fields.hasResult,
          toolResponse: fields.toolResponse,
        });
      }
    }
  }

  observations.sort((a, b) => a.primaryIndex - b.primaryIndex || a.subIndex - b.subIndex);
  return observations;
}

function allStepIndexes(observations: AgentToolCallObservation[]): number[] {
  const set = new Set<number>();
  for (const observation of observations) {
    for (const index of observation.stepIndexes) set.add(index);
  }
  return [...set].sort((a, b) => a - b);
}

function distinctAgentIds(observations: AgentToolCallObservation[]): string[] {
  return [...new Set(observations.map((o) => o.agentId))].sort();
}

/** Same "nearest preceding user_prompt step" rule trajectoryFeatures.ts uses, duplicated here for the same reason as the other small helpers above. */
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

function buildFinding(
  overlapKind: SubagentOverlapKind,
  sessionId: string,
  group: AgentToolCallObservation[],
  evidenceRest: Record<string, unknown>,
  steps: TrajectoryStepWithUsage[],
  ownerPromptIndex: number[]
): SubagentOverlapFinding {
  const stepIndexes = allStepIndexes(group);
  return {
    type: "subagent_overlap",
    sessionId,
    agentIds: distinctAgentIds(group),
    stepIndexes,
    evidence: { overlapKind, ...evidenceRest, occurrences: group.length },
    usage: usageForSteps(steps, ownerPromptIndex, stepIndexes),
  };
}

/** Same (toolName, toolInput) invoked by two or more distinct subagents — covers identical file reads, identical commands, and identical tool inputs generally. */
function detectSameToolInput(
  observations: AgentToolCallObservation[],
  sessionId: string,
  steps: TrajectoryStepWithUsage[],
  ownerPromptIndex: number[]
): SubagentOverlapFinding[] {
  const findings: SubagentOverlapFinding[] = [];
  const groups = groupBy(
    observations.filter((o) => o.toolInput !== undefined),
    (o) => `${o.toolName ?? ""} ${canonicalKey(o.toolInput)}`
  );

  for (const group of groups.values()) {
    if (distinctAgentIds(group).length < 2) continue;
    findings.push(
      buildFinding("same_tool_input", sessionId, group, { toolName: group[0].toolName, toolInput: group[0].toolInput }, steps, ownerPromptIndex)
    );
  }
  return findings;
}

/** Same (toolName, toolInput, toolResponse) produced by two or more distinct subagents — strictly stronger evidence than same_tool_input alone, since the outcome matched too. May co-occur with same_tool_input for the same steps; that overlap is expected, not deduplicated, since each is its own piece of evidence. */
function detectSameResultFingerprint(
  observations: AgentToolCallObservation[],
  sessionId: string,
  steps: TrajectoryStepWithUsage[],
  ownerPromptIndex: number[]
): SubagentOverlapFinding[] {
  const findings: SubagentOverlapFinding[] = [];
  const groups = groupBy(
    observations.filter((o) => o.hasResult),
    (o) => `${o.toolName ?? ""} ${canonicalKey(o.toolInput)} ${canonicalKey(o.toolResponse)}`
  );

  for (const group of groups.values()) {
    if (distinctAgentIds(group).length < 2) continue;
    findings.push(
      buildFinding(
        "same_result_fingerprint",
        sessionId,
        group,
        { toolName: group[0].toolName, toolInput: group[0].toolInput, result: group[0].toolResponse },
        steps,
        ownerPromptIndex
      )
    );
  }
  return findings;
}

/** Two or more distinct subagents targeting the same file_path with a Write/Edit — flagged even when the edits themselves differ, since the shared target is itself the overlap, regardless of content. */
function detectOverlappingModificationTarget(
  observations: AgentToolCallObservation[],
  sessionId: string,
  steps: TrajectoryStepWithUsage[],
  ownerPromptIndex: number[]
): SubagentOverlapFinding[] {
  const findings: SubagentOverlapFinding[] = [];
  const candidates = observations.filter(
    (o) => o.toolName !== undefined && STATE_MUTATING_TOOL_NAMES.has(o.toolName) && typeof o.toolInput?.file_path === "string"
  );
  const groups = groupBy(candidates, (o) => str(o.toolInput!.file_path));

  for (const group of groups.values()) {
    if (distinctAgentIds(group).length < 2) continue;
    findings.push(
      buildFinding("overlapping_modification_target", sessionId, group, { filePath: group[0].toolInput!.file_path }, steps, ownerPromptIndex)
    );
  }
  return findings;
}

/**
 * Detects structurally duplicated work across subagents in one session's
 * attributed trajectory. Pure and deterministic: the same trajectory usage
 * and storage contents always produce the same findings, in the same
 * order (sorted by earliest involved step, then overlap kind). Never
 * mutates `trajectoryUsage`, and reads storage only to recover each
 * step's own agent_id (trajectory steps don't carry it themselves).
 */
export function detectSubagentOverlap(trajectoryUsage: TrajectoryUsage, storage: DriftStorage): SubagentOverlapFinding[] {
  const { sessionId, steps } = trajectoryUsage;
  const sessionData = storage.getSession(sessionId);

  const rawEventsById = new Map<number, DriftRawEvent>();
  for (const rawEvent of sessionData?.events ?? []) {
    rawEventsById.set(rawEvent.id, rawEvent);
  }

  const observations = buildAgentObservations(steps, rawEventsById);
  const ownerPromptIndex = buildOwnerPromptIndex(steps);

  const findings = [
    ...detectSameToolInput(observations, sessionId, steps, ownerPromptIndex),
    ...detectSameResultFingerprint(observations, sessionId, steps, ownerPromptIndex),
    ...detectOverlappingModificationTarget(observations, sessionId, steps, ownerPromptIndex),
  ];

  findings.sort((a, b) => a.stepIndexes[0] - b.stepIndexes[0] || (a.evidence.overlapKind as string).localeCompare(b.evidence.overlapKind as string));
  return findings;
}
