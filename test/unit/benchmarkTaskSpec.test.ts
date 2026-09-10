import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage, DriftStorage } from "../../src/storage";
import { normalizeRawEvent } from "../../src/normalizedEvent";
import { buildTrajectory } from "../../src/trajectory";
import { attributeUsageToTrajectory } from "../../src/trajectoryUsageAttribution";
import {
  validateBenchmarkTask,
  validateBenchmarkTaskSet,
  loadBenchmarkTaskFile,
  loadBenchmarkTaskSetFile,
  computeWorkspaceFingerprint,
  runTaskEvaluator,
  BenchmarkTaskDefinition,
} from "../../src/benchmarkTaskSpec";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function validTask(overrides: Partial<BenchmarkTaskDefinition> = {}): unknown {
  return {
    id: "fix-sum-bug",
    description: "Fix an off-by-operator bug in sum.js so the existing test passes.",
    workspaceTemplate: "/tmp/does-not-need-to-exist-for-structural-validation",
    prompt: "Fix the implementation so the existing tests pass. Run the tests to verify.",
    claude: { model: "claude-sonnet-5", allowedTools: ["Bash", "Edit", "Read"], permissionMode: "bypassPermissions" },
    evaluator: { command: "node test.js", timeoutMs: 30000 },
    expectedProperties: { category: "bug_fix", difficulty: "easy" },
    ...overrides,
  };
}

