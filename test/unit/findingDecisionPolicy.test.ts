import * as assert from "assert";
import { decideFindingPolicy, DecisionInput, DeterministicEvidence } from "../../src/findingDecisionPolicy";
import { TrajectoryFeatureFinding } from "../../src/trajectoryFeatures";
import { SubagentOverlapFinding } from "../../src/subagentOverlap";
import { ClassificationResult, SemanticClassification } from "../../src/semanticClassifier";
import { UsageSummary } from "../../src/trajectoryUsageAttribution";

function repeatedCommandFinding(stepIndexes: number[]): TrajectoryFeatureFinding {
  return { type: "repeated_command", sessionId: "s1", stepIndexes, evidence: { toolName: "Bash", normalizedCommand: "npm test", occurrences: 2 } };
}

function unchangedRereadFinding(stepIndexes: number[]): TrajectoryFeatureFinding {
  return { type: "unchanged_file_reread", sessionId: "s1", stepIndexes, evidence: { toolName: "Read", filePath: "/a.txt" } };
}

function repeatedFailureFinding(stepIndexes: number[]): TrajectoryFeatureFinding {
  return { type: "repeated_failure", sessionId: "s1", stepIndexes, evidence: { toolName: "Bash", toolInput: { command: "flaky" }, failureResponse: { error: "boom" }, occurrences: 2 } };
}

function retryWithoutStateChangeFinding(stepIndexes: number[]): TrajectoryFeatureFinding {
  return { type: "retry_without_state_change", sessionId: "s1", stepIndexes, evidence: { toolName: "Bash", toolInput: { command: "flaky" } } };
}

function repeatedContextFinding(stepIndexes: number[]): TrajectoryFeatureFinding {
  return { type: "repeated_context", sessionId: "s1", stepIndexes, evidence: { toolName: "Grep", toolInput: { pattern: "TODO" }, result: "3 matches", occurrences: 2 } };
}

function subagentOverlapFinding(stepIndexes: number[]): SubagentOverlapFinding {
  return { type: "subagent_overlap", sessionId: "s1", agentIds: ["agent-A", "agent-B"], stepIndexes, evidence: { overlapKind: "same_tool_input", toolName: "Bash", toolInput: { command: "npm test" } } };
}

function classification(fields: Partial<SemanticClassification>): ClassificationResult {
  const full: SemanticClassification = {
    progress: "none",
    newEvidence: false,
    newHypothesis: false,
    semanticRedundancy: "high",
    class: "stalled_retry",
    ...fields,
  };
  return { classification: full, raw: JSON.stringify(full), success: true, error: undefined };
}

function failedClassification(error: string): ClassificationResult {
  return { classification: undefined, raw: undefined, success: false, error };
}

function invalidClassification(): ClassificationResult {
  return { classification: undefined, raw: "not json", success: false, error: "model output was not valid JSON" };
}

const NO_USAGE: UsageSummary | undefined = undefined;

function input(overrides: Partial<DecisionInput>): DecisionInput {
  return {
    sessionId: "s1",
    stepIndexes: [0, 1],
    deterministicEvidence: [],
    classification: classification({}),
    attributedUsage: NO_USAGE,
    ...overrides,
  };
}

