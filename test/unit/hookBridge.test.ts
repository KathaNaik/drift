import * as assert from "assert";
import * as child_process from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { startRuntime, DriftRuntime } from "../../src/runtime";
import { openStorage, DriftStorage } from "../../src/storage";

const BRIDGE_SCRIPT_PATH = path.resolve(__dirname, "../../src/hookBridge.js");

function openTempStorage(): DriftStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-hook-bridge-test-"));
  return openStorage(path.join(dir, "drift.sqlite3"));
}

function runBridge(port: number, stdinPayload: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(process.execPath, [BRIDGE_SCRIPT_PATH, String(port)], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
    child.stdin.end(stdinPayload);
  });
}

suite("hookBridge (M4B.1)", () => {
  let storage: DriftStorage;
  let runtime: DriftRuntime;

  setup(async () => {
    storage = openTempStorage();
    runtime = await startRuntime(storage);
  });

  teardown(async () => {
    await runtime.stop();
    storage.close();
  });

  test("forwards a complete SessionStart payload from stdin to /hooks/claude unchanged, and exits successfully", async () => {
    const payload = {
      session_id: "bridge-session-1",
      hook_event_name: "SessionStart",
      cwd: "/some/project",
      transcript_path: "/some/project/.claude/transcript.jsonl",
      source: "startup",
    };

    const exitCode = await runBridge(runtime.port, JSON.stringify(payload));
    assert.strictEqual(exitCode, 0);

    const result = storage.getSession("bridge-session-1");
    assert.ok(result, "SessionStart did not create/reach a session");
    assert.strictEqual(result!.events.length, 1);
    assert.deepStrictEqual(result!.events[0].payload, payload);
  });

  test("exits 0 even when the runtime is unreachable, so it never blocks the Claude session", async () => {
    const unusedPort = 1;
    const exitCode = await runBridge(unusedPort, JSON.stringify({ session_id: "x", hook_event_name: "SessionStart" }));
    assert.strictEqual(exitCode, 0);
  });
});
