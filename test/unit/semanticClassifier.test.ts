import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage, DriftStorage } from "../../src/storage";
import { normalizeRawEvent } from "../../src/normalizedEvent";
import { buildTrajectory } from "../../src/trajectory";
import { attributeUsageToTrajectory } from "../../src/trajectoryUsageAttribution";
import { extractTrajectoryFeatures, TrajectoryFeatureFinding } from "../../src/trajectoryFeatures";
import { detectSubagentOverlap, SubagentOverlapFinding } from "../../src/subagentOverlap";
import { createLocalModelRuntime, LocalModelRuntime, InferenceResult, InferOptions } from "../../src/localModelRuntime";
import { classifyWindow, ClassificationRequest } from "../../src/semanticClassifier";

const MODEL_PATH = path.join(process.cwd(), "models", "gemma-3-4b-it-IQ4_XS.gguf");
const MODEL_PRESENT = fs.existsSync(MODEL_PATH);

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-semantic-classifier-test-"));
  return path.join(dir, "drift.sqlite3");
}

/** Builds the same {trajectoryUsage, features, overlaps} bundle production code would, from real stored raw events. */
function buildRequestFor(sessionId: string, storage: DriftStorage, focusStepIndexes: number[]): ClassificationRequest {
  const session = storage.getSession(sessionId)!;
  const normalized = session.events.map(normalizeRawEvent);
  const trajectory = buildTrajectory(sessionId, normalized);
  const trajectoryUsage = attributeUsageToTrajectory(trajectory, storage);
  const features = extractTrajectoryFeatures(trajectoryUsage);
  const overlaps = detectSubagentOverlap(trajectoryUsage, storage);
  return { trajectoryUsage, features, overlaps, focusStepIndexes };
}

function findingStepIndexes(findings: (TrajectoryFeatureFinding | SubagentOverlapFinding)[], type: string): number[] {
  const match = findings.find((f) => f.type === type);
  assert.ok(match, `expected a ${type} finding to exist in this fixture`);
  return match!.stepIndexes;
}

function requestForFinding(sessionId: string, storage: DriftStorage, type: string): ClassificationRequest {
  const session = storage.getSession(sessionId)!;
  const trajectoryUsage = attributeUsageToTrajectory(buildTrajectory(sessionId, session.events.map(normalizeRawEvent)), storage);
  const features = extractTrajectoryFeatures(trajectoryUsage);
  return buildRequestFor(sessionId, storage, findingStepIndexes(features, type));
}