suite("benchmarkTaskSpec (M14A) - validateBenchmarkTask", () => {
  test("a well-formed task definition is accepted", () => {
    const result = validateBenchmarkTask(validTask());
    assert.strictEqual(result.success, true, JSON.stringify(result.errors));
    assert.ok(result.task);
    assert.strictEqual(result.task!.id, "fix-sum-bug");
  });

  test("rejects a non-object candidate", () => {
    for (const bad of [null, undefined, "a string", 42, ["array"]]) {
      const result = validateBenchmarkTask(bad);
      assert.strictEqual(result.success, false);
      assert.ok(result.errors.length > 0);
    }
  });

  test("rejects missing prompt", () => {
    const result = validateBenchmarkTask(validTask({ prompt: undefined as unknown as string }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("prompt")));
  });

  test("rejects missing workspace", () => {
    const result = validateBenchmarkTask(validTask({ workspaceTemplate: undefined as unknown as string }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("workspaceTemplate")));
  });

  test("rejects missing evaluator", () => {
    const result = validateBenchmarkTask(validTask({ evaluator: undefined as unknown as BenchmarkTaskDefinition["evaluator"] }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("evaluator")));
  });

  test("rejects an empty evaluator command", () => {
    const result = validateBenchmarkTask(validTask({ evaluator: { command: "   ", timeoutMs: 1000 } }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("evaluator.command")));
  });

  test("rejects an unsupported Claude permission mode", () => {
    const result = validateBenchmarkTask(validTask({ claude: { model: "claude-sonnet-5", allowedTools: [], permissionMode: "godMode" } }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("permissionMode")));
  });

  test("accepts every real, documented Claude Code permission mode", () => {
    for (const mode of ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]) {
      const result = validateBenchmarkTask(validTask({ claude: { model: "claude-sonnet-5", allowedTools: [], permissionMode: mode } }));
      assert.strictEqual(result.success, true, `${mode} should be accepted: ${JSON.stringify(result.errors)}`);
    }
  });

  test("rejects a non-array/non-string allowedTools", () => {
    const result = validateBenchmarkTask(validTask({ claude: { model: "x", allowedTools: "Bash" as unknown as string[], permissionMode: "bypassPermissions" } }));
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("allowedTools")));
  });

  test("rejects a non-positive evaluator timeoutMs", () => {
    for (const bad of [0, -100, NaN, Infinity]) {
      const result = validateBenchmarkTask(validTask({ evaluator: { command: "node test.js", timeoutMs: bad } }));
      assert.strictEqual(result.success, false, `timeoutMs=${bad} should be rejected`);
    }
  });

  test("expectedProperties is optional -- a task without it is still valid", () => {
    const candidate = validTask() as Record<string, unknown>;
    delete candidate.expectedProperties;
    const result = validateBenchmarkTask(candidate);
    assert.strictEqual(result.success, true, JSON.stringify(result.errors));
  });

  test("expectedProperties.category/difficulty are free-form descriptive strings -- any value is accepted as metadata", () => {
    for (const category of ["bug_fix", "test_failure", "debugging", "code_change", "repository_navigation", "something_entirely_new"]) {
      const result = validateBenchmarkTask(validTask({ expectedProperties: { category, difficulty: "medium" } }));
      assert.strictEqual(result.success, true, `${category} should be accepted as free-form metadata: ${JSON.stringify(result.errors)}`);
    }
  });

  test("collects every problem at once rather than stopping at the first", () => {
    const result = validateBenchmarkTask({ id: "", description: "", workspaceTemplate: "", prompt: "", claude: {}, evaluator: {} });
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.length >= 5, `expected many errors, got ${result.errors.length}: ${JSON.stringify(result.errors)}`);
  });

  suite("requirement 7: no intervention-targeted task text", () => {
    const forbiddenPrompts = [
      "Run the failing command and repeat this failure three times before giving up.",
      "Keep retrying the same command even if it fails.",
      "This task exists to trigger Drift's redirect system.",
      "The goal of this task is to cause a redirect_candidate classification.",
    ];
    for (const prompt of forbiddenPrompts) {
      test(`rejects a prompt encoding an intervention-manufacturing instruction: "${prompt.slice(0, 40)}..."`, () => {
        const result = validateBenchmarkTask(validTask({ prompt }));
        assert.strictEqual(result.success, false);
      });
    }

    test("rejects the same forbidden phrasing when it appears in description instead of prompt", () => {
      const result = validateBenchmarkTask(validTask({ description: "A task designed to trigger drift.", prompt: "Fix the bug." }));
      assert.strictEqual(result.success, false);
    });

    test("does NOT reject an ordinary task that merely mentions retry logic as the subject of normal work", () => {
      const result = validateBenchmarkTask(
        validTask({
          description: "Fix a bug in the retry logic that causes duplicate network calls.",
          prompt: "The retry() function in client.js retries forever on failure. Fix it so it stops after 3 attempts and returns an error.",
        })
      );
      assert.strictEqual(result.success, true, JSON.stringify(result.errors));
    });
  });

  suite("requirement 8: no expected-savings fields", () => {
    const forbiddenFields = ["expectedTokenReduction", "expectedRedirect", "expectedWaste", "sustainabilityTarget", "expectedSavings", "energyTarget", "avoidedWaste"];
    for (const field of forbiddenFields) {
      test(`rejects a top-level "${field}" field`, () => {
        const result = validateBenchmarkTask({ ...(validTask() as object), [field]: 42 });
        assert.strictEqual(result.success, false);
        assert.ok(result.errors.some((e) => e.includes(field)));
      });

      test(`rejects "${field}" nested inside expectedProperties`, () => {
        const result = validateBenchmarkTask(validTask({ expectedProperties: { category: "bug_fix", [field]: 42 } as any }));
        assert.strictEqual(result.success, false);
      });
    }
  });

  suite("requirement 6: no treatment-specific configuration", () => {
    const forbiddenFields = ["treatmentPrompt", "controlPrompt", "treatmentConfig", "controlConfig", "treatmentModel"];
    for (const field of forbiddenFields) {
      test(`rejects a top-level "${field}" field`, () => {
        const result = validateBenchmarkTask({ ...(validTask() as object), [field]: "something" });
        assert.strictEqual(result.success, false);
        assert.ok(result.errors.some((e) => e.includes(field)));
      });
    }
  });

  test("volatileFiles, when present, must be an array of non-empty strings", () => {
    const good = validateBenchmarkTask(validTask({ volatileFiles: ["node_modules/.cache", ".DS_Store"] } as any));
    assert.strictEqual(good.success, true, JSON.stringify(good.errors));
    const bad = validateBenchmarkTask(validTask({ volatileFiles: [123] } as any));
    assert.strictEqual(bad.success, false);
  });

  test("same validated task guarantees identical prompt/claude config for both control and treatment -- there is only ever one of each field", () => {
    const result = validateBenchmarkTask(validTask());
    assert.strictEqual(result.success, true);
    const task = result.task!;
    // A future control run and a future treatment run would each read
    // task.prompt/task.claude from this SAME object -- there is no separate
    // "treatment" variant anywhere in the type, so they are identical by
    // construction, not by a runtime check.
    const controlPrompt = task.prompt;
    const treatmentPrompt = task.prompt;
    const controlClaude = task.claude;
    const treatmentClaude = task.claude;
    assert.strictEqual(controlPrompt, treatmentPrompt);
    assert.strictEqual(controlClaude, treatmentClaude);
  });
});

