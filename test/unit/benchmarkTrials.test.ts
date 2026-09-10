import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import { openStorage, DriftStorage } from "../../src/storage";
import { LocalModelRuntime, InferenceResult, InferOptions } from "../../src/localModelRuntime";
import { ClaudeProcessLauncher, ClaudeTurnOptions, ClaudeTurnResult } from "../../src/benchmarkRunner";
import { validateBenchmarkTask, BenchmarkTaskDefinition } from "../../src/benchmarkTaskSpec";
import { runBenchmarkTrials, TrialRunnerConfig, TrialRecord } from "../../src/benchmarkTrials";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-trials-test-"));
  return path.join(dir, "drift.sqlite3");
}

function tempWorkspaceTemplate(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-trials-template-"));
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

async function postStalledFirstTurn(port: number, sessionId: string, command: string, errorText: string): Promise<void> {
  await postJson(port, { session_id: sessionId, hook_event_name: "SessionStart" });
  await postJson(port, { session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "do the task" });
  for (let i = 0; i < 3; i++) {
    await postJson(port, { session_id: sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: `bench-c${i}` });
    await postJson(port, { session_id: sessionId, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, tool_use_id: `bench-c${i}`, tool_response: { error: errorText } });
  }
}

function validTaskDefinition(overrides: Partial<BenchmarkTaskDefinition> & { workspaceTemplate: string }): BenchmarkTaskDefinition {
  const candidate = {
    id: "trial-task",
    description: "A small, ordinary code-change task.",
    prompt: "do the task",
    claude: { model: "claude-test-model", allowedTools: ["Bash"], permissionMode: "bypassPermissions" },
    evaluator: { command: "true", timeoutMs: 5000 },
    expectedProperties: { category: "code_change" },
    ...overrides,
  };
  const result = validateBenchmarkTask(candidate);
  if (!result.success) throw new Error("test fixture task is invalid: " + JSON.stringify(result.errors));
  return result.task!;
}

/** A launcher that behaves "ordinarily" for control and, unless configured otherwise, for treatment too -- never triggers a redirect_candidate by default. */
function makeOrdinaryLauncher(storage: DriftStorage): ClaudeProcessLauncher {
  return async (options: ClaudeTurnOptions): Promise<ClaudeTurnResult> => {
    if (!options.resume) {
      const port = portFromInstalledSettings(options.workspaceDir);
      await postOrdinaryTurn(port, options.sessionId, storage);
    }
    return { success: true, error: undefined };
  };
}

/** A launcher where TREATMENT's first turn is engineered to genuinely trigger a redirect_candidate (real M8A finding + stub classification), and the resumed turn genuinely delivers it. Control stays ordinary. */
function makeRedirectingLauncher(storage: DriftStorage): ClaudeProcessLauncher {
  return async (options: ClaudeTurnOptions): Promise<ClaudeTurnResult> => {
    const isControl = options.workspaceDir.includes("control");
    const port = portFromInstalledSettings(options.workspaceDir);
    if (!options.resume) {
      if (isControl) await postOrdinaryTurn(port, options.sessionId, storage);
      else await postStalledFirstTurn(port, options.sessionId, "npm run migrate:prod", "ECONNREFUSED");
    } else {
      await postJson(port, { session_id: options.sessionId, hook_event_name: "UserPromptSubmit", prompt_id: "p2", prompt: options.prompt });
      await postJson(port, { session_id: options.sessionId, hook_event_name: "SessionEnd", reason: "clear" });
    }
    return { success: true, error: undefined };
  };
}

function baseTrialConfig(storage: DriftStorage, overrides: Partial<TrialRunnerConfig> = {}): TrialRunnerConfig {
  return {
    storage,
    modelRuntime: stubModelRuntime(() => ({ text: JSON.stringify(stalledRetryClassification) })),
    bridgeScriptPath: path.resolve(__dirname, "../../src/hookBridge.js"),
    launchClaudeTurn: makeOrdinaryLauncher(storage),
    approveRedirect: () => true,
    ...overrides,
  };
}

suite("benchmarkTrials (M14B)", () => {
  let storage: DriftStorage;
  let workspaceTemplate: string;

  setup(() => {
    storage = openStorage(tempDbPath());
    workspaceTemplate = tempWorkspaceTemplate({ "README.md": "hello trials\n" });
  });

  teardown(() => {
    storage.close();
  });

  test("N repetitions produce N independently identifiable pairs", async () => {
    const task = validTaskDefinition({ workspaceTemplate, id: "task-a" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 3, runnerConfig: baseTrialConfig(storage) });

    assert.strictEqual(output.trials.length, 3);
    assert.deepStrictEqual(output.trials.map((t) => t.repetitionIndex), [0, 1, 2]);
    assert.ok(output.trials.every((t) => t.taskId === "task-a"));

    const controlIds = output.trials.map((t) => t.controlSessionId);
    const treatmentIds = output.trials.map((t) => t.treatmentSessionId);
    const allIds = [...controlIds, ...treatmentIds];
    assert.strictEqual(new Set(allIds).size, allIds.length, "every session id across every repetition must be distinct");
  });

  test("every pair starts from the same canonical workspace fingerprint", async () => {
    const task = validTaskDefinition({ workspaceTemplate, id: "task-fp" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 3, runnerConfig: baseTrialConfig(storage) });

    const fingerprints = new Set(output.trials.map((t) => t.workspaceFingerprint));
    assert.strictEqual(fingerprints.size, 1, "all repetitions of one task must share exactly one fingerprint value");
    assert.match(output.trials[0].workspaceFingerprint, /^[0-9a-f]{64}$/);
  });

  test("session/workspace state is isolated across repetitions -- no repetition's workspace directory is reused", async () => {
    const seenWorkspaces: string[] = [];
    const launcher: ClaudeProcessLauncher = async (options) => {
      seenWorkspaces.push(options.workspaceDir);
      if (!options.resume) {
        const port = portFromInstalledSettings(options.workspaceDir);
        await postOrdinaryTurn(port, options.sessionId, storage);
      }
      return { success: true, error: undefined };
    };
    const task = validTaskDefinition({ workspaceTemplate, id: "task-iso" });
    await runBenchmarkTrials({ tasks: [task], repetitions: 3, runnerConfig: baseTrialConfig(storage, { launchClaudeTurn: launcher }) });

    assert.strictEqual(new Set(seenWorkspaces).size, seenWorkspaces.length, "every workspace directory used across all repetitions must be distinct");
  });

  test("run order alternates deterministically: repetition 0 control-first, repetition 1 treatment-first, repeat", async () => {
    const task = validTaskDefinition({ workspaceTemplate, id: "task-order" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 4, runnerConfig: baseTrialConfig(storage) });

    assert.deepStrictEqual(
      output.trials.map((t) => t.order),
      ["control-first", "treatment-first", "control-first", "treatment-first"]
    );
  });

  test("run order alternation actually changes wall-clock sequencing, not just a recorded label", async () => {
    const callSequence: string[] = [];
    const launcher: ClaudeProcessLauncher = async (options) => {
      callSequence.push(options.workspaceDir.includes("control") ? "control" : "treatment");
      if (!options.resume) {
        const port = portFromInstalledSettings(options.workspaceDir);
        await postOrdinaryTurn(port, options.sessionId, storage);
      }
      return { success: true, error: undefined };
    };
    const task = validTaskDefinition({ workspaceTemplate, id: "task-real-order" });
    await runBenchmarkTrials({ tasks: [task], repetitions: 2, runnerConfig: baseTrialConfig(storage, { launchClaudeTurn: launcher }) });

    assert.deepStrictEqual(callSequence, ["control", "treatment", "treatment", "control"]);
  });

  test("the task prompt/config remains identical across alternated orders", async () => {
    const seenPrompts: string[] = [];
    const seenSettings: unknown[] = [];
    const launcher: ClaudeProcessLauncher = async (options) => {
      if (!options.resume) {
        seenPrompts.push(options.prompt);
        seenSettings.push(options.settings);
        const port = portFromInstalledSettings(options.workspaceDir);
        await postOrdinaryTurn(port, options.sessionId, storage);
      }
      return { success: true, error: undefined };
    };
    const task = validTaskDefinition({ workspaceTemplate, id: "task-identical-config", prompt: "the exact same prompt" });
    await runBenchmarkTrials({ tasks: [task], repetitions: 2, runnerConfig: baseTrialConfig(storage, { launchClaudeTurn: launcher }) });

    assert.ok(seenPrompts.every((p) => p === "the exact same prompt"));
    const first = JSON.stringify(seenSettings[0]);
    assert.ok(seenSettings.every((s) => JSON.stringify(s) === first));
  });

  test("each completed pair with a delivered redirect is compared through the real M13B comparePairedRun()", async () => {
    const task = validTaskDefinition({ workspaceTemplate, id: "task-compared" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 1, runnerConfig: baseTrialConfig(storage, { launchClaudeTurn: makeRedirectingLauncher(storage) }) });

    const trial = output.trials[0];
    assert.strictEqual(trial.condition, "completed");
    assert.ok(trial.comparison, "a delivered redirect must produce a real comparison");
    assert.strictEqual(trial.comparison!.taskId, "task-compared");
    assert.strictEqual(trial.intervention.redirectCandidateOccurred, true);
    assert.strictEqual(trial.intervention.packetApproved, true);
    assert.strictEqual(trial.intervention.delivered, true);
    assert.strictEqual(trial.intervention.consumed, true);
  });

  test("no-intervention trials are preserved, not dropped, with an honest reason for the missing comparison", async () => {
    const task = validTaskDefinition({ workspaceTemplate, id: "task-no-candidate" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 1, runnerConfig: baseTrialConfig(storage) }); // ordinary launcher -- no redirect candidate ever emerges

    assert.strictEqual(output.trials.length, 1);
    const trial = output.trials[0];
    assert.strictEqual(trial.condition, "no_redirect_candidate");
    assert.strictEqual(trial.comparison, undefined);
    assert.ok(trial.comparisonUnavailableReason);
    assert.deepStrictEqual(trial.intervention, { redirectCandidateOccurred: false, packetApproved: false, delivered: false, consumed: false });
  });

  test("a control process failure is recorded as a distinct condition and the trial is preserved, not dropped", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      if (options.workspaceDir.includes("control")) return { success: false, error: "simulated control crash" };
      if (!options.resume) {
        const port = portFromInstalledSettings(options.workspaceDir);
        await postOrdinaryTurn(port, options.sessionId, storage);
      }
      return { success: true, error: undefined };
    };
    const task = validTaskDefinition({ workspaceTemplate, id: "task-control-fail" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 1, runnerConfig: baseTrialConfig(storage, { launchClaudeTurn: launcher }) });

    assert.strictEqual(output.trials.length, 1);
    assert.strictEqual(output.trials[0].condition, "control_process_failure");
    assert.strictEqual(output.trials[0].comparison, undefined);
  });

  test("a treatment process failure is recorded as a distinct condition and the trial is preserved", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      if (!options.workspaceDir.includes("control")) return { success: false, error: "simulated treatment crash" };
      const port = portFromInstalledSettings(options.workspaceDir);
      await postOrdinaryTurn(port, options.sessionId, storage);
      return { success: true, error: undefined };
    };
    const task = validTaskDefinition({ workspaceTemplate, id: "task-treatment-fail" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 1, runnerConfig: baseTrialConfig(storage, { launchClaudeTurn: launcher }) });

    assert.strictEqual(output.trials[0].condition, "treatment_process_failure");
  });

  test("an ordinary failing evaluator (nonzero exit) is NOT reported as evaluator_failure -- that condition is reserved for the evaluator machinery itself throwing", async () => {
    const task = validTaskDefinition({ workspaceTemplate, id: "task-eval-nonzero", evaluator: { command: "node -e \"process.exit(1)\"", timeoutMs: 5000 } });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 1, runnerConfig: baseTrialConfig(storage) });

    // A nonzero exit is a normal, objectively-FAILING evaluator result
    // (taskResult.passed === false), not an "evaluator_failure" condition --
    // that condition is reserved for the evaluator itself throwing (see
    // benchmarkRunner.ts's runEvaluator try/catch, already covered by
    // benchmarkRunner.test.ts's own "evaluator failure is recorded
    // explicitly" test with a directly-throwing TaskEvaluator; M14A's
    // runTaskEvaluator is deliberately non-throwing, so this condition is
    // not independently re-exercised at the M14B level).
    assert.strictEqual(output.trials[0].condition, "no_redirect_candidate", "an ordinary launcher never produces a candidate regardless of evaluator outcome");
    assert.strictEqual(output.trials[0].benchmarkResult.control.taskResult!.passed, false);
    assert.strictEqual(output.trials[0].benchmarkResult.control.evaluatorError, undefined);
  });

  test("an approved-but-undelivered redirect is recorded as its own distinct condition", async () => {
    const launcher: ClaudeProcessLauncher = async (options) => {
      const isControl = options.workspaceDir.includes("control");
      if (!options.resume) {
        if (isControl) {
          const port = portFromInstalledSettings(options.workspaceDir);
          await postOrdinaryTurn(port, options.sessionId, storage);
        } else {
          const port = portFromInstalledSettings(options.workspaceDir);
          await postStalledFirstTurn(port, options.sessionId, "helm rollback", "revision not found");
        }
      }
      // resumed turn deliberately never posts UserPromptSubmit -- simulates the CLI succeeding without the hook firing.
      return { success: true, error: undefined };
    };
    const task = validTaskDefinition({ workspaceTemplate, id: "task-undelivered" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 1, runnerConfig: baseTrialConfig(storage, { launchClaudeTurn: launcher }) });

    assert.strictEqual(output.trials[0].condition, "redirect_approved_not_delivered");
    assert.strictEqual(output.trials[0].intervention.redirectCandidateOccurred, true);
    assert.strictEqual(output.trials[0].intervention.packetApproved, true);
    assert.strictEqual(output.trials[0].intervention.delivered, false);
    assert.strictEqual(output.trials[0].comparison, undefined);
  });

  test("a redirect_candidate that the harness declines to approve is recorded as 'completed' (nothing infrastructurally failed), with intervention flags showing exactly how far it got", async () => {
    const task = validTaskDefinition({ workspaceTemplate, id: "task-rejected" });
    const output = await runBenchmarkTrials({
      tasks: [task],
      repetitions: 1,
      runnerConfig: baseTrialConfig(storage, { launchClaudeTurn: makeRedirectingLauncher(storage), approveRedirect: () => false }),
    });

    const trial = output.trials[0];
    assert.strictEqual(trial.condition, "completed");
    assert.strictEqual(trial.intervention.redirectCandidateOccurred, true);
    assert.strictEqual(trial.intervention.packetApproved, false);
    assert.strictEqual(trial.intervention.delivered, false);
    assert.strictEqual(trial.intervention.consumed, false);
    assert.strictEqual(trial.comparison, undefined, "no redirect was delivered, so there is nothing to compare");
  });

  test("result ordering is deterministic across multiple tasks: task order, then repetition order", async () => {
    const taskA = validTaskDefinition({ workspaceTemplate, id: "task-A" });
    const taskB = validTaskDefinition({ workspaceTemplate, id: "task-B" });
    const output = await runBenchmarkTrials({ tasks: [taskA, taskB], repetitions: 2, runnerConfig: baseTrialConfig(storage) });

    assert.deepStrictEqual(
      output.trials.map((t) => `${t.taskId}#${t.repetitionIndex}`),
      ["task-A#0", "task-A#1", "task-B#0", "task-B#1"]
    );
  });

  test("maxRepetitions clamps requested repetitions and is reported honestly", async () => {
    const task = validTaskDefinition({ workspaceTemplate, id: "task-clamped" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 10, runnerConfig: baseTrialConfig(storage, { maxRepetitions: 2 }) });

    assert.strictEqual(output.requestedRepetitions, 10);
    assert.strictEqual(output.effectiveRepetitions, 2);
    assert.strictEqual(output.trials.length, 2);
  });

  test("does not clamp when maxRepetitions is not set", async () => {
    const task = validTaskDefinition({ workspaceTemplate, id: "task-no-clamp" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 3, runnerConfig: baseTrialConfig(storage) });
    assert.strictEqual(output.effectiveRepetitions, 3);
  });

  test("stops immediately on an explicit infrastructure failure (runMatchedBenchmark throwing), without attempting further repetitions", async () => {
    const badTask = validTaskDefinition({ workspaceTemplate: "/this/path/definitely/does/not/exist/anywhere", id: "task-broken-template" });
    const output = await runBenchmarkTrials({ tasks: [badTask], repetitions: 5, runnerConfig: baseTrialConfig(storage) });

    assert.strictEqual(output.trials.length, 0, "no trial should have completed once the very first one hit an infrastructure failure");
    assert.ok(output.stoppedDueToInfrastructureFailure);
    assert.strictEqual(output.stoppedDueToInfrastructureFailure!.taskId, "task-broken-template");
    assert.strictEqual(output.stoppedDueToInfrastructureFailure!.repetitionIndex, 0);
  });

  test("does NOT stop early merely because a normal trial's result looks bad (a single failed Claude call is not an infrastructure failure)", async () => {
    let callCount = 0;
    const launcher: ClaudeProcessLauncher = async (options) => {
      callCount++;
      if (options.workspaceDir.includes("control") && !options.resume) {
        return { success: false, error: "one bad control call" };
      }
      if (!options.resume) {
        const port = portFromInstalledSettings(options.workspaceDir);
        await postOrdinaryTurn(port, options.sessionId, storage);
      }
      return { success: true, error: undefined };
    };
    const task = validTaskDefinition({ workspaceTemplate, id: "task-continues" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 3, runnerConfig: baseTrialConfig(storage, { launchClaudeTurn: launcher }) });

    assert.strictEqual(output.trials.length, 3, "all 3 repetitions must still run despite every control call failing");
    assert.strictEqual(output.stoppedDueToInfrastructureFailure, undefined);
    assert.ok(output.trials.every((t) => t.condition === "control_process_failure"));
  });

  test("raw per-trial results are returned in full, never averaged or collapsed", async () => {
    const task = validTaskDefinition({ workspaceTemplate, id: "task-raw" });
    const output = await runBenchmarkTrials({ tasks: [task], repetitions: 2, runnerConfig: baseTrialConfig(storage) });

    for (const trial of output.trials) {
      assert.ok(trial.benchmarkResult, "the full raw M13C result must be present on every trial");
      assert.strictEqual(typeof trial.benchmarkResult.control.usage, "object");
    }
    // No aggregate/summary field exists anywhere on the output.
    const outputKeys = Object.keys(output);
    for (const forbidden of ["average", "mean", "median", "aggregate", "score", "confidence"]) {
      assert.ok(!outputKeys.some((k) => k.toLowerCase().includes(forbidden)), `found forbidden aggregate-looking key containing "${forbidden}"`);
    }
  });
});
