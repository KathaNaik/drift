import type { NormalizedEventType } from "./normalizedEvent";

/**
 * Claude-specific field extraction, kept separate from the provider-
 * independent NormalizedEvent type (src/normalizedEvent.ts) so that type
 * never needs to know Claude's field names.
 *
 * Field extraction is deliberately conservative: only fields directly
 * confirmed present in real Claude Code hook payloads (or documented in
 * Claude's own hook schema) are read. Unconfirmed fields are never
 * fabricated; anything not promoted here is still available via the raw
 * event a NormalizedEvent references.
 */

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fields observed across most/all Claude hook payloads. */
function extractCommonContext(payload: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const cwd = str(payload.cwd);
  if (cwd !== undefined) data.cwd = cwd;
  const transcriptPath = str(payload.transcript_path);
  if (transcriptPath !== undefined) data.transcriptPath = transcriptPath;
  const permissionMode = str(payload.permission_mode);
  if (permissionMode !== undefined) data.permissionMode = permissionMode;
  return data;
}

function normalizeUserPromptSubmit(payload: Record<string, unknown>): Record<string, unknown> {
  const data = extractCommonContext(payload);
  const prompt = str(payload.prompt);
  if (prompt !== undefined) data.prompt = prompt;
  return data;
}

function normalizeToolInvocation(payload: Record<string, unknown>): Record<string, unknown> {
  const data = extractCommonContext(payload);
  const toolName = str(payload.tool_name);
  if (toolName !== undefined) data.toolName = toolName;
  const toolInput = record(payload.tool_input);
  if (toolInput !== undefined) data.toolInput = toolInput;
  const toolUseId = str(payload.tool_use_id);
  if (toolUseId !== undefined) data.toolUseId = toolUseId;
  return data;
}

function extractToolCallFields(call: Record<string, unknown>): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  const toolName = str(call.tool_name);
  if (toolName !== undefined) entry.toolName = toolName;
  const toolInput = record(call.tool_input);
  if (toolInput !== undefined) entry.toolInput = toolInput;
  const toolUseId = str(call.tool_use_id);
  if (toolUseId !== undefined) entry.toolUseId = toolUseId;
  if ("tool_response" in call) entry.toolResponse = call.tool_response;
  return entry;
}

function normalizeToolResult(payload: Record<string, unknown>): Record<string, unknown> {
  const data = extractCommonContext(payload);

  // PostToolBatch reports several tool calls in one event.
  if (Array.isArray(payload.tool_calls)) {
    data.toolCalls = payload.tool_calls.map((call) => extractToolCallFields(record(call) ?? {}));
    return data;
  }

  // PostToolUse / PostToolUseFailure report a single tool call.
  Object.assign(data, extractToolCallFields(payload));
  if (typeof payload.duration_ms === "number") data.durationMs = payload.duration_ms;
  return data;
}

function normalizeSubagentLifecycle(payload: Record<string, unknown>): Record<string, unknown> {
  const data = extractCommonContext(payload);
  const agentId = str(payload.agent_id);
  if (agentId !== undefined) data.agentId = agentId;
  const agentType = str(payload.agent_type);
  if (agentType !== undefined) data.agentType = agentType;
  const lastAssistantMessage = str(payload.last_assistant_message);
  if (lastAssistantMessage !== undefined) data.lastAssistantMessage = lastAssistantMessage;
  return data;
}

function normalizeSessionEnd(payload: Record<string, unknown>): Record<string, unknown> {
  const data = extractCommonContext(payload);
  const reason = str(payload.reason);
  if (reason !== undefined) data.reason = reason;
  return data;
}

interface EventMapping {
  type: NormalizedEventType;
  extract: (payload: Record<string, unknown>) => Record<string, unknown>;
}

// Covers every event in hookInstaller.ts's DRIFT_HOOK_EVENTS. Events with no
// confirmed Claude-specific fields beyond common context (SessionStart,
// TaskCreated, TaskCompleted, PreCompact, PostCompact) only extract that.
const CLAUDE_EVENT_MAP: Record<string, EventMapping> = {
  SessionStart: { type: "session_start", extract: extractCommonContext },
  SessionEnd: { type: "session_end", extract: normalizeSessionEnd },
  UserPromptSubmit: { type: "user_prompt", extract: normalizeUserPromptSubmit },
  PreToolUse: { type: "tool_invocation", extract: normalizeToolInvocation },
  PostToolUse: { type: "tool_result", extract: normalizeToolResult },
  PostToolUseFailure: { type: "tool_result", extract: normalizeToolResult },
  PostToolBatch: { type: "tool_result", extract: normalizeToolResult },
  SubagentStart: { type: "subagent_lifecycle", extract: normalizeSubagentLifecycle },
  SubagentStop: { type: "subagent_lifecycle", extract: normalizeSubagentLifecycle },
  TaskCreated: { type: "task_lifecycle", extract: extractCommonContext },
  TaskCompleted: { type: "task_lifecycle", extract: extractCommonContext },
  PreCompact: { type: "compaction", extract: extractCommonContext },
  PostCompact: { type: "compaction", extract: extractCommonContext },
};

/**
 * Maps a Claude hook_event_name and its raw payload to a normalized type and
 * data. Never throws: a hook_event_name outside CLAUDE_EVENT_MAP (including
 * anything Claude introduces in the future) produces a "generic" event
 * whose data is the raw payload verbatim, so it stays inspectable.
 */
export function normalizeClaudeEvent(
  hookEventName: string,
  payload: Record<string, unknown>
): { type: NormalizedEventType; data: Record<string, unknown> } {
  const mapping = CLAUDE_EVENT_MAP[hookEventName];
  if (!mapping) {
    return { type: "generic", data: { ...payload } };
  }
  return { type: mapping.type, data: mapping.extract(payload) };
}