suite("benchmarkTaskSpec (M14A) - validateBenchmarkTaskSet", () => {
  test("accepts a set of distinctly-id'd valid tasks", () => {
    const result = validateBenchmarkTaskSet([validTask({ id: "task-1" }), validTask({ id: "task-2" })]);
    assert.strictEqual(result.success, true, JSON.stringify(result.errors));
    assert.strictEqual(result.tasks!.length, 2);
  });

  test("rejects a duplicate task id across the set, even when both definitions are individually valid", () => {
    const result = validateBenchmarkTaskSet([validTask({ id: "dup" }), validTask({ id: "dup" })]);
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.includes("duplicate") && e.includes("dup")));
  });

  test("aggregates errors from multiple invalid tasks in the set, each identified by index", () => {
    const result = validateBenchmarkTaskSet([validTask({ prompt: undefined as unknown as string }), validTask({ evaluator: { command: "", timeoutMs: 1 } })]);
    assert.strictEqual(result.success, false);
    assert.ok(result.errors.some((e) => e.startsWith("task[0]:")));
    assert.ok(result.errors.some((e) => e.startsWith("task[1]:")));
  });
});

suite("benchmarkTaskSpec (M14A) - loadBenchmarkTaskFile / loadBenchmarkTaskSetFile", () => {
  test("loads and validates a well-formed single-task JSON file deterministically", () => {
    const dir = tempDir("drift-task-file-");
    const filePath = path.join(dir, "task.json");
    fs.writeFileSync(filePath, JSON.stringify(validTask()), "utf8");

    const first = loadBenchmarkTaskFile(filePath);
    const second = loadBenchmarkTaskFile(filePath);
    assert.strictEqual(first.success, true, JSON.stringify(first.errors));
    assert.deepStrictEqual(first, second);
  });

  test("reports a clear error for malformed JSON rather than throwing", () => {
    const dir = tempDir("drift-task-file-");
    const filePath = path.join(dir, "bad.json");
    fs.writeFileSync(filePath, "{ not valid json", "utf8");

    const result = loadBenchmarkTaskFile(filePath);
    assert.strictEqual(result.success, false);
    assert.ok(result.errors[0].includes("not valid JSON"));
  });

  test("reports a clear error for a missing file rather than throwing", () => {
    const result = loadBenchmarkTaskFile("/tmp/definitely-does-not-exist-drift-task.json");
    assert.strictEqual(result.success, false);
    assert.ok(result.errors[0].includes("could not read"));
  });

  test("loads a JSON array of task definitions and validates the whole set, including duplicate ids", () => {
    const dir = tempDir("drift-taskset-file-");
    const filePath = path.join(dir, "tasks.json");
    fs.writeFileSync(filePath, JSON.stringify([validTask({ id: "a" }), validTask({ id: "b" })]), "utf8");

    const result = loadBenchmarkTaskSetFile(filePath);
    assert.strictEqual(result.success, true, JSON.stringify(result.errors));
    assert.strictEqual(result.tasks!.length, 2);
  });

  test("rejects a task-set file that isn't a JSON array", () => {
    const dir = tempDir("drift-taskset-file-");
    const filePath = path.join(dir, "not-an-array.json");
    fs.writeFileSync(filePath, JSON.stringify(validTask()), "utf8");

    const result = loadBenchmarkTaskSetFile(filePath);
    assert.strictEqual(result.success, false);
    assert.ok(result.errors[0].includes("array"));
  });
});

