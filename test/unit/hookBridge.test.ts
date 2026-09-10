import * as assert from "assert";
import * as child_process from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startRuntime, DriftRuntime, RedirectInjectionHook } from "../../src/runtime";
import { openStorage, DriftStorage } from "../../src/storage";
import { RedirectLifecycleManager } from "../../src/redirectLifecycle";
import { formatInjectedRedirectContext, RedirectPacket } from "../../src/redirectPacket";
import { SessionAnalysis } from "../../src/sessionAnalysisPipeline";

const BRIDGE_SCRIPT_PATH = path.resolve(__dirname, "../../src/hookBridge.js");

function openTempStorage(): DriftStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-hook-bridge-test-"));
  return openStorage(path.join(dir, "drift.sqlite3"));
}

function runBridge(port: number, stdinPayload: string): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(process.execPath, [BRIDGE_SCRIPT_PATH, String(port)], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ exitCode: code, stdout: Buffer.concat(chunks).toString("utf8") }));
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

    const { exitCode } = await runBridge(runtime.port, JSON.stringify(payload));
    assert.strictEqual(exitCode, 0);

    const result = storage.getSession("bridge-session-1");
    assert.ok(result, "SessionStart did not create/reach a session");
    assert.strictEqual(result!.events.length, 1);
    assert.deepStrictEqual(result!.events[0].payload, payload);
  });

  test("exits 0 even when the runtime is unreachable, so it never blocks the Claude session", async () => {
    const unusedPort = 1;
    const { exitCode } = await runBridge(unusedPort, JSON.stringify({ session_id: "x", hook_event_name: "SessionStart" }));
    assert.strictEqual(exitCode, 0);
  });

  test("SessionStart never produces stdout output, unaffected by the M12B.1 redirect-forwarding addition", async () => {
    const { stdout } = await runBridge(runtime.port, JSON.stringify({ session_id: "bridge-session-2", hook_event_name: "SessionStart" }));
    assert.strictEqual(stdout, "");
  });
});

suite("hookBridge UserPromptSubmit redirect forwarding (M12B.1)", () => {
  let storage: DriftStorage;

  setup(() => {
    storage = openTempStorage();
  });

  teardown(() => {
    storage.close();
  });

  async function startRuntimeWithInjection(hook: RedirectInjectionHook): Promise<DriftRuntime> {
    return startRuntime(storage, undefined, hook);
  }

  test("prints exactly the injected redirect text to stdout, with no JSON wrapper and no extra characters", async () => {
    const injected = "DRIFT REDIRECT\n\nCurrent state:\n- Bash (curl) failed\n\nAvoid repeating:\nRepeated identical failing command\n\nSuggested next action:\nReassess.\n\nThis is guidance, not a forced command.";
    const runtime = await startRuntimeWithInjection({
      getInjectableContext: () => injected,
      markConsumed: () => {},
    });
    try {
      const { exitCode, stdout } = await runBridge(runtime.port, JSON.stringify({ session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "what next?" }));
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout, injected, "stdout must be EXACTLY the injected text -- no wrapper, no trailing newline added, nothing else");
    } finally {
      await runtime.stop();
    }
  });

  test("emits no stdout when no redirect is injectable", async () => {
    const runtime = await startRuntimeWithInjection({
      getInjectableContext: () => undefined,
      markConsumed: () => {},
    });
    try {
      const { exitCode, stdout } = await runBridge(runtime.port, JSON.stringify({ session_id: "s2", hook_event_name: "UserPromptSubmit" }));
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout, "");
    } finally {
      await runtime.stop();
    }
  });

  test("a real end-to-end run through the actual runtime (no fake hook): an approved packet is forwarded via stdout by the real bridge process, exactly once", async () => {
    const lifecycle = new RedirectLifecycleManager();
    const sessionId = "bridge-e2e-session";
    const packet: RedirectPacket = {
      sessionId,
      sourceStepIndexes: [0, 1],
      reasonCodes: ["strong_deterministic_signal"],
      currentState: ["Bash (npm test) failed"],
      avoidRepeating: "Repeated identical failing command: Bash failed 2 times",
      suggestedNextAction: "Reassess the current approach before continuing.",
    };
    const analysis: SessionAnalysis = { sessionId, analyses: [] };
    lifecycle.prepare(packet, analysis);
    lifecycle.approve(sessionId);

    const runtime = await startRuntimeWithInjection({
      getInjectableContext: (sid: string) => {
        const p = lifecycle.getInjectablePacket(sid, analysis);
        return p ? formatInjectedRedirectContext(p) : undefined;
      },
      markConsumed: (sid: string) => lifecycle.markConsumed(sid),
    });
    try {
      const expected = formatInjectedRedirectContext(packet);
      const first = await runBridge(runtime.port, JSON.stringify({ session_id: sessionId, hook_event_name: "UserPromptSubmit" }));
      assert.strictEqual(first.exitCode, 0);
      assert.strictEqual(first.stdout, expected);
      assert.strictEqual(lifecycle.getState(sessionId), "consumed");

      const second = await runBridge(runtime.port, JSON.stringify({ session_id: sessionId, hook_event_name: "UserPromptSubmit" }));
      assert.strictEqual(second.stdout, "", "a consumed packet must never be forwarded a second time");
    } finally {
      await runtime.stop();
    }
  });

  test("forwards the complete UserPromptSubmit payload unchanged, including unknown/future fields, regardless of whether a redirect is injected", async () => {
    const runtime = await startRuntimeWithInjection({
      getInjectableContext: () => "some guidance",
      markConsumed: () => {},
    });
    try {
      const payload = {
        session_id: "preserve-capture-session",
        hook_event_name: "UserPromptSubmit",
        prompt: "what should I do next?",
        cwd: "/some/project",
        transcript_path: "/some/project/.claude/transcript.jsonl",
        a_completely_unknown_future_field: { nested: true, value: 42 },
      };
      const { exitCode, stdout } = await runBridge(runtime.port, JSON.stringify(payload));
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout, "some guidance");

      const result = storage.getSession("preserve-capture-session");
      assert.ok(result, "UserPromptSubmit did not create/reach a session");
      assert.strictEqual(result!.events.length, 1);
      assert.deepStrictEqual(result!.events[0].payload, payload, "the full original payload, including unknown fields, must persist completely unchanged");
    } finally {
      await runtime.stop();
    }
  });

  test("emits no stdout when the raw hook payload is missing the required fields (400 response), and still exits 0", async () => {
    const runtime = await startRuntimeWithInjection({
      getInjectableContext: () => "should never be reached",
      markConsumed: () => {},
    });
    try {
      const { exitCode, stdout } = await runBridge(runtime.port, JSON.stringify({ hook_event_name: "UserPromptSubmit" }));
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout, "");
    } finally {
      await runtime.stop();
    }
  });

  test("failure containment: an unreachable runtime yields empty stdout and exit 0, never garbled text", async () => {
    const unusedPort = 1;
    const { exitCode, stdout } = await runBridge(unusedPort, JSON.stringify({ session_id: "s3", hook_event_name: "UserPromptSubmit" }));
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(stdout, "");
  });

  test("failure containment: a malformed/non-JSON response body from the server yields empty stdout, never garbled text", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not valid json at all {{{");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const { exitCode, stdout } = await runBridge(port, JSON.stringify({ session_id: "s4", hook_event_name: "UserPromptSubmit" }));
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout, "");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("failure containment: a well-formed JSON response missing hookSpecificOutput yields empty stdout", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const { exitCode, stdout } = await runBridge(port, JSON.stringify({ session_id: "s5", hook_event_name: "UserPromptSubmit" }));
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout, "");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