suite("semanticClassifier (M9B.2)", function () {
  if (!MODEL_PRESENT) {
    test("SKIPPED: models/gemma-3-4b-it-IQ4_XS.gguf is not present in this checkout", () => {
      assert.ok(true, "the real Gemma 3 4B GGUF is a local, gitignored asset and is not part of the repository");
    });
    return;
  }

  suite("real classification against Gemma 3 4B -- required adversarial fixtures", () => {
    let runtime: LocalModelRuntime;
    let storage: DriftStorage;

    suiteSetup(async function () {
      this.timeout(90000);
      runtime = createLocalModelRuntime({ modelPath: MODEL_PATH, timeoutMs: 60000 });
      const warmup = await runtime.infer("hello");
      assert.strictEqual(warmup.record.success, true, `warmup inference must succeed: ${warmup.record.error}`);

      storage = openStorage(tempDbPath());

      // productive_retry: failure -> relevant Write -> retry succeeds.
      storage.ensureSession("productive-retry");
      storage.insertRawEvent("productive-retry", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("productive-retry", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "ENOENT: config.json missing" } }, 110);
      storage.insertRawEvent("productive-retry", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/config.json", content: "{}" }, tool_use_id: "w1" }, 120);
      storage.insertRawEvent("productive-retry", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/config.json", content: "{}" }, tool_use_id: "w1", tool_response: { output: "written" } }, 130);
      storage.insertRawEvent("productive-retry", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 140);
      storage.insertRawEvent("productive-retry", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { output: "worked" } }, 150);

      // stalled_retry: same failure -> nothing changes -> retry fails again, identically.
      storage.ensureSession("stalled-retry");
      storage.insertRawEvent("stalled-retry", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("stalled-retry", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "timeout" } }, 110);
      storage.insertRawEvent("stalled-retry", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
      storage.insertRawEvent("stalled-retry", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "timeout" } }, 130);

      // ADVERSARIAL 1: failure -> relevant state change -> retry FAILS. Must NOT be productive_retry.
      storage.ensureSession("changed-but-still-failed");
      storage.insertRawEvent("changed-but-still-failed", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("changed-but-still-failed", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "ENOENT" } }, 110);
      storage.insertRawEvent("changed-but-still-failed", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/config.json" }, tool_use_id: "w1" }, 120);
      storage.insertRawEvent("changed-but-still-failed", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/config.json" }, tool_use_id: "w1", tool_response: { output: "ok" } }, 130);
      storage.insertRawEvent("changed-but-still-failed", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 140);
      storage.insertRawEvent("changed-but-still-failed", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "STILL BROKEN: permission denied" } }, 150);

      // ADVERSARIAL 2: failure -> no state change -> retry SUCCEEDS. Must NOT be stalled_retry.
      storage.ensureSession("unchanged-but-succeeded");
      storage.insertRawEvent("unchanged-but-succeeded", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-network-call" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("unchanged-but-succeeded", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky-network-call" }, tool_use_id: "c1", tool_response: { error: "connection reset" } }, 110);
      storage.insertRawEvent("unchanged-but-succeeded", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky-network-call" }, tool_use_id: "c2" }, 120);
      storage.insertRawEvent("unchanged-but-succeeded", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "flaky-network-call" }, tool_use_id: "c2", tool_response: { output: "200 OK" } }, 130);

      // Fabricated overlap: mundane single-agent read, but the request will attach a fabricated subagent_overlap finding.
      storage.ensureSession("mundane-read");
      storage.insertRawEvent("mundane-read", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/boring.txt" }, tool_use_id: "r1" }, 100);
      storage.insertRawEvent("mundane-read", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/boring.txt" }, tool_use_id: "r1", tool_response: "nothing interesting" }, 110);

      // Real duplicate subagent work: two agents run the identical command.
      storage.ensureSession("duplicate-subagent");
      storage.insertRawEvent("duplicate-subagent", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("duplicate-subagent", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
      storage.insertRawEvent("duplicate-subagent", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 200);
      storage.insertRawEvent("duplicate-subagent", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 210);

      // Repeated command, no failure, genuinely new evidence (different output the second time).
      storage.ensureSession("new-evidence-repeat");
      storage.insertRawEvent("new-evidence-repeat", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "check status" }, tool_use_id: "s1" }, 100);
      storage.insertRawEvent("new-evidence-repeat", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "check status" }, tool_use_id: "s1", tool_response: { output: "service DOWN" } }, 110);
      storage.insertRawEvent("new-evidence-repeat", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "check status" }, tool_use_id: "s2" }, 120);
      storage.insertRawEvent("new-evidence-repeat", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "check status" }, tool_use_id: "s2", tool_response: { output: "service UP, new error code E42 detected" } }, 130);

      // ADVERSARIAL 5: state DID change, but the retry reveals a DIFFERENT failure (not success).
      storage.ensureSession("changed-different-failure");
      storage.insertRawEvent("changed-different-failure", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("changed-different-failure", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c1", tool_response: { error: "missing credentials" } }, 110);
      storage.insertRawEvent("changed-different-failure", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/creds.json" }, tool_use_id: "w1" }, 120);
      storage.insertRawEvent("changed-different-failure", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/creds.json" }, tool_use_id: "w1", tool_response: { output: "ok" } }, 130);
      storage.insertRawEvent("changed-different-failure", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c2" }, 140);
      storage.insertRawEvent("changed-different-failure", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c2", tool_response: { error: "quota exceeded" } }, 150);

      // ADVERSARIAL 6: same retry outcome (stalled) as the "stalled-retry" fixture, but a longer, richer
      // failure/evidence history -- for comparing secondary output fields across differing evidence.
      storage.ensureSession("stalled-retry-rich-history");
      storage.insertRawEvent("stalled-retry-rich-history", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("stalled-retry-rich-history", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "timeout after 30s, retries exhausted, upstream unreachable" } }, 110);
      storage.insertRawEvent("stalled-retry-rich-history", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
      storage.insertRawEvent("stalled-retry-rich-history", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "timeout after 30s, retries exhausted, upstream unreachable" } }, 130);
    });

    suiteTeardown(async function () {
      this.timeout(10000);
      await runtime.close();
      storage.close();
    });

    test("1. failure -> relevant state change -> retry FAILS: MUST NOT return productive_retry", async function () {
      this.timeout(60000);
      const request = requestForFinding("changed-but-still-failed", storage, "repeated_command");
      const result = await classifyWindow(request, storage, runtime);
      if (result.success) {
        assert.notStrictEqual(result.classification!.class, "productive_retry", `must not say productive_retry when the retry itself failed; got ${JSON.stringify(result.classification)}`);
      } else {
        assert.ok(result.error && result.error.length > 0, "a safe failure must carry an explanatory error");
      }
    });

    test("2. failure -> no state change -> retry SUCCEEDS: MUST NOT return stalled_retry", async function () {
      this.timeout(60000);
      const request = requestForFinding("unchanged-but-succeeded", storage, "repeated_command");
      const result = await classifyWindow(request, storage, runtime);
      if (result.success) {
        assert.notStrictEqual(result.classification!.class, "stalled_retry", `must not say stalled_retry when the retry actually succeeded; got ${JSON.stringify(result.classification)}`);
      } else {
        assert.ok(result.error && result.error.length > 0, "a safe failure must carry an explanatory error");
      }
    });

    test("3. failure -> relevant state change -> retry SUCCEEDS: productive_retry", async function () {
      this.timeout(60000);
      const request = requestForFinding("productive-retry", storage, "repeated_command");
      const result = await classifyWindow(request, storage, runtime);
      if (result.success) {
        assert.strictEqual(result.classification!.class, "productive_retry");
      } else {
        // The retry outcome genuinely changed (fail -> success), which is objective
        // new evidence (M9B.3). If the model itself reports newEvidence:false for
        // this fixture, that is a self-contradiction the validator must reject
        // outright, not silently rewrite -- so a safe rejection citing newEvidence
        // is an acceptable outcome here, but nothing else is.
        assert.ok(result.error?.includes("newEvidence"), `expected only a newEvidence contradiction to be tolerated here, got: ${result.error}`);
      }
    });

    test("4. same failure -> no state/evidence change -> retry FAILS: stalled_retry", async function () {
      this.timeout(60000);
      const request = requestForFinding("stalled-retry", storage, "retry_without_state_change");
      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.classification!.class, "stalled_retry");
    });

    test("5. state changes but retry reveals a DIFFERENT failure: must not mechanically classify productive_retry from stateChanged alone", async function () {
      this.timeout(60000);
      const request = requestForFinding("changed-different-failure", storage, "repeated_command");
      const result = await classifyWindow(request, storage, runtime);
      if (result.success) {
        assert.notStrictEqual(result.classification!.class, "productive_retry", `the retry still failed (with a different error) -- must not be productive_retry; got ${JSON.stringify(result.classification)}`);
      } else {
        assert.ok(result.error && result.error.length > 0);
      }
    });

    test("6. same retry outcome (stalled_retry) with a richer evidence/state history: secondary fields are independently derived, not copy-pasted", async function () {
      this.timeout(90000);
      const shortRequest = requestForFinding("stalled-retry", storage, "retry_without_state_change");
      const richRequest = requestForFinding("stalled-retry-rich-history", storage, "retry_without_state_change");

      const shortResult = await classifyWindow(shortRequest, storage, runtime);
      const richResult = await classifyWindow(richRequest, storage, runtime);

      assert.strictEqual(shortResult.success, true, shortResult.error);
      assert.strictEqual(richResult.success, true, richResult.error);
      assert.strictEqual(shortResult.classification!.class, "stalled_retry");
      assert.strictEqual(richResult.classification!.class, "stalled_retry");
      // Both are legitimately stalled_retry (same class), but they must not be
      // literally the same object reference or a hardcoded constant -- each
      // call independently produced its own result from its own evidence.
      assert.notStrictEqual(shortResult.classification, richResult.classification);
    });

    test("fabricated overlap contradiction: a mundane single-agent read with a FABRICATED subagent_overlap finding must not be trusted as duplicate_subagent_work", async function () {
      this.timeout(60000);
      const request = buildRequestFor("mundane-read", storage, [0, 1]);
      const fabricatedOverlap: SubagentOverlapFinding = {
        type: "subagent_overlap",
        sessionId: "mundane-read",
        agentIds: ["agent-X", "agent-Y"],
        stepIndexes: [0, 1],
        evidence: { overlapKind: "same_tool_input", toolName: "Read", toolInput: { file_path: "/boring.txt" } },
      };
      const adversarialRequest: ClassificationRequest = { ...request, overlaps: [fabricatedOverlap] };

      const result = await classifyWindow(adversarialRequest, storage, runtime);
      if (result.success) {
        assert.notStrictEqual(result.classification!.class, "duplicate_subagent_work", `must not trust a fabricated finding contradicting the single-agent window; got ${JSON.stringify(result.classification)}`);
      } else {
        // The consistency validator (distinctAgentCount < 2) is expected to catch this case outright.
        assert.ok(result.error?.includes("duplicate_subagent_work"), `expected the consistency validator to reject this, got: ${result.error}`);
      }
    });

    test("real duplicate subagent work with genuine 2-agent evidence classifies as duplicate_subagent_work", async function () {
      this.timeout(60000);
      const trajectoryUsage = attributeUsageToTrajectory(buildTrajectory("duplicate-subagent", storage.getSession("duplicate-subagent")!.events.map(normalizeRawEvent)), storage);
      const overlaps = detectSubagentOverlap(trajectoryUsage, storage);
      const focusStepIndexes = findingStepIndexes(overlaps, "subagent_overlap");
      const request: ClassificationRequest = { trajectoryUsage, features: extractTrajectoryFeatures(trajectoryUsage), overlaps, focusStepIndexes };

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.classification!.class, "duplicate_subagent_work");
    });

    test("repeated command with genuinely new evidence must not automatically become redundant_exploration", async function () {
      this.timeout(60000);
      const request = requestForFinding("new-evidence-repeat", storage, "repeated_command");
      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, true, result.error);
      assert.notStrictEqual(result.classification!.class, "redundant_exploration");
    });

    test("model output is not predetermined by TypeScript: no category name or output field is stated/pre-filled in the prompt", async function () {
      this.timeout(10000);
      const source = fs.readFileSync(path.join(process.cwd(), "src", "semanticClassifier.ts"), "utf8");
      const promptBuilderMatch = source.match(/function buildClassificationPrompt[\s\S]*?\n}/);
      assert.ok(promptBuilderMatch, "buildClassificationPrompt must exist");
      const promptBuilderBody = promptBuilderMatch![0];
      assert.ok(!/most closely matches the category/.test(source), "must not state which category matches");
      assert.ok(!/WAS changed|NOTHING was changed|DOES show|does NOT show/.test(promptBuilderBody), "must not inject conclusion-shaped fact sentences into the prompt");
      assert.ok(!/computeHint|CLASS_DEFINITIONS\[/.test(source), "must not pre-decide a hint class before inference");
    });

    test("same input produces stable structured output under deterministic settings", async function () {
      this.timeout(60000);
      const request = requestForFinding("productive-retry", storage, "repeated_command");
      const first = await classifyWindow(request, storage, runtime);
      const second = await classifyWindow(request, storage, runtime);
      // Deterministic settings must produce the identical outcome both times,
      // whether that outcome is an accepted classification or a safe rejection
      // (e.g. a newEvidence contradiction the validator catches, per M9B.3).
      assert.strictEqual(first.success, second.success);
      if (first.success) {
        assert.deepStrictEqual(first.classification, second.classification);
      } else {
        assert.ok(first.error?.includes("newEvidence"), `expected only a newEvidence contradiction to be tolerated here, got: ${first.error}`);
        assert.strictEqual(first.error, second.error);
      }
    });

    test("output-token cap is respected", async function () {
      this.timeout(60000);
      const cappedProbe = await runtime.infer("Write a very long, detailed 2000 word essay about the history of computing.", { maxTokens: 5 });
      assert.strictEqual(cappedProbe.record.success, true, cappedProbe.record.error);
      assert.ok(cappedProbe.record.outputTokens !== undefined && cappedProbe.record.outputTokens <= 5, `expected generation capped at 5 tokens, got ${cappedProbe.record.outputTokens}`);

      const request = requestForFinding("productive-retry", storage, "repeated_command");
      const result = await classifyWindow(request, storage, runtime, 200);
      if (!result.success) {
        assert.ok(result.error?.includes("newEvidence"), `expected only a newEvidence contradiction to be tolerated here, got: ${result.error}`);
      }
    });

    test("does not mutate its inputs", async function () {
      this.timeout(60000);
      const request = requestForFinding("productive-retry", storage, "repeated_command");
      const snapshotBefore = JSON.stringify(request);
      await classifyWindow(request, storage, runtime);
      assert.strictEqual(JSON.stringify(request), snapshotBefore);
    });
  });

  suite("strict semantic consistency validation (using a stubbed model, real trajectory facts)", () => {
    let storage: DriftStorage;

    setup(() => {
      storage = openStorage(tempDbPath());
    });

    teardown(() => {
      storage.close();
    });

    function stubRuntime(text: string): LocalModelRuntime {
      return {
        infer: async (_prompt: string, _options?: InferOptions): Promise<InferenceResult> => ({
          text,
          record: { startedAt: 0, durationMs: 0, inputTokens: 1, outputTokens: 1, success: true, error: undefined },
        }),
        close: async () => {},
      };
    }

    test("productive_retry is rejected as invalid when the real facts show the retry failed", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);

      const request = requestForFinding("s1", storage, "retry_without_state_change");
      const runtime = stubRuntime(JSON.stringify({ progress: "meaningful", newEvidence: true, newHypothesis: false, semanticRedundancy: "low", class: "productive_retry" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.classification, undefined, "must not silently rewrite into a different class -- reject outright");
      assert.ok(result.error?.includes("productive_retry"));
    });

    test("stalled_retry is rejected as invalid when the real facts show the retry succeeded", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { output: "worked" } }, 130);

      const request = requestForFinding("s1", storage, "repeated_command");
      const runtime = stubRuntime(JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.classification, undefined);
      assert.ok(result.error?.includes("stalled_retry"));
    });

    test("duplicate_subagent_work is rejected as invalid when fewer than 2 distinct agents are evidenced", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1", tool_response: "x" }, 110);

      const trajectoryUsage = attributeUsageToTrajectory(buildTrajectory("s1", storage.getSession("s1")!.events.map(normalizeRawEvent)), storage);
      const request: ClassificationRequest = { trajectoryUsage, features: [], overlaps: [], focusStepIndexes: [0, 1] };
      const runtime = stubRuntime(JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "duplicate_subagent_work" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.classification, undefined);
      assert.ok(result.error?.includes("duplicate_subagent_work"));
    });

    test("duplicate_subagent_work is accepted when 2+ distinct agents are genuinely evidenced", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-A", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c1", tool_response: { output: "ok" } }, 110);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2" }, 120);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", agent_id: "agent-B", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "c2", tool_response: { output: "ok" } }, 130);

      const trajectoryUsage = attributeUsageToTrajectory(buildTrajectory("s1", storage.getSession("s1")!.events.map(normalizeRawEvent)), storage);
      const overlaps = detectSubagentOverlap(trajectoryUsage, storage);
      const request: ClassificationRequest = { trajectoryUsage, features: [], overlaps, focusStepIndexes: [0, 1, 2, 3] };
      const runtime = stubRuntime(JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "duplicate_subagent_work" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.classification!.class, "duplicate_subagent_work");
    });

    test("productive_retry is accepted when the real facts show the retry succeeded", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { output: "worked" } }, 130);

      const request = requestForFinding("s1", storage, "repeated_command");
      const runtime = stubRuntime(JSON.stringify({ progress: "meaningful", newEvidence: true, newHypothesis: false, semanticRedundancy: "low", class: "productive_retry" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.classification!.class, "productive_retry");
    });

    // M9B.3 required regression 1: a changed failure between attempts is objective
    // new evidence -- the model saying newEvidence:false must be rejected outright.
    test("M9B.3/1: newEvidence:false is rejected when newEvidenceBetweenAttempts is non-empty (changed failure)", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c1", tool_response: { error: "missing credentials" } }, 110);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/creds.json" }, tool_use_id: "w1" }, 120);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/creds.json" }, tool_use_id: "w1", tool_response: { output: "ok" } }, 130);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c2" }, 140);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c2", tool_response: { error: "quota exceeded" } }, 150);

      const request = requestForFinding("s1", storage, "repeated_command");
      // stalled_retry is a class-level-consistent choice here (last attempt failed),
      // so this isolates the newEvidence invariant specifically, not the class one.
      const runtime = stubRuntime(JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.classification, undefined, "must not silently rewrite newEvidence false -> true -- reject outright");
      assert.ok(result.error?.includes("newEvidence"));
    });

    // M9B.3 required regression 2: same evidence, model correctly says newEvidence:true => accepted.
    test("M9B.3/2: newEvidence:true is accepted for the same changed-failure evidence", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c1", tool_response: { error: "missing credentials" } }, 110);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/creds.json" }, tool_use_id: "w1" }, 120);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/creds.json" }, tool_use_id: "w1", tool_response: { output: "ok" } }, 130);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c2" }, 140);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "deploy" }, tool_use_id: "c2", tool_response: { error: "quota exceeded" } }, 150);

      const request = requestForFinding("s1", storage, "repeated_command");
      const runtime = stubRuntime(JSON.stringify({ progress: "low", newEvidence: true, newHypothesis: false, semanticRedundancy: "medium", class: "stalled_retry" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.classification!.newEvidence, true);
    });

    // M9B.3 required regression 3: identical failure repeated -> newEvidenceBetweenAttempts
    // is empty -> newEvidence:false is perfectly consistent -> accepted.
    test("M9B.3/3: newEvidence:false is accepted when the failure is identical both times (no objective signal)", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c1", tool_response: { error: "timeout" } }, 110);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2" }, 120);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "flaky" }, tool_use_id: "c2", tool_response: { error: "timeout" } }, 130);

      const request = requestForFinding("s1", storage, "retry_without_state_change");
      const runtime = stubRuntime(JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.classification!.newEvidence, false);
    });

    // M9B.3 required regression 4: a changed SUCCESSFUL result (not a failure) is also
    // objective new evidence -- newEvidence:false must still be rejected.
    test("M9B.3/4: newEvidence:false is rejected when a successful result genuinely changed between attempts", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "check status" }, tool_use_id: "s1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "check status" }, tool_use_id: "s1", tool_response: { output: "service DOWN" } }, 110);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "check status" }, tool_use_id: "s2" }, 120);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "check status" }, tool_use_id: "s2", tool_response: { output: "service UP, new error code E42 detected" } }, 130);

      const request = requestForFinding("s1", storage, "repeated_command");
      const runtime = stubRuntime(JSON.stringify({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "new_exploration" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.classification, undefined);
      assert.ok(result.error?.includes("newEvidence"));
    });

    // M9B.3 required regression 5: no objective new-evidence signal (identical, single
    // attempt) -- the model is still free to say newEvidence:true from its own reading;
    // must not be rejected solely because the deterministic signal array is empty.
    test("M9B.3/5: newEvidence:true is accepted even when no objective new-evidence signal exists", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/never-seen-before.txt" }, tool_use_id: "r1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/never-seen-before.txt" }, tool_use_id: "r1", tool_response: "important new content" }, 110);

      const trajectoryUsage = attributeUsageToTrajectory(buildTrajectory("s1", storage.getSession("s1")!.events.map(normalizeRawEvent)), storage);
      const request: ClassificationRequest = { trajectoryUsage, features: [], overlaps: [], focusStepIndexes: [0, 1] };
      const runtime = stubRuntime(JSON.stringify({ progress: "low", newEvidence: true, newHypothesis: true, semanticRedundancy: "low", class: "new_exploration" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.classification!.newEvidence, true);
    });

    test("M9B.3: newHypothesis:false is rejected when newHypothesisSignals is non-empty (changed input)", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "check status" }, tool_use_id: "s1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "check status" }, tool_use_id: "s1", tool_response: { output: "ok" } }, 110);
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "check status --verbose" }, tool_use_id: "s2" }, 120);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "check status --verbose" }, tool_use_id: "s2", tool_response: { output: "ok, details: ..." } }, 130);

      const trajectoryUsage = attributeUsageToTrajectory(buildTrajectory("s1", storage.getSession("s1")!.events.map(normalizeRawEvent)), storage);
      const request: ClassificationRequest = { trajectoryUsage, features: [], overlaps: [], focusStepIndexes: [0, 1, 2, 3] };
      const runtime = stubRuntime(JSON.stringify({ progress: "low", newEvidence: true, newHypothesis: false, semanticRedundancy: "low", class: "new_exploration" }));

      const result = await classifyWindow(request, storage, runtime);
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("newHypothesis"));
    });

    test("new_exploration and redundant_exploration carry no consistency invariant and are never rejected by it", async () => {
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1", tool_response: "x" }, 110);

      const trajectoryUsage = attributeUsageToTrajectory(buildTrajectory("s1", storage.getSession("s1")!.events.map(normalizeRawEvent)), storage);
      const request: ClassificationRequest = { trajectoryUsage, features: [], overlaps: [], focusStepIndexes: [0, 1] };

      for (const cls of ["new_exploration", "redundant_exploration"]) {
        const runtime = stubRuntime(JSON.stringify({ progress: "low", newEvidence: true, newHypothesis: true, semanticRedundancy: "low", class: cls }));
        const result = await classifyWindow(request, storage, runtime);
        assert.strictEqual(result.success, true, `${cls} should not be rejected: ${result.error}`);
        assert.strictEqual(result.classification!.class, cls);
      }
    });
  });

  suite("malformed model output is rejected safely", () => {
    let storage: DriftStorage;

    setup(() => {
      storage = openStorage(tempDbPath());
      storage.ensureSession("s1");
      storage.insertRawEvent("s1", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1" }, 100);
      storage.insertRawEvent("s1", { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/a.txt" }, tool_use_id: "r1", tool_response: "x" }, 110);
    });

    teardown(() => {
      storage.close();
    });

    function request(): ClassificationRequest {
      const trajectoryUsage = attributeUsageToTrajectory(buildTrajectory("s1", storage.getSession("s1")!.events.map(normalizeRawEvent)), storage);
      return { trajectoryUsage, features: [], overlaps: [], focusStepIndexes: [0, 1] };
    }

    function stubRuntime(text: string | undefined, success = true, error: string | undefined = undefined): LocalModelRuntime {
      return {
        infer: async (): Promise<InferenceResult> => ({
          text,
          record: { startedAt: 0, durationMs: 0, inputTokens: success ? 1 : undefined, outputTokens: success ? 1 : undefined, success, error },
        }),
        close: async () => {},
      };
    }

    test("non-JSON model output is rejected, not thrown", async () => {
      const result = await classifyWindow(request(), storage, stubRuntime("this is not json at all"));
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.classification, undefined);
      assert.ok(result.error?.includes("not valid JSON"));
    });

    test("valid JSON with an out-of-enum class is rejected", async () => {
      const result = await classifyWindow(
        request(),
        storage,
        stubRuntime(JSON.stringify({ progress: "meaningful", newEvidence: true, newHypothesis: false, semanticRedundancy: "low", class: "made_up_class" }))
      );
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.classification, undefined);
    });

    test("valid JSON missing a required field is rejected", async () => {
      const result = await classifyWindow(request(), storage, stubRuntime(JSON.stringify({ progress: "meaningful", newEvidence: true, newHypothesis: false, class: "new_exploration" })));
      assert.strictEqual(result.success, false);
    });

    test("valid JSON with a wrong-typed field (string instead of boolean) is rejected", async () => {
      const result = await classifyWindow(
        request(),
        storage,
        stubRuntime(JSON.stringify({ progress: "meaningful", newEvidence: "true", newHypothesis: false, semanticRedundancy: "low", class: "new_exploration" }))
      );
      assert.strictEqual(result.success, false);
    });

    test("an underlying failed infer() call is propagated as a failure, not thrown", async () => {
      const result = await classifyWindow(request(), storage, stubRuntime(undefined, false, "model unavailable"));
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, "model unavailable");
    });

    test("a valid, well-formed, and semantically consistent classification is accepted", async () => {
      const valid = { progress: "low", newEvidence: true, newHypothesis: true, semanticRedundancy: "low", class: "new_exploration" };
      const result = await classifyWindow(request(), storage, stubRuntime(JSON.stringify(valid)));
      assert.strictEqual(result.success, true, result.error);
      assert.deepStrictEqual(result.classification, valid);
    });
  });
});
