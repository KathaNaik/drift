import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage, DriftStorage } from "../../src/storage";
import { normalizeRawEvent } from "../../src/normalizedEvent";
import { buildTrajectory } from "../../src/trajectory";
import { attributeUsageToTrajectory, TrajectoryUsage } from "../../src/trajectoryUsageAttribution";
import { decideFindingPolicy, DeterministicEvidence } from "../../src/findingDecisionPolicy";
import { SessionAnalysisWindow } from "../../src/sessionAnalysisPipeline";
import { ClassificationResult, SemanticClassification } from "../../src/semanticClassifier";
import { generateRedirectPacket, formatRedirectPacketText, formatInjectedRedirectContext } from "../../src/redirectPacket";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-redirect-packet-test-"));
  return path.join(dir, "drift.sqlite3");
}

function loadTrajectoryUsage(sessionId: string, storage: DriftStorage): TrajectoryUsage {
  const session = storage.getSession(sessionId)!;
  const normalized = session.events.map(normalizeRawEvent);
  const trajectory = buildTrajectory(sessionId, normalized);
  return attributeUsageToTrajectory(trajectory, storage);
}

function classification(fields: Partial<SemanticClassification>): ClassificationResult {
  const full: SemanticClassification = { progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry", ...fields };
  return { classification: full, raw: JSON.stringify(full), success: true, error: undefined };
}

function makeWindow(sessionId: string, stepIndexes: number[], deterministicEvidence: DeterministicEvidence[], cls: ClassificationResult): SessionAnalysisWindow {
  const decision = decideFindingPolicy({ sessionId, stepIndexes, deterministicEvidence, classification: cls, attributedUsage: undefined });
  return {
    stepIndexes,
    deterministicFindings: deterministicEvidence.filter((e) => e.type !== "subagent_overlap") as any,
    subagentOverlaps: deterministicEvidence.filter((e) => e.type === "subagent_overlap") as any,
    semanticResult: cls,
    decision,
  };
}

suite("redirectPacket (M12A)", () => {
  let storage: DriftStorage;

  setup(() => {
    storage = openStorage(tempDbPath());
  });

  teardown(() => {
    storage.close();
  });

  function redirectCandidateFixture(sessionId: string) {
    storage.ensureSession(sessionId);
    for (let i = 0; i < 3; i++) {
      storage.insertRawEvent(sessionId, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run migrate:prod" }, tool_use_id: `c${i}` }, 100 + i * 10);
      storage.insertRawEvent(sessionId, { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm run migrate:prod" }, tool_use_id: `c${i}`, tool_response: { error: "ECONNREFUSED" } }, 105 + i * 10);
    }
    const trajectoryUsage = loadTrajectoryUsage(sessionId, storage);
    const stepIndexes = trajectoryUsage.steps.map((s) => s.index);
    const deterministicEvidence: DeterministicEvidence[] = [
      { type: "repeated_failure", sessionId, stepIndexes, evidence: { toolName: "Bash", toolInput: { command: "npm run migrate:prod" }, failureResponse: { error: "ECONNREFUSED" }, occurrences: 3 } } as DeterministicEvidence,
      { type: "retry_without_state_change", sessionId, stepIndexes: stepIndexes.slice(0, 2), evidence: { toolName: "Bash", toolInput: { command: "npm run migrate:prod" } } } as DeterministicEvidence,
    ];
    const cls = classification({ progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high", class: "stalled_retry" });
    const window = makeWindow(sessionId, stepIndexes, deterministicEvidence, cls);
    assert.strictEqual(window.decision.state, "redirect_candidate", "sanity: fixture must genuinely be redirect_candidate");
    return { trajectoryUsage, window, stepIndexes };
  }

  test("Redirect Candidate produces a grounded redirect packet", () => {
    const { trajectoryUsage, window, stepIndexes } = redirectCandidateFixture("s-grounded");
    const result = generateRedirectPacket("s-grounded", window, trajectoryUsage);

    assert.strictEqual(result.success, true, result.error);
    assert.ok(result.packet);
    assert.strictEqual(result.packet!.sessionId, "s-grounded");
    assert.deepStrictEqual(result.packet!.sourceStepIndexes, stepIndexes);
    assert.deepStrictEqual(result.packet!.reasonCodes, window.decision.reasonCodes);
    assert.ok(result.packet!.currentState.length > 0);
    assert.ok(result.packet!.avoidRepeating.length > 0);
    assert.ok(result.packet!.suggestedNextAction.length > 0);
  });

  test("Finding cannot produce a redirect packet", () => {
    storage.ensureSession("s-finding");
    storage.insertRawEvent("s-finding", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-finding", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: { error: "boom" } }, 110);
    storage.insertRawEvent("s-finding", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s-finding", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c2", tool_response: { error: "boom" } }, 130);
    const trajectoryUsage = loadTrajectoryUsage("s-finding", storage);
    const stepIndexes = trajectoryUsage.steps.map((s) => s.index);
    const window = makeWindow(
      "s-finding",
      stepIndexes,
      [{ type: "repeated_failure", sessionId: "s-finding", stepIndexes, evidence: { toolName: "Bash", occurrences: 2 } } as DeterministicEvidence],
      classification({ progress: "low", semanticRedundancy: "medium", class: "stalled_retry" })
    );
    assert.strictEqual(window.decision.state, "finding");

    const result = generateRedirectPacket("s-finding", window, trajectoryUsage);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.packet, undefined);
    assert.ok(result.error?.includes("finding"));
  });

  test("Observe cannot produce a redirect packet", () => {
    storage.ensureSession("s-observe");
    storage.insertRawEvent("s-observe", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-observe", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git status" }, tool_use_id: "c1", tool_response: "clean" }, 110);
    storage.insertRawEvent("s-observe", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, tool_use_id: "c2" }, 120);
    storage.insertRawEvent("s-observe", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git status" }, tool_use_id: "c2", tool_response: "clean" }, 130);
    const trajectoryUsage = loadTrajectoryUsage("s-observe", storage);
    const stepIndexes = trajectoryUsage.steps.map((s) => s.index);
    const window = makeWindow(
      "s-observe",
      stepIndexes,
      [{ type: "repeated_command", sessionId: "s-observe", stepIndexes, evidence: { normalizedCommand: "git status", occurrences: 2 } } as DeterministicEvidence],
      classification({ class: "new_exploration", semanticRedundancy: "low" })
    );
    assert.strictEqual(window.decision.state, "observe");

    const result = generateRedirectPacket("s-observe", window, trajectoryUsage);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.packet, undefined);
    assert.ok(result.error?.includes("observe"));
  });

  test("packet references exact source step indexes -- never recomputed or reordered", () => {
    const { trajectoryUsage, window } = redirectCandidateFixture("s-steps");
    const result = generateRedirectPacket("s-steps", window, trajectoryUsage);
    assert.deepStrictEqual(result.packet!.sourceStepIndexes, window.stepIndexes);
    assert.notStrictEqual(result.packet!.sourceStepIndexes, window.stepIndexes, "must be a fresh copy, not an alias");
  });

  test("avoidRepeating describes the specific repeated behavior from real deterministic evidence, for every supported type", () => {
    storage.ensureSession("s-types");
    const trajectoryUsage = loadTrajectoryUsage("s-types", storage);

    const cases: { evidence: DeterministicEvidence; expectedSubstrings: string[] }[] = [
      {
        evidence: { type: "repeated_command", sessionId: "s-types", stepIndexes: [0, 1], evidence: { normalizedCommand: "npm test", occurrences: 4 } } as DeterministicEvidence,
        expectedSubstrings: ["npm test", "4"],
      },
      {
        evidence: {
          type: "repeated_failure",
          sessionId: "s-types",
          stepIndexes: [0, 1],
          evidence: { toolName: "Bash", toolInput: { command: "deploy" }, failureResponse: { error: "timeout" }, occurrences: 3 },
        } as DeterministicEvidence,
        expectedSubstrings: ["Bash", "3", "timeout"],
      },
      {
        evidence: { type: "retry_without_state_change", sessionId: "s-types", stepIndexes: [0, 1], evidence: { toolName: "Bash", toolInput: { command: "deploy" } } } as DeterministicEvidence,
        expectedSubstrings: ["Bash", "deploy"],
      },
      {
        evidence: { type: "repeated_context", sessionId: "s-types", stepIndexes: [0, 1], evidence: { toolName: "Grep", toolInput: { pattern: "TODO" }, occurrences: 2 } } as DeterministicEvidence,
        expectedSubstrings: ["Grep", "2"],
      },
      {
        evidence: { type: "unchanged_file_reread", sessionId: "s-types", stepIndexes: [0, 1], evidence: { toolName: "Read", filePath: "/etc/hosts" } } as DeterministicEvidence,
        expectedSubstrings: ["/etc/hosts"],
      },
      {
        evidence: { type: "subagent_overlap", sessionId: "s-types", agentIds: ["worker-a", "worker-b"], stepIndexes: [0, 1], evidence: { overlapKind: "same_tool_input", toolName: "Bash" } } as DeterministicEvidence,
        expectedSubstrings: ["worker-a", "worker-b", "Bash"],
      },
    ];

    for (const { evidence, expectedSubstrings } of cases) {
      const window = makeWindow(
        "s-types",
        [0, 1],
        [evidence, { type: "retry_without_state_change", sessionId: "s-types", stepIndexes: [0, 1], evidence: {} } as DeterministicEvidence],
        classification({ class: "stalled_retry", progress: "none", semanticRedundancy: "high" })
      );
      const result = generateRedirectPacket("s-types", window, trajectoryUsage);
      assert.strictEqual(result.success, true, `${evidence.type}: ${result.error}`);
      for (const substring of expectedSubstrings) {
        assert.ok(result.packet!.avoidRepeating.includes(substring), `expected avoidRepeating to include "${substring}" for ${evidence.type}, got: ${result.packet!.avoidRepeating}`);
      }
      assert.ok(!/be more efficient/i.test(result.packet!.avoidRepeating), "must never use a generic instruction");
    }
  });

  test("avoidRepeating never falls back to a generic instruction when real evidence exists", () => {
    const { trajectoryUsage, window } = redirectCandidateFixture("s-specific");
    const result = generateRedirectPacket("s-specific", window, trajectoryUsage);
    assert.ok(!/be more efficient/i.test(result.packet!.avoidRepeating));
    assert.ok(!/work smarter/i.test(result.packet!.avoidRepeating));
    assert.ok(result.packet!.avoidRepeating.includes("npm run migrate:prod"));
  });

  test("suggestedNextAction is grounded and never fabricates an unsupported fix", () => {
    const { trajectoryUsage, window } = redirectCandidateFixture("s-action");
    const result = generateRedirectPacket("s-action", window, trajectoryUsage);
    const action = result.packet!.suggestedNextAction.toLowerCase();
    // Must ask for reassessment/inspection/different approach, never prescribe a specific unverified fix.
    assert.ok(/reassess|inspect|different approach|choose a different/.test(action), action);
    assert.ok(!/restart the database/i.test(action) && !/increase the timeout/i.test(action), "must not invent a specific technical fix the trajectory never established");
  });

  test("suggestedNextAction falls back to a neutral, evidence-grounded message for an unhandled semantic class", () => {
    storage.ensureSession("s-fallback");
    storage.insertRawEvent("s-fallback", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1" }, 100);
    storage.insertRawEvent("s-fallback", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "a" }, tool_use_id: "c1", tool_response: "ok" }, 110);
    const trajectoryUsage = loadTrajectoryUsage("s-fallback", storage);
    const stepIndexes = [0, 1];
    const window = makeWindow(
      "s-fallback",
      stepIndexes,
      [
        { type: "repeated_context", sessionId: "s-fallback", stepIndexes, evidence: { toolName: "Bash", occurrences: 2 } } as DeterministicEvidence,
        { type: "repeated_command", sessionId: "s-fallback", stepIndexes, evidence: { normalizedCommand: "a", occurrences: 2 } } as DeterministicEvidence,
      ],
      classification({ class: "new_exploration", progress: "none", newEvidence: false, newHypothesis: false, semanticRedundancy: "high" })
    );
    assert.strictEqual(window.decision.state, "redirect_candidate", "sanity: new_exploration + high redundancy + strong signal + 2 structural signals qualifies");
    const result = generateRedirectPacket("s-fallback", window, trajectoryUsage);
    assert.strictEqual(result.success, true, result.error);
    assert.ok(result.packet!.suggestedNextAction.toLowerCase().includes("reassess"));
  });

  test("stale/mismatched session (trajectory belongs to a different session) is rejected", () => {
    const { window } = redirectCandidateFixture("s-real");
    storage.ensureSession("s-other");
    storage.insertRawEvent("s-other", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "unrelated" }, tool_use_id: "o1" }, 100);
    storage.insertRawEvent("s-other", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "unrelated" }, tool_use_id: "o1", tool_response: "ok" }, 110);
    const otherTrajectoryUsage = loadTrajectoryUsage("s-other", storage);

    const result = generateRedirectPacket("s-real", window, otherTrajectoryUsage);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.packet, undefined);
    assert.ok(result.error?.includes("mismatch"));
  });

  test("stale/mismatched session (requested sessionId doesn't match the window's own decision.sessionId) is rejected", () => {
    const { trajectoryUsage, window } = redirectCandidateFixture("s-real2");
    // Same trajectory, but claiming it's for a different sessionId than the window was decided for.
    const result = generateRedirectPacket("s-impersonated", window, { ...trajectoryUsage, sessionId: "s-impersonated" });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.packet, undefined);
    assert.ok(result.error?.includes("mismatch"));
  });

  test("generation is deterministic for the same input", () => {
    const { trajectoryUsage, window } = redirectCandidateFixture("s-det");
    const first = generateRedirectPacket("s-det", window, trajectoryUsage);
    const second = generateRedirectPacket("s-det", window, trajectoryUsage);
    assert.deepStrictEqual(first, second);
  });

  test("does not mutate its inputs", () => {
    const { trajectoryUsage, window } = redirectCandidateFixture("s-mutate");
    const trajectorySnapshot = JSON.stringify(trajectoryUsage);
    const windowSnapshot = JSON.stringify(window);
    generateRedirectPacket("s-mutate", window, trajectoryUsage);
    assert.strictEqual(JSON.stringify(trajectoryUsage), trajectorySnapshot);
    assert.strictEqual(JSON.stringify(window), windowSnapshot);
  });

  test("no LLM call is required to generate the redirect packet -- the function has no runtime parameter at all", () => {
    assert.strictEqual(generateRedirectPacket.length, 3, "expected exactly (sessionId, window, trajectoryUsage) -- no model runtime parameter");
  });

  test("formatRedirectPacketText renders a compact, non-JSON, human-readable summary", () => {
    const { trajectoryUsage, window } = redirectCandidateFixture("s-format");
    const result = generateRedirectPacket("s-format", window, trajectoryUsage);
    const text = formatRedirectPacketText(result.packet!);
    assert.ok(!text.trim().startsWith("{"), "must not be a raw JSON dump");
    assert.ok(text.includes("s-format"));
    assert.ok(text.includes("Avoid repeating:"));
    assert.ok(text.includes("Suggested next action:"));
  });

  test("formatInjectedRedirectContext matches the exact M12B template and contains only currentState/avoidRepeating/suggestedNextAction", () => {
    const { trajectoryUsage, window } = redirectCandidateFixture("s-inject");
    const result = generateRedirectPacket("s-inject", window, trajectoryUsage);
    const packet = result.packet!;
    const text = formatInjectedRedirectContext(packet);

    assert.ok(text.startsWith("DRIFT REDIRECT"));
    assert.ok(text.includes("Current state:"));
    assert.ok(text.includes("Avoid repeating:"));
    assert.ok(text.includes("Suggested next action:"));
    assert.ok(text.trimEnd().endsWith("This is guidance, not a forced command."));

    for (const line of packet.currentState) assert.ok(text.includes(line));
    assert.ok(text.includes(packet.avoidRepeating));
    assert.ok(text.includes(packet.suggestedNextAction));
  });

  test("formatInjectedRedirectContext never leaks sessionId, sourceStepIndexes, or reasonCodes", () => {
    const { trajectoryUsage, window } = redirectCandidateFixture("s-noleak");
    const result = generateRedirectPacket("s-noleak", window, trajectoryUsage);
    const packet = result.packet!;
    const text = formatInjectedRedirectContext(packet);

    assert.ok(!text.includes("s-noleak"), "sessionId must never appear in injected context");
    for (const code of packet.reasonCodes) {
      assert.ok(!text.includes(code), `reasonCode "${code}" must never appear in injected context`);
    }
    assert.ok(!text.includes(packet.sourceStepIndexes.join(", ")), "raw step indexes must never appear in injected context");
    assert.ok(!text.trim().startsWith("{"), "must never be a raw JSON dump");
  });

  test("formatInjectedRedirectContext never fabricates state when currentState is empty", () => {
    const packet = {
      sessionId: "s-empty",
      sourceStepIndexes: [0, 1],
      reasonCodes: ["x"],
      currentState: [],
      avoidRepeating: "Repeated pattern detected: repeated_command",
      suggestedNextAction: "Reassess the current approach before continuing.",
    };
    const text = formatInjectedRedirectContext(packet);
    assert.ok(text.includes("no objective state established"));
  });
});