suite("findingDecisionPolicy (M10A)", () => {
  test("weak evidence (one isolated repeated_command) stays observe even with a nominally corroborating classification", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedCommandFinding([0, 1, 2, 3])],
        classification: classification({ class: "redundant_exploration", semanticRedundancy: "high", progress: "none" }),
      })
    );
    assert.strictEqual(decision.state, "observe");
    assert.ok(decision.reasonCodes.includes("no_strong_deterministic_signal"));
  });

  test("weak evidence (one isolated unchanged_file_reread) stays observe", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [unchangedRereadFinding([0, 1])],
        classification: classification({ class: "redundant_exploration", semanticRedundancy: "high" }),
      })
    );
    assert.strictEqual(decision.state, "observe");
  });

  test("semantic redundancy reported but no deterministic corroboration stays observe", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [],
        classification: classification({ semanticRedundancy: "high", class: "redundant_exploration" }),
      })
    );
    assert.strictEqual(decision.state, "observe");
    assert.ok(decision.reasonCodes.includes("no_deterministic_evidence"));
  });

  test("semantic classifier failure keeps the window at observe, never finding/redirect_candidate", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3]), retryWithoutStateChangeFinding([0, 1, 2, 3])],
        classification: failedClassification("no text returned"),
      })
    );
    assert.strictEqual(decision.state, "observe");
    assert.ok(decision.reasonCodes.includes("semantic_classification_invalid_or_failed"));
  });

  test("invalid (schema-rejected) semantic classification keeps the window at observe", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3])],
        classification: invalidClassification(),
      })
    );
    assert.strictEqual(decision.state, "observe");
  });

  test("corroborated stalled retry (repeated_failure + retry_without_state_change + stalled_retry) becomes finding", () => {
    const decision = decideFindingPolicy(
      input({
        stepIndexes: [0, 1, 2, 3],
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3]), retryWithoutStateChangeFinding([0, 1, 2, 3])],
        classification: classification({ class: "stalled_retry", progress: "none", semanticRedundancy: "medium", newEvidence: false, newHypothesis: false }),
      })
    );
    assert.strictEqual(decision.state, "finding");
    assert.ok(decision.reasonCodes.includes("semantic_corroboration_confirmed"));
  });

  test("repeated_context + high semantic redundancy becomes finding", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedContextFinding([0, 1, 2, 3])],
        classification: classification({ class: "redundant_exploration", semanticRedundancy: "high" }),
      })
    );
    assert.strictEqual(decision.state, "finding");
  });

  test("genuine duplicate-subagent work (subagent_overlap + duplicate_subagent_work) becomes finding", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [subagentOverlapFinding([0, 1, 2, 3])],
        classification: classification({ class: "duplicate_subagent_work", semanticRedundancy: "high", progress: "none", newEvidence: false, newHypothesis: false }),
      })
    );
    assert.strictEqual(decision.state, "finding");
  });

  test("a single subagent_overlap + duplicate_subagent_work classification stays at finding, not redirect_candidate, when only one structural signal corroborates it", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [subagentOverlapFinding([0, 1, 2, 3])],
        classification: classification({ class: "duplicate_subagent_work", semanticRedundancy: "high", progress: "none", newEvidence: false, newHypothesis: false }),
      })
    );
    assert.strictEqual(decision.state, "finding");
    assert.ok(decision.reasonCodes.includes("insufficient_corroborating_structural_signals"));
  });

  test("strong repeated stalled loop (2+ structural signals, no new evidence/hypothesis, low progress, high redundancy) becomes redirect_candidate", () => {
    const decision = decideFindingPolicy(
      input({
        stepIndexes: [0, 1, 2, 3, 4, 5],
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3, 4, 5]), retryWithoutStateChangeFinding([0, 1]), retryWithoutStateChangeFinding([2, 3])],
        classification: classification({ class: "stalled_retry", progress: "none", semanticRedundancy: "high", newEvidence: false, newHypothesis: false }),
      })
    );
    assert.strictEqual(decision.state, "redirect_candidate");
    assert.ok(decision.reasonCodes.includes("multiple_corroborating_structural_signals"));
  });

  test("productive retry never becomes redirect_candidate, even with otherwise-matching fields", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3]), retryWithoutStateChangeFinding([0, 1])],
        classification: classification({ class: "productive_retry", progress: "none", semanticRedundancy: "high", newEvidence: false, newHypothesis: false }),
      })
    );
    assert.notStrictEqual(decision.state, "redirect_candidate");
    assert.strictEqual(decision.state, "observe");
    assert.ok(decision.reasonCodes.includes("productive_retry_excludes_low_value_pattern"));
  });

  test("productive retry never becomes finding either", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3])],
        classification: classification({ class: "productive_retry", progress: "meaningful", semanticRedundancy: "low", newEvidence: true, newHypothesis: false }),
      })
    );
    assert.strictEqual(decision.state, "observe");
  });

  test("new evidence prevents redirect_candidate, downgrading an otherwise-qualifying window to finding", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3]), retryWithoutStateChangeFinding([0, 1])],
        classification: classification({ class: "stalled_retry", progress: "none", semanticRedundancy: "high", newEvidence: true, newHypothesis: false }),
      })
    );
    assert.strictEqual(decision.state, "finding");
    assert.ok(decision.reasonCodes.includes("new_evidence_present"));
  });

  test("new hypothesis prevents redirect_candidate, downgrading an otherwise-qualifying window to finding", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3]), retryWithoutStateChangeFinding([0, 1])],
        classification: classification({ class: "stalled_retry", progress: "none", semanticRedundancy: "high", newEvidence: false, newHypothesis: true }),
      })
    );
    assert.strictEqual(decision.state, "finding");
    assert.ok(decision.reasonCodes.includes("new_hypothesis_present"));
  });

  test("progress above 'low' prevents redirect_candidate, downgrading to finding", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3]), retryWithoutStateChangeFinding([0, 1])],
        classification: classification({ class: "stalled_retry", progress: "meaningful", semanticRedundancy: "high", newEvidence: false, newHypothesis: false }),
      })
    );
    assert.strictEqual(decision.state, "finding");
    assert.ok(decision.reasonCodes.includes("progress_not_none_or_low"));
  });

  test("semanticRedundancy below 'high' prevents redirect_candidate, downgrading to finding", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3]), retryWithoutStateChangeFinding([0, 1])],
        classification: classification({ class: "stalled_retry", progress: "none", semanticRedundancy: "medium", newEvidence: false, newHypothesis: false }),
      })
    );
    assert.strictEqual(decision.state, "finding");
    assert.ok(decision.reasonCodes.includes("semantic_redundancy_not_high"));
  });

  test("invalid semantic classification cannot become redirect_candidate even with abundant strong deterministic evidence", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3]), retryWithoutStateChangeFinding([0, 1]), retryWithoutStateChangeFinding([2, 3])],
        classification: invalidClassification(),
      })
    );
    assert.notStrictEqual(decision.state, "redirect_candidate");
    assert.strictEqual(decision.state, "observe");
  });

  test("decision output carries every required field", () => {
    const usage: UsageSummary = { modelCalls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: undefined, cacheWriteTokens: undefined, costUsd: undefined, durationMs: undefined, records: [] };
    const decision = decideFindingPolicy(
      input({
        sessionId: "session-xyz",
        stepIndexes: [3, 1, 2],
        deterministicEvidence: [repeatedFailureFinding([1, 2, 3])],
        classification: classification({ class: "stalled_retry" }),
        attributedUsage: usage,
      })
    );
    assert.strictEqual(decision.sessionId, "session-xyz");
    assert.deepStrictEqual(decision.stepIndexes, [1, 2, 3]);
    assert.ok(Array.isArray(decision.deterministicEvidence));
    assert.deepStrictEqual(decision.semanticEvidence, classification({ class: "stalled_retry" }).classification);
    assert.strictEqual(decision.attributedUsage, usage);
    assert.ok(Array.isArray(decision.reasonCodes) && decision.reasonCodes.length > 0);
  });

  test("semanticEvidence is undefined (not fabricated) when classification failed", () => {
    const decision = decideFindingPolicy(
      input({
        deterministicEvidence: [repeatedFailureFinding([0, 1])],
        classification: failedClassification("boom"),
      })
    );
    assert.strictEqual(decision.semanticEvidence, undefined);
  });

  test("deterministic output for the same input", () => {
    const decisionInput = input({
      deterministicEvidence: [repeatedFailureFinding([0, 1, 2, 3]), retryWithoutStateChangeFinding([0, 1])],
      classification: classification({ class: "stalled_retry", progress: "none", semanticRedundancy: "high", newEvidence: false, newHypothesis: false }),
    });
    const first = decideFindingPolicy(decisionInput);
    const second = decideFindingPolicy(decisionInput);
    assert.deepStrictEqual(first, second);
  });

  test("does not mutate its inputs", () => {
    const evidence: DeterministicEvidence[] = [repeatedFailureFinding([0, 1, 2, 3]), retryWithoutStateChangeFinding([0, 1])];
    const cls = classification({ class: "stalled_retry", progress: "none", semanticRedundancy: "high", newEvidence: false, newHypothesis: false });
    const decisionInput = input({ stepIndexes: [3, 1, 2, 0], deterministicEvidence: evidence, classification: cls });
    const snapshotBefore = JSON.stringify(decisionInput);
    decideFindingPolicy(decisionInput);
    assert.strictEqual(JSON.stringify(decisionInput), snapshotBefore);
  });

  test("returned stepIndexes/deterministicEvidence are fresh arrays, not aliases of the input", () => {
    const evidence: DeterministicEvidence[] = [repeatedFailureFinding([0, 1])];
    const decisionInput = input({ stepIndexes: [0, 1], deterministicEvidence: evidence });
    const decision = decideFindingPolicy(decisionInput);
    assert.notStrictEqual(decision.stepIndexes, decisionInput.stepIndexes);
    assert.notStrictEqual(decision.deterministicEvidence, decisionInput.deterministicEvidence);
  });

  test("no arbitrary confidence score field appears anywhere on the decision", () => {
    const decision = decideFindingPolicy(input({ deterministicEvidence: [repeatedFailureFinding([0, 1])] }));
    assert.strictEqual((decision as unknown as Record<string, unknown>).confidence, undefined);
    assert.strictEqual((decision as unknown as Record<string, unknown>).score, undefined);
  });
});
