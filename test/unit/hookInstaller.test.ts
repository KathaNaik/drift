import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { installClaudeHooks, DRIFT_HOOK_EVENTS } from "../../src/hookInstaller";

const BRIDGE_SCRIPT_PATH = "/fake/extension/out/src/hookBridge.js";
const COMMAND_EVENTS = ["SessionStart", "UserPromptSubmit"];
const HTTP_EVENTS = DRIFT_HOOK_EVENTS.filter((e) => !COMMAND_EVENTS.includes(e));

function tempSettingsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-hook-installer-test-"));
  return path.join(dir, ".claude", "settings.local.json");
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

suite("hookInstaller (M4B)", () => {
  test("creates the Claude hook config for a workspace that has none yet", () => {
    const settingsPath = tempSettingsPath();
    assert.strictEqual(fs.existsSync(settingsPath), false);

    const settings = installClaudeHooks(settingsPath, 4123, BRIDGE_SCRIPT_PATH);

    assert.strictEqual(fs.existsSync(settingsPath), true);
    assert.deepStrictEqual(settings, readJson(settingsPath));
    for (const eventName of HTTP_EVENTS) {
      const groups = (settings.hooks as any)[eventName];
      assert.strictEqual(groups.length, 1);
      assert.strictEqual(groups[0].hooks.length, 1);
      assert.strictEqual(groups[0].hooks[0].type, "http");
      assert.strictEqual(groups[0].hooks[0].url, "http://127.0.0.1:4123/hooks/claude");
    }
  });

  test("generated URLs use the given active runtime port", () => {
    const settingsPath = tempSettingsPath();
    const settings = installClaudeHooks(settingsPath, 55123, BRIDGE_SCRIPT_PATH) as any;

    assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].url, "http://127.0.0.1:55123/hooks/claude");
    assert.strictEqual(settings.hooks.SessionEnd[0].hooks[0].url, "http://127.0.0.1:55123/hooks/claude");
  });

  test("only the specified event names are configured, nothing else is added", () => {
    const settingsPath = tempSettingsPath();
    const settings = installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH) as any;

    const configuredEvents = Object.keys(settings.hooks).sort();
    assert.deepStrictEqual(configuredEvents, [...DRIFT_HOOK_EVENTS].sort());
  });

  test("preserves unrelated existing settings and unrelated hook events", () => {
    const settingsPath = tempSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          permissions: { allow: ["Bash(npm test)"] },
          hooks: {
            Notification: [{ matcher: "*", hooks: [{ type: "command", command: "notify-send hi" }] }],
          },
        },
        null,
        2
      )
    );

    const settings = installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH) as any;

    assert.deepStrictEqual(settings.permissions, { allow: ["Bash(npm test)"] });
    assert.deepStrictEqual(settings.hooks.Notification, [
      { matcher: "*", hooks: [{ type: "command", command: "notify-send hi" }] },
    ]);
  });

  test("preserves a user's own hooks for the same event Drift configures", () => {
    const settingsPath = tempSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo custom" }] }],
          },
        },
        null,
        2
      )
    );

    const settings = installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.PreToolUse;
    assert.strictEqual(groups.length, 2);
    assert.deepStrictEqual(groups[0], { matcher: "Bash", hooks: [{ type: "command", command: "echo custom" }] });
    assert.strictEqual(groups[1].hooks[0].url, "http://127.0.0.1:4000/hooks/claude");
  });

  test("running setup twice does not duplicate Drift hooks", () => {
    const settingsPath = tempSettingsPath();
    installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH);
    const settings = installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH) as any;

    for (const eventName of DRIFT_HOOK_EVENTS) {
      const groups = settings.hooks[eventName];
      assert.strictEqual(groups.length, 1, `${eventName} should have exactly one Drift hook group`);
      assert.strictEqual(groups[0].hooks.length, 1);
    }
  });

  test("re-running setup after the runtime port changed updates the URL instead of adding a second entry", () => {
    const settingsPath = tempSettingsPath();
    installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH);
    const settings = installClaudeHooks(settingsPath, 9999, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.PostToolUse;
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].hooks.length, 1);
    assert.strictEqual(groups[0].hooks[0].url, "http://127.0.0.1:9999/hooks/claude");
  });

  test("re-running setup does not disturb a user's own hooks for the same event", () => {
    const settingsPath = tempSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo custom" }] }],
          },
        },
        null,
        2
      )
    );

    installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH);
    const settings = installClaudeHooks(settingsPath, 5000, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.PreToolUse;
    assert.strictEqual(groups.length, 2);
    assert.deepStrictEqual(groups[0], { matcher: "Bash", hooks: [{ type: "command", command: "echo custom" }] });
    assert.strictEqual(groups[1].hooks[0].url, "http://127.0.0.1:5000/hooks/claude");
  });

  test("SessionStart is configured as a command hook, not http", () => {
    const settingsPath = tempSettingsPath();
    const settings = installClaudeHooks(settingsPath, 4321, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.SessionStart;
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].hooks.length, 1);
    assert.strictEqual(groups[0].hooks[0].type, "command");
    assert.strictEqual(groups[0].hooks[0].url, undefined);
    assert.ok(groups[0].hooks[0].command.includes(BRIDGE_SCRIPT_PATH));
    assert.ok(groups[0].hooks[0].command.includes("4321"));
  });

  test("re-running setup updates the SessionStart bridge command when the port changes, without duplicating it", () => {
    const settingsPath = tempSettingsPath();
    installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH);
    const settings = installClaudeHooks(settingsPath, 9999, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.SessionStart;
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].hooks.length, 1);
    assert.ok(groups[0].hooks[0].command.includes("9999"));
    assert.ok(!groups[0].hooks[0].command.includes(" 4000"));
  });

  test("migrates a stale pre-M4B.1 SessionStart HTTP hook to the command bridge, without duplicating it", () => {
    const settingsPath = tempSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:4000/hooks/claude" }] }],
          },
        },
        null,
        2
      )
    );

    const settings = installClaudeHooks(settingsPath, 9999, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.SessionStart;
    assert.strictEqual(groups.length, 1, "stale http entry should be replaced, not kept alongside the new one");
    assert.strictEqual(groups[0].hooks.length, 1);
    assert.strictEqual(groups[0].hooks[0].type, "command");
    assert.strictEqual(groups[0].hooks[0].url, undefined);
    assert.ok(groups[0].hooks[0].command.includes(BRIDGE_SCRIPT_PATH));
    assert.ok(groups[0].hooks[0].command.includes("9999"));
    assert.ok(!groups[0].hooks[0].command.includes("4000"));
  });

  test("preserves a user's own SessionStart hooks alongside Drift's bridge command", () => {
    const settingsPath = tempSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo welcome" }] }],
          },
        },
        null,
        2
      )
    );

    const settings = installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.SessionStart;
    assert.strictEqual(groups.length, 2);
    assert.deepStrictEqual(groups[0], { matcher: "startup", hooks: [{ type: "command", command: "echo welcome" }] });
    assert.strictEqual(groups[1].hooks[0].type, "command");
    assert.ok(groups[1].hooks[0].command.includes(BRIDGE_SCRIPT_PATH));
  });

  test("UserPromptSubmit is configured as a command hook, not http (M12B.1)", () => {
    const settingsPath = tempSettingsPath();
    const settings = installClaudeHooks(settingsPath, 4321, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.UserPromptSubmit;
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].hooks.length, 1);
    assert.strictEqual(groups[0].hooks[0].type, "command");
    assert.strictEqual(groups[0].hooks[0].url, undefined);
    assert.ok(groups[0].hooks[0].command.includes(BRIDGE_SCRIPT_PATH));
    assert.ok(groups[0].hooks[0].command.includes("4321"));
  });

  test("re-running setup updates the UserPromptSubmit bridge command when the port changes, without duplicating it (M12B.1)", () => {
    const settingsPath = tempSettingsPath();
    installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH);
    const settings = installClaudeHooks(settingsPath, 9999, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.UserPromptSubmit;
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].hooks.length, 1);
    assert.ok(groups[0].hooks[0].command.includes("9999"));
    assert.ok(!groups[0].hooks[0].command.includes(" 4000"));
  });

  test("migrates a stale pre-M12B.1 UserPromptSubmit HTTP hook to the command bridge, without duplicating it", () => {
    const settingsPath = tempSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:4000/hooks/claude" }] }],
          },
        },
        null,
        2
      )
    );

    const settings = installClaudeHooks(settingsPath, 9999, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.UserPromptSubmit;
    assert.strictEqual(groups.length, 1, "stale http entry should be replaced, not kept alongside the new one");
    assert.strictEqual(groups[0].hooks.length, 1);
    assert.strictEqual(groups[0].hooks[0].type, "command");
    assert.strictEqual(groups[0].hooks[0].url, undefined);
    assert.ok(groups[0].hooks[0].command.includes(BRIDGE_SCRIPT_PATH));
    assert.ok(groups[0].hooks[0].command.includes("9999"));
    assert.ok(!groups[0].hooks[0].command.includes("4000"));
  });

  test("migration is idempotent: running the migrated setup repeatedly never accumulates duplicate UserPromptSubmit entries", () => {
    const settingsPath = tempSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:4000/hooks/claude" }] }],
          },
        },
        null,
        2
      )
    );

    installClaudeHooks(settingsPath, 9999, BRIDGE_SCRIPT_PATH);
    installClaudeHooks(settingsPath, 9999, BRIDGE_SCRIPT_PATH);
    const settings = installClaudeHooks(settingsPath, 9999, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.UserPromptSubmit;
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].hooks.length, 1);
    assert.strictEqual(groups[0].hooks[0].type, "command");
  });

  test("preserves a user's own UserPromptSubmit hooks alongside Drift's bridge command", () => {
    const settingsPath = tempSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: "echo custom-prompt-hook" }] }],
          },
        },
        null,
        2
      )
    );

    const settings = installClaudeHooks(settingsPath, 4000, BRIDGE_SCRIPT_PATH) as any;

    const groups = settings.hooks.UserPromptSubmit;
    assert.strictEqual(groups.length, 2);
    assert.deepStrictEqual(groups[0], { matcher: "*", hooks: [{ type: "command", command: "echo custom-prompt-hook" }] });
    assert.strictEqual(groups[1].hooks[0].type, "command");
    assert.ok(groups[1].hooks[0].command.includes(BRIDGE_SCRIPT_PATH));
  });
});
