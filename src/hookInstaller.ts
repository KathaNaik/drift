import * as fs from "fs";
import * as path from "path";

const HTTP_TRANSPORT_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

// Claude Code does not support the "http" hook transport for these events
// (SessionStart), or does not honor an http hook's JSON response the way it
// honors a command hook's stdout (UserPromptSubmit -- confirmed live against
// real Claude Code CLI in M12B-LIVE: an http UserPromptSubmit hook's
// hookSpecificOutput.additionalContext was never consumed, despite matching
// Claude Code's own documented schema). Both are delivered via the command
// bridge (src/hookBridge.ts) instead.
const COMMAND_TRANSPORT_EVENTS = ["SessionStart", "UserPromptSubmit"] as const;

export const DRIFT_HOOK_EVENTS = [...HTTP_TRANSPORT_EVENTS, ...COMMAND_TRANSPORT_EVENTS] as const;

export type DriftHookEvent = (typeof DRIFT_HOOK_EVENTS)[number];

interface HookHandler {
  type: string;
  url?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
  [key: string]: unknown;
}

type HooksConfig = Record<string, HookMatcherGroup[]>;

interface ClaudeSettings {
  hooks?: HooksConfig;
  [key: string]: unknown;
}

function driftHookUrl(port: number): string {
  return `http://127.0.0.1:${port}/hooks/claude`;
}

function driftBridgeCommand(bridgeScriptPath: string, port: number): string {
  return `node "${bridgeScriptPath}" ${port}`;
}

function isCommandTransportEvent(eventName: string): boolean {
  return (COMMAND_TRANSPORT_EVENTS as readonly string[]).includes(eventName);
}

function isDriftHookHandler(handler: HookHandler, bridgeScriptPath: string): boolean {
  if (handler.type === "http") {
    return typeof handler.url === "string" && handler.url.includes("/hooks/claude");
  }
  if (handler.type === "command") {
    return typeof handler.command === "string" && handler.command.includes(bridgeScriptPath);
  }
  return false;
}

function buildDriftMatcherGroup(eventName: DriftHookEvent, port: number, bridgeScriptPath: string): HookMatcherGroup {
  const handler: HookHandler = isCommandTransportEvent(eventName)
    ? { type: "command", command: driftBridgeCommand(bridgeScriptPath, port) }
    : { type: "http", url: driftHookUrl(port) };

  return { matcher: "*", hooks: [handler] };
}

function readSettings(settingsFilePath: string): ClaudeSettings {
  if (!fs.existsSync(settingsFilePath)) {
    return {};
  }
  const raw = fs.readFileSync(settingsFilePath, "utf8").trim();
  return raw.length > 0 ? JSON.parse(raw) : {};
}

/**
 * Writes Drift's Claude Code hook configuration for `DRIFT_HOOK_EVENTS` into
 * the given settings file, pointing at the currently running runtime's port.
 * Most events use the "http" transport; events Claude Code doesn't support
 * over HTTP (SessionStart) are configured as a "command" hook that runs
 * `bridgeScriptPath` to forward the payload to the same endpoint.
 *
 * Idempotent: any hook handler previously installed by Drift (identified by
 * its "/hooks/claude" URL, or by its command referencing `bridgeScriptPath`)
 * is replaced rather than duplicated, and every unrelated setting, event,
 * and matcher group is left untouched.
 */
export function installClaudeHooks(settingsFilePath: string, port: number, bridgeScriptPath: string): ClaudeSettings {
  const settings = readSettings(settingsFilePath);
  const hooks: HooksConfig = { ...(settings.hooks ?? {}) };

  for (const eventName of DRIFT_HOOK_EVENTS) {
    const existingGroups = hooks[eventName] ?? [];
    const groupsWithoutDrift = existingGroups
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter((handler) => !isDriftHookHandler(handler, bridgeScriptPath)),
      }))
      .filter((group) => group.hooks.length > 0);

    groupsWithoutDrift.push(buildDriftMatcherGroup(eventName, port, bridgeScriptPath));
    hooks[eventName] = groupsWithoutDrift;
  }

  const updatedSettings: ClaudeSettings = { ...settings, hooks };

  fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
  fs.writeFileSync(settingsFilePath, JSON.stringify(updatedSettings, null, 2) + "\n", "utf8");

  return updatedSettings;
}
