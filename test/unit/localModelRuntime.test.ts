import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, ChildProcess, execSync } from "child_process";
import { createLocalModelRuntime, LocalModelRuntime } from "../../src/localModelRuntime";
import { openStorage } from "../../src/storage";

const MODEL_PATH = path.join(process.cwd(), "models", "gemma-3-4b-it-IQ4_XS.gguf");
const MODEL_PRESENT = fs.existsSync(MODEL_PATH);

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-local-model-test-"));
  return path.join(dir, "drift.sqlite3");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newLlamaServerPids(before: string[]): string[] {
  let after: string[];
  try {
    after = execSync("pgrep -f llama-server").toString().trim().split("\n").filter(Boolean);
  } catch {
    after = [];
  }
  return after.filter((pid) => !before.includes(pid));
}

function currentLlamaServerPids(): string[] {
  try {
    return execSync("pgrep -f llama-server").toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
  });
}

async function waitForHealth(baseUrl: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(200);
  }
  return false;
}

suite("localModelRuntime (M9A)", function () {
  // Real model loading + inference is slow (a few seconds), well beyond mocha's
  // 2000ms default under the full VS Code integration harness (test/suite/index.ts
  // constructs Mocha with no timeout override) -- every test here sets its own.

  if (!MODEL_PRESENT) {
    test("SKIPPED: models/gemma-3-4b-it-IQ4_XS.gguf is not present in this checkout", () => {
      assert.ok(true, "the real Gemma 3 4B GGUF is a local, gitignored asset (see .gitignore) and is not part of the repository");
    });
    return;
  }

  suite("real inference against Gemma 3 4B (spawned server)", () => {
    let runtime: LocalModelRuntime;

    suiteSetup(async function () {
      this.timeout(60000);
      runtime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 45000 });
      // Warm the server up once so individual tests below measure steady-state behavior.
      const warmup = await runtime.infer("Say the word BANANA and nothing else.");
      assert.strictEqual(warmup.record.success, true, `warmup inference must succeed: ${warmup.record.error}`);
    });

    suiteTeardown(async function () {
      this.timeout(10000);
      await runtime.close();
    });

    test("local llama.cpp inference succeeds against Gemma 3 4B and returns real generated text", async function () {
      this.timeout(30000);
      const result = await runtime.infer("Reply with exactly the single word: PINEAPPLE");

      assert.strictEqual(result.record.success, true, result.record.error);
      assert.ok(typeof result.text === "string" && result.text.trim().length > 0, "must return non-empty generated text");
      assert.ok(/pineapple/i.test(result.text!), `expected the model's real output to contain "pineapple", got: ${result.text}`);
    });

    test("records startedAt, durationMs, and input/output token counts for a successful call", async function () {
      this.timeout(30000);
      const before = Date.now();
      const result = await runtime.infer("What is 2 + 2? Answer with just the number.");
      const after = Date.now();

      assert.strictEqual(result.record.success, true, result.record.error);
      assert.ok(result.record.startedAt >= before && result.record.startedAt <= after);
      assert.ok(result.record.durationMs >= 0 && result.record.durationMs <= after - before + 50);
      assert.ok(typeof result.record.inputTokens === "number" && result.record.inputTokens! > 0, "real llama-server usage.prompt_tokens must be recorded");
      assert.ok(typeof result.record.outputTokens === "number" && result.record.outputTokens! > 0, "real llama-server usage.completion_tokens must be recorded");
      assert.strictEqual(result.record.error, undefined);
    });

    test("multiple sequential calls all work, reusing the same running server", async function () {
      this.timeout(30000);
      const first = await runtime.infer("Reply with exactly: ONE");
      const second = await runtime.infer("Reply with exactly: TWO");
      const third = await runtime.infer("Reply with exactly: THREE");

      for (const result of [first, second, third]) {
        assert.strictEqual(result.record.success, true, result.record.error);
        assert.ok(typeof result.text === "string" && result.text!.length > 0);
      }
    });

    test("Drift does not mutate trajectory/session data as a side effect of running inference", async function () {
      this.timeout(30000);
      const storage = openStorage(tempDbPath());
      const session = storage.createSession(1234);
      storage.insertRawEvent(session.id, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
      const before = JSON.stringify(storage.getSession(session.id));

      const result = await runtime.infer("Say hello.");
      assert.strictEqual(result.record.success, true, result.record.error);

      const after = JSON.stringify(storage.getSession(session.id));
      assert.strictEqual(after, before, "running local inference must not change anything in Drift's own storage");
      storage.close();
    });
  });

  suite("connecting to an already-running llama-server (\"connect\" mode)", () => {
    let externalServer: ChildProcess;
    let externalPort: number;

    suiteSetup(async function () {
      this.timeout(60000);
      externalPort = 8791;
      externalServer = spawn("llama-server", ["-m", MODEL_PATH, "--port", String(externalPort), "--host", "127.0.0.1"], {
        stdio: "ignore",
      });
      const healthy = await waitForHealth(`http://127.0.0.1:${externalPort}`, Date.now() + 45000);
      assert.ok(healthy, "externally-managed llama-server must become healthy for this test to be meaningful");
    });

    suiteTeardown(async function () {
      this.timeout(10000);
      if (externalServer) await killAndWait(externalServer);
    });

    test("connects to the existing server instead of spawning a new one, and inference succeeds", async function () {
      this.timeout(20000);
      const runtime = createLocalModelRuntime({
        modelPath: MODEL_PATH,
        serverUrl: `http://127.0.0.1:${externalPort}`,
        timeoutMs: 15000,
      });

      const result = await runtime.infer("Reply with exactly: CONNECTED");
      assert.strictEqual(result.record.success, true, result.record.error);
      assert.ok(typeof result.text === "string" && result.text!.length > 0);

      // close() must be a no-op here: this runtime never owned a process.
      await runtime.close();
      assert.strictEqual(externalServer.exitCode, null, "close() must not kill a server this runtime only connected to");
    });
  });

  suite("failure containment", () => {
    test("a nonexistent model path fails safely instead of hanging or throwing", async function () {
      this.timeout(20000);
      const runtime = createLocalModelRuntime({
        modelPath: path.join(os.tmpdir(), "does-not-exist-" + Date.now() + ".gguf"),
        timeoutMs: 15000,
      });

      const result = await runtime.infer("hello");
      assert.strictEqual(result.record.success, false);
      assert.ok(result.record.error && result.record.error.length > 0);
      assert.strictEqual(result.text, undefined);
      await runtime.close();
    });

    test("a nonexistent llama-server binary fails safely instead of hanging or throwing", async function () {
      this.timeout(20000);
      const runtime = createLocalModelRuntime({
        modelPath: MODEL_PATH,
        llamaServerPath: "definitely-not-a-real-binary-" + Date.now(),
        timeoutMs: 15000,
      });

      const result = await runtime.infer("hello");
      assert.strictEqual(result.record.success, false);
      assert.ok(result.record.error && result.record.error.length > 0);
      assert.strictEqual(result.text, undefined);
      await runtime.close();
    });

    test("an unreachable external server URL fails safely instead of hanging or throwing", async function () {
      this.timeout(15000);
      const runtime = createLocalModelRuntime({
        modelPath: MODEL_PATH,
        serverUrl: "http://127.0.0.1:1", // nothing listens here
        timeoutMs: 3000,
      });

      const result = await runtime.infer("hello");
      assert.strictEqual(result.record.success, false);
      assert.ok(result.record.error?.includes("could not reach"));
      await runtime.close();
    });

    test("the timeout is bounded: a request budget too small to load the model still resolves promptly with a failure", async function () {
      this.timeout(10000);
      const startedWaiting = Date.now();
      const runtime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 200 });

      const result = await runtime.infer("hello");
      const elapsed = Date.now() - startedWaiting;

      assert.strictEqual(result.record.success, false);
      assert.ok(elapsed < 5000, `infer() must not hang well past its own timeout budget; took ${elapsed}ms`);
      await runtime.close();
    });
  });

  suite("M9A.1: startup failure cleanup", () => {
    test("a spawn timeout leaves zero new llama-server processes, even when the caller never calls close()", async function () {
      this.timeout(20000);
      const before = currentLlamaServerPids();

      // Deliberately discarded without calling close(): the whole point of
      // this milestone is that a caller must not need to do that.
      const runtime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 300 });
      const result = await runtime.infer("hello");
      assert.strictEqual(result.record.success, false);

      // Give a genuinely leaked process every chance to still be there.
      await sleep(5000);
      const leaked = newLlamaServerPids(before);
      assert.deepStrictEqual(leaked, [], `expected no leaked llama-server processes, found: ${leaked.join(", ")}`);
    });

    test("a later infer() call on the SAME runtime retries cleanly: no hang, no throw, a genuinely fresh spawn attempt", async function () {
      this.timeout(30000);
      const runtime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 300 });

      const before = currentLlamaServerPids();
      const failed = await runtime.infer("hello");
      assert.strictEqual(failed.record.success, false, "the first call must fail with such a short timeout");
      // The failed attempt's own process must already be gone (see the
      // "leaves zero new processes" test above for the dedicated check).

      // Calling infer() again on the exact same instance must not hang,
      // must not throw, and must attempt an independent fresh spawn rather
      // than reusing or getting stuck on the dead one -- observable as a
      // brand new llama-server PID showing up, distinct from before.
      const secondAttemptPids: string[] = [];
      const pollForNewPid = setInterval(() => {
        for (const pid of newLlamaServerPids(before)) {
          if (!secondAttemptPids.includes(pid)) secondAttemptPids.push(pid);
        }
      }, 100);

      await assert.doesNotReject(runtime.infer("hello again"));
      clearInterval(pollForNewPid);
      assert.ok(secondAttemptPids.length >= 1, "retrying on the same runtime must spawn a genuinely new llama-server process");

      await runtime.close();
    });

    test("after a failed startup, inference against the same model succeeds again given adequate time", async function () {
      this.timeout(60000);
      const failed = await createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 300 }).infer("hello");
      assert.strictEqual(failed.record.success, false);

      const retryRuntime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 45000 });
      const retried = await retryRuntime.infer("Reply with exactly: RETRIED");
      assert.strictEqual(retried.record.success, true, retried.record.error);
      assert.ok(retried.text && retried.text.length > 0);
      await retryRuntime.close();
    });

    test("concurrent successful calls still use exactly one spawned server", async function () {
      this.timeout(60000);
      const before = currentLlamaServerPids();
      const runtime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 45000 });

      const [a, b, c] = await Promise.all([
        runtime.infer("Reply with exactly: X"),
        runtime.infer("Reply with exactly: Y"),
        runtime.infer("Reply with exactly: Z"),
      ]);
      assert.strictEqual(a.record.success, true, a.record.error);
      assert.strictEqual(b.record.success, true, b.record.error);
      assert.strictEqual(c.record.success, true, c.record.error);

      const spawned = newLlamaServerPids(before);
      assert.strictEqual(spawned.length, 1, `expected exactly one spawned llama-server process, found ${spawned.length}`);

      await runtime.close();
    });

    test("close() after a failed startup is safe and idempotent", async function () {
      this.timeout(20000);
      const runtime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 300 });
      const result = await runtime.infer("hello");
      assert.strictEqual(result.record.success, false);

      await assert.doesNotReject(runtime.close());
      await assert.doesNotReject(runtime.close());
      await assert.doesNotReject(runtime.close());
    });

    test("an externally-managed server is never terminated by Drift, even when connecting to it is reported as a failure", async function () {
      this.timeout(60000);
      const port = 8799;
      const externalServer = spawn("llama-server", ["-m", MODEL_PATH, "--port", String(port), "--host", "127.0.0.1"], { stdio: "ignore" });
      try {
        const healthy = await waitForHealth(`http://127.0.0.1:${port}`, Date.now() + 45000);
        assert.ok(healthy, "the externally-managed server must come up for this test to be meaningful");

        // A timeout far too small for even one health check to complete --
        // ensureServer will report failure despite the server being healthy.
        const runtime = createLocalModelRuntime({ modelPath: MODEL_PATH, serverUrl: `http://127.0.0.1:${port}`, timeoutMs: 1 });
        const result = await runtime.infer("hello");
        assert.strictEqual(result.record.success, false);

        await sleep(500);
        assert.strictEqual(externalServer.exitCode, null, "Drift must never kill a server it only connects to, even on failure");
        await runtime.close();
        assert.strictEqual(externalServer.exitCode, null, "close() must also never touch an externally-managed server");
      } finally {
        await killAndWait(externalServer);
      }
    });
  });
});
