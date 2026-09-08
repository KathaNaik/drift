/**
 * Development-only harness for M4C: runs the real Drift runtime and storage
 * exactly as the extension does, and installs real Claude Code hooks for a
 * given workspace directory using the actual production hookInstaller.
 *
 * This exists to let a real Claude Code CLI session (run separately, in the
 * same workspace) be captured end-to-end, without any VS Code host involved.
 * It is not part of the shipped extension.
 *
 * Usage: node ./out/dev/harness.js <workspace-directory>
 */
import * as path from "path";
import { openStorage } from "../src/storage";
import { startRuntime } from "../src/runtime";
import { installClaudeHooks } from "../src/hookInstaller";

async function main(): Promise<void> {
  const workspaceDir = process.argv[2];
  if (!workspaceDir) {
    console.error("Usage: node ./out/dev/harness.js <workspace-directory>");
    process.exit(1);
  }

  const absoluteWorkspaceDir = path.resolve(workspaceDir);
  const dbPath = path.join(absoluteWorkspaceDir, ".drift-dev", "drift.sqlite3");
  const storage = openStorage(dbPath);
  const runtime = await startRuntime(storage);

  const settingsPath = path.join(absoluteWorkspaceDir, ".claude", "settings.local.json");
  const bridgeScriptPath = path.join(__dirname, "..", "src", "hookBridge.js");
  installClaudeHooks(settingsPath, runtime.port, bridgeScriptPath);

  console.log("Drift dev harness running.");
  console.log(`  Workspace:       ${absoluteWorkspaceDir}`);
  console.log(`  Runtime port:    ${runtime.port}`);
  console.log(`  Hook config:     ${settingsPath}`);
  console.log(`  SQLite database: ${dbPath}`);
  console.log(`  Bridge script:   ${bridgeScriptPath}`);
  console.log("");
  console.log("Now run a real Claude Code session in that workspace and give it a small task.");
  console.log("Press Ctrl+C here when the session has ended to stop the runtime.");

  const shutdown = async () => {
    console.log("\nStopping runtime...");
    await runtime.stop();
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