suite("benchmarkTaskSpec (M14A) - computeWorkspaceFingerprint", () => {
  test("is stable: the same template content always produces the same fingerprint", () => {
    const dir = tempDir("drift-fp-");
    fs.writeFileSync(path.join(dir, "a.js"), "content-a", "utf8");
    fs.writeFileSync(path.join(dir, "b.js"), "content-b", "utf8");

    const first = computeWorkspaceFingerprint(dir);
    const second = computeWorkspaceFingerprint(dir);
    assert.strictEqual(first, second);
    assert.strictEqual(typeof first, "string");
    assert.ok(first.length > 0);
  });

  test("changing file content changes the fingerprint", () => {
    const dir = tempDir("drift-fp-");
    fs.writeFileSync(path.join(dir, "a.js"), "content-a", "utf8");
    const before = computeWorkspaceFingerprint(dir);

    fs.writeFileSync(path.join(dir, "a.js"), "content-a-modified", "utf8");
    const after = computeWorkspaceFingerprint(dir);

    assert.notStrictEqual(before, after);
  });

  test("two structurally identical templates in different directories produce the same fingerprint -- content-based, not path-based", () => {
    const dirA = tempDir("drift-fp-a-");
    const dirB = tempDir("drift-fp-b-");
    fs.writeFileSync(path.join(dirA, "a.js"), "same content", "utf8");
    fs.writeFileSync(path.join(dirB, "a.js"), "same content", "utf8");

    assert.strictEqual(computeWorkspaceFingerprint(dirA), computeWorkspaceFingerprint(dirB));
  });

  test("nested directories are included, and traversal order does not affect the result", () => {
    const dir = tempDir("drift-fp-nested-");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "z.js"), "z", "utf8");
    fs.writeFileSync(path.join(dir, "sub", "a.js"), "nested", "utf8");

    const fingerprint1 = computeWorkspaceFingerprint(dir);

    const dir2 = tempDir("drift-fp-nested-2-");
    fs.writeFileSync(path.join(dir2, "z.js"), "z", "utf8");
    fs.mkdirSync(path.join(dir2, "sub"));
    fs.writeFileSync(path.join(dir2, "sub", "a.js"), "nested", "utf8");

    assert.strictEqual(fingerprint1, computeWorkspaceFingerprint(dir2));
  });

  test("explicitly declared volatile files are ignored -- changing them never changes the fingerprint", () => {
    const dir = tempDir("drift-fp-volatile-");
    fs.writeFileSync(path.join(dir, "sum.js"), "function sum(a,b){return a-b;}", "utf8");
    fs.writeFileSync(path.join(dir, ".cache"), "anything", "utf8");

    const before = computeWorkspaceFingerprint(dir, [".cache"]);
    fs.writeFileSync(path.join(dir, ".cache"), "completely different content", "utf8");
    const after = computeWorkspaceFingerprint(dir, [".cache"]);

    assert.strictEqual(before, after, "declared-volatile file changes must never affect the fingerprint");
  });

  test("a file NOT declared volatile still affects the fingerprint even if it looks like a cache file", () => {
    const dir = tempDir("drift-fp-nonvolatile-");
    fs.writeFileSync(path.join(dir, ".cache"), "v1", "utf8");
    const before = computeWorkspaceFingerprint(dir); // no volatileFiles declared
    fs.writeFileSync(path.join(dir, ".cache"), "v2", "utf8");
    const after = computeWorkspaceFingerprint(dir);

    assert.notStrictEqual(before, after, "only EXPLICITLY declared volatile files may be ignored");
  });

  test("a nested volatile file path (relative, with a slash) is correctly excluded", () => {
    const dir = tempDir("drift-fp-nested-volatile-");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "cache.log"), "v1", "utf8");
    fs.writeFileSync(path.join(dir, "real.js"), "real", "utf8");

    const before = computeWorkspaceFingerprint(dir, ["sub/cache.log"]);
    fs.writeFileSync(path.join(dir, "sub", "cache.log"), "v2", "utf8");
    const after = computeWorkspaceFingerprint(dir, ["sub/cache.log"]);

    assert.strictEqual(before, after);
  });
});

