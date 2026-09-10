import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import * as crypto from "crypto";
import { openStorage, DriftStorage } from "../../src/storage";
import { LocalModelRuntime, InferenceResult, InferOptions } from "../../src/localModelRuntime";
import {
  runMatchedBenchmark,
  toComparisonInput,
  BenchmarkRunnerConfig,
  BenchmarkTaskInput,
  ClaudeProcessLauncher,
  ClaudeRunSettings,
  TaskEvaluator,
} from "../../src/benchmarkRunner";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-benchmark-runner-test-"));
  return path.join(dir, "drift.sqlite3");
}

function tempWorkspaceTemplate(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-benchmark-template-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

function postJson(port: number, body: unknown): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/hooks/claude", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

/** Reads back the port the runner actually configured for this workspace, exactly as a real hook bridge would resolve it from the installed settings file -- no test-only side channel into production code. */
function portFromInstalledSettings(workspaceDir: string): number {
  const raw = fs.readFileSync(path.join(workspaceDir, ".claude", "settings.local.json"), "utf8");
  const settings = JSON.parse(raw);
  const command: string = settings.hooks.SessionStart[0].hooks[0].command;
  const match = command.match(/(\d+)\s*$/);
  if (!match) throw new Error(`could not find a port in installed command hook: ${command}`);
  return Number(match[1]);
}

function stubModelRuntime(responder: (prompt: string) => { text?: string; success?: boolean }): LocalModelRuntime {
  return {
    infer: async (prompt: string, _o?: InferOptions): Promise<InferenceResult> => {
      const r = responder(prompt);
      return { text: r.text, record: { startedAt: 0, durationMs: 0, inputTokens: 1, outputTokens: 1, success: r.success !== false, error: r.success === false ? "stub failure" : undefined } };
    },
    close: async () => {},
  };
}

const stalledRetryClassification = { progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" };

/** Posts one ordinary, successful turn: SessionStart, one prompt, one successful tool call, SessionEnd -- never a repeated-failure shape, so it can never accidentally become a redirect_candidate. */
async function postOrdinaryTurn(port: number, sessionId: string, storage: DriftStorage): Promise<void> {
  await postJson(port, { session_id: sessionId, hook_event_name: "SessionStart" });
  await postJson(port, { session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "do the task" });
  await postJson(port, { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_use_id: "ok-1" });
  await postJson(port, { session_id: sessionId, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_use_id: "ok-1", tool_response: { output: "hi" } });
  storage.insertModelUsageEvent(
    sessionId,
    { attributes: [{ key: "session.id", value: { stringValue: sessionId } }, { key: "prompt.id", value: { stringValue: "p1" } }, { key: "input_tokens", value: { intValue: "50" } }, { key: "output_tokens", value: { intValue: "20" } }] },
    Date.now()
  );
  await postJson(port, { session_id: sessionId, hook_event_name: "SessionEnd", reason: "clear" });
}

/** Posts a genuine, repeated-failure shape -- proven elsewhere (redirectInjection.test.ts) to become a real M8A repeated_failure finding, which with a stalled_retry/high-redundancy classification becomes a real redirect_candidate. No SessionEnd yet -- the session is still "in progress" awaiting the redirect's delivery turn. */
async function postStalledFirstTurn(port: number, sessionId: string, command: string, errorText: string): Promise<void> {
  await postJson(port, { session_id: sessionId, hook_event_name: "SessionStart" });
  await postJson(port, { session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "do the task" });
  for (let i = 0; i < 3; i++) {
    await postJson(port, { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: `bench-c${i}` });
    await postJson(port, { session_id: sessionId, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, tool_use_id: `bench-c${i}`, tool_response: { error: errorText } });
  }
}

function defaultSettings(): ClaudeRunSettings {
  return { model: "claude-test-model", allowedTools: ["Bash"], permissionMode: "bypassPermissions", env: { DRIFT_BENCHMARK: "1" } };
}

function passingEvaluator(): TaskEvaluator {
  return { name: "file-exists-evaluator", evaluate: (workspaceDir) => ({ passed: fs.existsSync(path.join(workspaceDir, "README.md")), checksPassed: 1, checksTotal: 1 }) };
}

suite("benchmarkRunner (M13C)", () => {
  let storage: DriftStorage;
  let workspaceTemplate: string;

  setup(() => {
    storage = openStorage(tempDbPath());
    workspaceTemplate = tempWorkspaceTemplate({ "README.md": "hello benchmark\n" });
  });

  teardown(() => {
    storage.close();
  });

  function baseConfig(overrides: Partial<BenchmarkRunnerConfig> = {}): BenchmarkRunnerConfig {
    return {
      storage,
      modelRuntime: stubModelRuntime(() => ({ text: JSON.stringify(stalledRetryClassification) })),
      bridgeScriptPath: path.resolve(__dirname, "../../src/hookBridge.js"),
      settings: defaultSettings(),
      launchClaudeTurn: (async () => ({ success: true, error: undefined })) as ClaudeProcessLauncher,
      approveRedirect: () => true,
      ...overrides,
    };
  }

  function input(): BenchmarkTaskInput {
    return { taskId: "bench-task-1", workspaceTemplate, prompt: "please fix the thing", evaluator: passingEvaluator() };
  }

  test("control/treatment start from byte-equivalent workspace state, in fully separate directories", async () => {
    const seenWorkspaces: string[] = [];
    const launcher: ClaudeProcessLauncher = async (options) => {
      seenWorkspaces.push(options.workspaceDir);
      return { success: true, error: undefined };
    };
    await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher }));

    const [controlWorkspace, treatmentWorkspace] = seenWorkspaces;
    assert.notStrictEqual(controlWorkspace, treatmentWorkspace);
    assert.strictEqual(fs.readFileSync(path.join(controlWorkspace, "README.md"), "utf8"), fs.readFileSync(path.join(treatmentWorkspace, "README.md"), "utf8"));

    // No cross-run state leakage: mutating one after the fact must never affect the other.
    fs.writeFileSync(path.join(controlWorkspace, "README.md"), "mutated by control\n");
    assert.strictEqual(fs.readFileSync(path.join(treatmentWorkspace, "README.md"), "utf8"), "hello benchmark\n");
  });

  test("same prompt/model/tool/permission/env settings are used for both sides, and recorded in the result", async () => {
    const seenSettings: ClaudeRunSettings[] = [];
    const seenPrompts: string[] = [];
    const launcher: ClaudeProcessLauncher = async (options) => {
      seenSettings.push(options.settings);
      seenPrompts.push(options.prompt);
      return { success: true, error: undefined };
    };
    const settings = defaultSettings();
    const result = await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher, settings }));

    assert.strictEqual(seenSettings[0], settings);
    assert.strictEqual(seenSettings[1], settings);
    assert.strictEqual(seenPrompts[0], "please fix the thing");
    assert.deepStrictEqual(result.settings, settings);
  });

  test("control and treatment are separate Claude sessions, and control never receives a redirect (structurally, not merely by outcome)", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      const isControl = options.workspaceDir.includes("control");
      if (!options.resume) {
        if (isControl) {
          await postOrdinaryTurn(port, options.sessionId, storage);
        } else {
          await postStalledFirstTurn(port, options.sessionId, "npm run migrate:prod", "ECONNREFUSED");
        }
      } else {
        await postJson(port, { session_id: options.sessionId, hook_event_name: "UserPromptSubmit", prompt_id: "p2", prompt: options.prompt });
        await postJson(port, { session_id: options.sessionId, hook_event_name: "SessionEnd", reason: "clear" });
      }
      return { success: true, error: undefined };
    };

    const result = await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher }));

    assert.notStrictEqual(result.control.sessionId, result.treatment.sessionId);
    // RunSideResult (control's own type) carries no driftOverhead/intervention/redirectOutcome field at all -- TypeScript itself proves control is structurally incapable of reporting a redirect, not merely one that happened not to fire.
    // Directly confirm: control's own session id was never handed to the redirect lifecycle at all.
    assert.strictEqual((storage.getSession(result.control.sessionId)?.events ?? []).some((e) => JSON.stringify(e.payload).includes("DRIFT REDIRECT")), false);
  });

  test("treatment exercises the real M12 approval/injection path end-to-end and produces a real M13A intervention record", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      const isControl = options.workspaceDir.includes("control");
      if (!options.resume) {
        if (isControl) {
          await postOrdinaryTurn(port, options.sessionId, storage);
        } else {
          await postStalledFirstTurn(port, options.sessionId, "rake db:migrate", "PG::ConnectionBad");
        }
      } else {
        const { body } = await postJson(port, { session_id: options.sessionId, hook_event_name: "UserPromptSubmit", prompt_id: "p2", prompt: options.prompt });
        assert.ok(JSON.parse(body).hookSpecificOutput, "the resumed turn's UserPromptSubmit must actually receive the injected redirect through the real runtime");
        storage.insertModelUsageEvent(
          options.sessionId,
          { attributes: [{ key: "session.id", value: { stringValue: options.sessionId } }, { key: "prompt.id", value: { stringValue: "p2" } }, { key: "input_tokens", value: { intValue: "10" } }, { key: "output_tokens", value: { intValue: "5" } }] },
          Date.now()
        );
        await postJson(port, { session_id: options.sessionId, hook_event_name: "SessionEnd", reason: "clear" });
      }
      return { success: true, error: undefined };
    };

    const result = await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher }));

    assert.strictEqual(result.treatment.redirectOutcome, "delivered");
    assert.ok(result.treatment.intervention, "a real InterventionRecord must be produced");
    assert.strictEqual(result.treatment.intervention!.sessionId, result.treatment.sessionId);
    assert.ok(result.treatment.driftOverhead);
    assert.strictEqual(result.treatment.driftOverhead!.localInferenceCount, 1, "exactly one classifyWindow call for the one evidence window");
  });

  test("real elapsedMs is captured identically (same clock, same definition) for both runs, distinct from Claude usage.durationMs", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      await new Promise((r) => setTimeout(r, 10));
      const port = portFromInstalledSettings(options.workspaceDir);
      if (!options.resume) await postOrdinaryTurn(port, options.sessionId, storage);
      return { success: true, error: undefined };
    };
    const result = await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher }));

    assert.ok(result.control.elapsedMs >= 10);
    assert.ok(result.treatment.elapsedMs >= 10);
    assert.strictEqual(result.control.elapsedMs, result.control.completedAt - result.control.startedAt);
    assert.strictEqual(result.treatment.elapsedMs, result.treatment.completedAt - result.treatment.startedAt);
  });

  test("task success comes from the explicit evaluator, never asked of Claude", async () => {
    const failingEvaluator: TaskEvaluator = { name: "strict-evaluator", evaluate: () => ({ passed: false, checksPassed: 0, checksTotal: 1 }) };
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      if (!options.resume) await postOrdinaryTurn(port, options.sessionId, storage);
      return { success: true, error: undefined };
    };
    const result = await runMatchedBenchmark({ ...input(), evaluator: failingEvaluator }, baseConfig({ launchClaudeTurn: launcher }));

    assert.strictEqual(result.control.taskResult!.passed, false);
    assert.strictEqual(result.control.taskResult!.evaluator, "strict-evaluator");
    assert.strictEqual(result.control.taskResult!.taskId, "bench-task-1");
  });

  test("real M7C usage is captured for both sides", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      if (!options.resume) await postOrdinaryTurn(port, options.sessionId, storage);
      return { success: true, error: undefined };
    };
    const result = await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher }));

    assert.strictEqual(result.control.usage!.inputTokens, 50);
    assert.strictEqual(result.control.usage!.outputTokens, 20);
    // Both sides ran the same postOrdinaryTurn fixture here, so treatment's real M7C usage must match control's exactly.
    assert.strictEqual(result.treatment.usage!.inputTokens, 50);
    assert.strictEqual(result.treatment.usage!.outputTokens, 20);
  });

  test("result feeds directly into comparePairedRun() via the adapter, without manually reconstructing identity fields", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      const isControl = options.workspaceDir.includes("control");
      if (!options.resume) {
        if (isControl) await postOrdinaryTurn(port, options.sessionId, storage);
        else await postStalledFirstTurn(port, options.sessionId, "terraform apply", "state lock");
      } else {
        await postJson(port, { session_id: options.sessionId, hook_event_name: "UserPromptSubmit", prompt_id: "p2", prompt: options.prompt });
        await postJson(port, { session_id: options.sessionId, hook_event_name: "SessionEnd", reason: "clear" });
      }
      return { success: true, error: undefined };
    };
    const result = await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher }));

    const adapted = toComparisonInput(result);
    assert.strictEqual(adapted.success, true, adapted.reason);
    assert.strictEqual(adapted.input!.taskId, result.taskId);
    assert.strictEqual(adapted.input!.control.sessionId, result.control.sessionId);
    assert.strictEqual(adapted.input!.treatment.intervention, result.treatment.intervention);

    const { comparePairedRun } = require("../../src/pairedComparison");
    const comparison = comparePairedRun(adapted.input!);
    assert.strictEqual(comparison.success, true, comparison.error);
  });

  test("adapter fails closed (with a reason) when treatment produced no redirect to compare", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      if (!options.resume) await postOrdinaryTurn(port, options.sessionId, storage); // ordinary for BOTH sides -- no redirect_candidate ever emerges
      return { success: true, error: undefined };
    };
    const result = await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher }));

    assert.strictEqual(result.treatment.redirectOutcome, "no_candidate");
    const adapted = toComparisonInput(result);
    assert.strictEqual(adapted.success, false);
    assert.ok(adapted.reason?.includes("no_candidate"));
  });

  test("a rejected redirect (harness declines approval) is recorded honestly, and the resumed turn never happens", async () => {
    let secondTurnCalls = 0;
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      if (!options.resume) {
        if (!options.workspaceDir.includes("control")) await postStalledFirstTurn(port, options.sessionId, "helm rollback", "revision not found");
        else await postOrdinaryTurn(port, options.sessionId, storage);
      } else {
        secondTurnCalls++;
      }
      return { success: true, error: undefined };
    };
    const result = await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher, approveRedirect: () => false }));

    assert.strictEqual(result.treatment.redirectOutcome, "rejected");
    assert.strictEqual(secondTurnCalls, 0, "a rejected redirect must never trigger a resumed turn");
    assert.strictEqual(result.treatment.intervention, undefined);
  });

  test("Claude process failure is recorded, not thrown, and does not crash the runner", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      if (options.workspaceDir.includes("control")) return { success: false, error: "simulated crash" };
      const port = portFromInstalledSettings(options.workspaceDir);
      if (!options.resume) await postOrdinaryTurn(port, options.sessionId, storage);
      return { success: true, error: undefined };
    };
    const result = await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher }));

    assert.strictEqual(result.control.claudeError, "simulated crash");
    assert.strictEqual(result.control.usage, undefined);
    assert.strictEqual(result.control.taskResult, undefined);
    assert.strictEqual(result.treatment.redirectOutcome, "no_candidate", "treatment must still run independently of control's failure");
  });

  test("evaluator failure is recorded explicitly, distinct from a Claude process failure", async () => {
    const throwingEvaluator: TaskEvaluator = { name: "broken-evaluator", evaluate: () => { throw new Error("evaluator exploded"); } };
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      if (!options.resume) await postOrdinaryTurn(port, options.sessionId, storage);
      return { success: true, error: undefined };
    };
    const result = await runMatchedBenchmark({ ...input(), evaluator: throwingEvaluator }, baseConfig({ launchClaudeTurn: launcher }));

    assert.strictEqual(result.control.evaluatorError, "evaluator exploded");
    assert.strictEqual(result.control.taskResult, undefined);
    assert.strictEqual(result.control.claudeError, undefined, "must be distinguishable from a Claude process failure");
  });

  test("treatment redirect failure (approved but never actually consumed) is recorded, never silently reported as delivered", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      if (!options.resume) {
        if (!options.workspaceDir.includes("control")) await postStalledFirstTurn(port, options.sessionId, "circleci trigger", "quota exceeded");
        else await postOrdinaryTurn(port, options.sessionId, storage);
      }
      // The resumed turn deliberately never posts UserPromptSubmit at all -- simulates the CLI succeeding without the hook actually firing.
      return { success: true, error: undefined };
    };
    const result = await runMatchedBenchmark(input(), baseConfig({ launchClaudeTurn: launcher }));

    assert.strictEqual(result.treatment.redirectOutcome, "delivery_failed");
    assert.strictEqual(result.treatment.intervention, undefined);
    assert.strictEqual(result.treatment.driftOverhead, undefined);
  });

  test("deterministic harness configuration: identical input/config produce identically-shaped, non-crashing results with the same settings object recorded twice", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      if (!options.resume) await postOrdinaryTurn(port, options.sessionId, storage);
      return { success: true, error: undefined };
    };
    const config = baseConfig({ launchClaudeTurn: launcher });
    const first = await runMatchedBenchmark(input(), config);
    const second = await runMatchedBenchmark(input(), config);

    assert.strictEqual(first.control.usage!.inputTokens, second.control.usage!.inputTokens);
    assert.strictEqual(first.settings, second.settings);
    assert.notStrictEqual(first.control.sessionId, second.control.sessionId, "each call creates a genuinely fresh session -- never reused across benchmark runs");
  });

  test("no cross-run state leakage: two consecutive benchmark calls never see each other's sessions or workspaces", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      const port = portFromInstalledSettings(options.workspaceDir);
      if (!options.resume) await postOrdinaryTurn(port, options.sessionId, storage);
      return { success: true, error: undefined };
    };
    const config = baseConfig({ launchClaudeTurn: launcher });
    const first = await runMatchedBenchmark(input(), config);
    const second = await runMatchedBenchmark(input(), config);

    const firstIds = [first.control.sessionId, first.treatment.sessionId];
    const secondIds = [second.control.sessionId, second.treatment.sessionId];
    for (const id of firstIds) assert.ok(!secondIds.includes(id), `session id ${id} was reused across benchmark runs`);
    assert.notStrictEqual(first.control.workspace, second.control.workspace);
    assert.notStrictEqual(first.treatment.workspace, second.treatment.workspace);
    // Each run's storage-backed usage totals only reflect that run's own session, never accumulated across calls.
    assert.strictEqual(first.control.usage!.inputTokens, second.control.usage!.inputTokens, "identical fixture content per run, not accumulating across runs");
  });
});