suite("benchmarkTaskSpec (M14A) - runTaskEvaluator", () => {
  test("passed is true exactly when the evaluator command exits 0", () => {
    const dir = tempDir("drift-eval-");
    fs.writeFileSync(path.join(dir, "test.js"), "process.exit(0);", "utf8");
    const task = validateBenchmarkTask(validTask({ workspaceTemplate: dir, evaluator: { command: "node test.js", timeoutMs: 10000 } })).task!;

    const result = runTaskEvaluator(task, dir);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.exitCode, 0);
  });

  test("passed is false when the evaluator command exits non-zero", () => {
    const dir = tempDir("drift-eval-");
    fs.writeFileSync(path.join(dir, "test.js"), "process.exit(1);", "utf8");
    const task = validateBenchmarkTask(validTask({ workspaceTemplate: dir, evaluator: { command: "node test.js", timeoutMs: 10000 } })).task!;

    const result = runTaskEvaluator(task, dir);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.exitCode, 1);
  });

  test("checksPassed/checksTotal always stay undefined for the command-exit-status evaluator -- never parsed or guessed from output", () => {
    const dir = tempDir("drift-eval-");
    fs.writeFileSync(path.join(dir, "test.js"), "console.log('3 passed, 0 failed'); process.exit(0);", "utf8");
    const task = validateBenchmarkTask(validTask({ workspaceTemplate: dir, evaluator: { command: "node test.js", timeoutMs: 10000 } })).task!;

    const result = runTaskEvaluator(task, dir);
    assert.strictEqual(result.checksPassed, undefined);
    assert.strictEqual(result.checksTotal, undefined);
  });

  test("evaluatorName reflects the evaluator's own command", () => {
    const dir = tempDir("drift-eval-");
    fs.writeFileSync(path.join(dir, "test.js"), "process.exit(0);", "utf8");
    const task = validateBenchmarkTask(validTask({ workspaceTemplate: dir, evaluator: { command: "node test.js", timeoutMs: 10000 } })).task!;

    const result = runTaskEvaluator(task, dir);
    assert.strictEqual(result.evaluatorName, "node test.js");
  });

  test("a command that never exists (spawn failure) is reported as a failing result, not thrown", () => {
    const dir = tempDir("drift-eval-");
    const task = validateBenchmarkTask(validTask({ workspaceTemplate: dir, evaluator: { command: "this-command-does-not-exist-anywhere-12345", timeoutMs: 5000 } })).task!;

    assert.doesNotThrow(() => runTaskEvaluator(task, dir));
    const result = runTaskEvaluator(task, dir);
    assert.strictEqual(result.passed, false);
  });

  test("a command that exceeds timeoutMs is reported as timed out and failing, not thrown", () => {
    const dir = tempDir("drift-eval-");
    fs.writeFileSync(path.join(dir, "slow.js"), "setTimeout(() => process.exit(0), 5000);", "utf8");
    const task = validateBenchmarkTask(validTask({ workspaceTemplate: dir, evaluator: { command: "node slow.js", timeoutMs: 200 } })).task!;

    const result = runTaskEvaluator(task, dir);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.timedOut, true);
  });

  test("success is never inferred from anything but the evaluator's own exit code -- Claude/session/hook data is irrelevant and untouched", () => {
    const dbDir = tempDir("drift-eval-storage-");
    const storage: DriftStorage = openStorage(path.join(dbDir, "drift.sqlite3"));
    const sessionId = "eval-isolation-session";
    storage.ensureSession(sessionId);
    // A session whose OWN hook/trajectory data would look like a clean success (a SessionEnd with no failure, no findings) -- irrelevant to the evaluator.
    storage.insertRawEvent(sessionId, { hook_event_name: "SessionEnd", reason: "clear" }, Date.now());

    const dir = tempDir("drift-eval-");
    fs.writeFileSync(path.join(dir, "test.js"), "process.exit(1);", "utf8"); // the workspace itself objectively fails
    const task = validateBenchmarkTask(validTask({ workspaceTemplate: dir, evaluator: { command: "node test.js", timeoutMs: 10000 } })).task!;

    const result = runTaskEvaluator(task, dir);
    assert.strictEqual(result.passed, false, "the workspace's real test failure must be reflected regardless of a clean-looking session");
    storage.close();
  });

  test("evaluator execution never alters the usage already attributed to the Claude run", () => {
    const dbDir = tempDir("drift-eval-usage-");
    const storage: DriftStorage = openStorage(path.join(dbDir, "drift.sqlite3"));
    const sessionId = "eval-usage-isolation-session";
    storage.ensureSession(sessionId);
    storage.insertRawEvent(sessionId, { hook_event_name: "UserPromptSubmit", prompt_id: "p1" }, 100);
    storage.insertModelUsageEvent(
      sessionId,
      { attributes: [{ key: "session.id", value: { stringValue: sessionId } }, { key: "prompt.id", value: { stringValue: "p1" } }, { key: "input_tokens", value: { intValue: "500" } }] },
      110
    );

    function usageNow() {
      const sessionData = storage.getSession(sessionId);
      const normalized = (sessionData?.events ?? []).map(normalizeRawEvent);
      const trajectory = buildTrajectory(sessionId, normalized);
      return attributeUsageToTrajectory(trajectory, storage).sessionTotals;
    }

    const before = usageNow();

    const dir = tempDir("drift-eval-");
    fs.writeFileSync(path.join(dir, "test.js"), "process.exit(0);", "utf8");
    const task = validateBenchmarkTask(validTask({ workspaceTemplate: dir, evaluator: { command: "node test.js", timeoutMs: 10000 } })).task!;
    runTaskEvaluator(task, dir);

    const after = usageNow();
    assert.deepStrictEqual(before, after, "running the evaluator must not change the Claude session's own attributed usage in any way");
    storage.close();
  });
});
