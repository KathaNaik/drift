/**
 * A pure, deterministic decision-policy layer combining M8A deterministic
 * findings, M8B subagent overlap, M9B/M9B.2/M9B.3 validated semantic
 * classification, and M7C attributed usage into one of three states:
 * "observe", "finding", or "redirect_candidate". The local model never
 * chooses the policy state -- it only ever produced the (already strictly
 * schema- and consistency-validated) SemanticClassification this module
 * reads as one more input alongside the deterministic evidence. Every
 * branch here is a plain, named, structural rule over already-known facts;
 * there is no confidence score, threshold tuning, or model-derived weight
 * anywhere in this file.
 *
 * This module does not decide what a caller should DO with a decision --
 * no UI, no redirect action, no hook injection, no sustainability score,
 * no auto-blocking. It only classifies one already-assembled window of
 * evidence into a state, with the reasoning trail (reasonCodes) a caller
 * can act on however it chooses.
 */

import { TrajectoryFeatureFinding, TrajectoryFeatureType } from "./trajectoryFeatures";
import { SubagentOverlapFinding } from "./subagentOverlap";
import { ClassificationResult } from "./semanticClassifier";
import { UsageSummary } from "./trajectoryUsageAttribution";

export type DecisionState = "observe" | "finding" | "redirect_candidate";

export type DeterministicEvidence = TrajectoryFeatureFinding | SubagentOverlapFinding;

/**
 * Deterministic finding types that, on their own, indicate an objectively
 * unproductive or duplicated pattern (a structural failure repeating, a
 * retry that changed nothing, identical context consumed again, or two
 * distinct agents overlapping) rather than merely a command or file being
 * touched more than once, which can be entirely legitimate on its own.
 * "repeated_command" and "unchanged_file_reread" are deliberately excluded:
 * per M10A's own examples, a single isolated instance of either stays
 * "observe" even though the M8A detector already required 2+ occurrences
 * to produce the finding at all.
 */
const STRONG_FINDING_TYPES = new Set<TrajectoryFeatureType | "subagent_overlap">([
  "repeated_failure",
  "retry_without_state_change",
  "repeated_context",
  "subagent_overlap",
]);

export interface Decision {
  state: DecisionState;
  sessionId: string;
  /** Every step index this decision is grounded in, ascending, deduplicated. */
  stepIndexes: number[];
  deterministicEvidence: DeterministicEvidence[];
  /** Present only when semantic classification succeeded and passed schema + consistency validation. */
  semanticEvidence: ClassificationResult["classification"];
  attributedUsage: UsageSummary | undefined;
  reasonCodes: string[];
}

export interface DecisionInput {
  sessionId: string;
  stepIndexes: number[];
  deterministicEvidence: DeterministicEvidence[];
  classification: ClassificationResult;
  attributedUsage: UsageSummary | undefined;
}

function dedupedAscending(indexes: number[]): number[] {
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function build(input: DecisionInput, state: DecisionState, reasonCodes: string[]): Decision {
  return {
    state,
    sessionId: input.sessionId,
    stepIndexes: dedupedAscending(input.stepIndexes),
    deterministicEvidence: [...input.deterministicEvidence],
    semanticEvidence: input.classification.success ? input.classification.classification : undefined,
    attributedUsage: input.attributedUsage,
    reasonCodes,
  };
}

/**
 * Whether the validated semantic classification corroborates the
 * deterministic evidence's implication of a low-value pattern, per M10A's
 * own worked examples: a stalled_retry backs up a repeated-failure/
 * retry-without-state-change signal, a duplicate_subagent_work backs up a
 * subagent_overlap signal, and reported high semanticRedundancy backs up
 * any strong repetition signal (e.g. repeated_context). productive_retry
 * never corroborates anything here -- a retry that actually succeeded is
 * the opposite of a low-value pattern, regardless of what any other field
 * says, so it is excluded even from otherwise-matching combinations.
 */
function semanticCorroborates(deterministicEvidence: DeterministicEvidence[], semantic: NonNullable<ClassificationResult["classification"]>): boolean {
  if (semantic.class === "productive_retry") return false;

  const hasType = (type: string) => deterministicEvidence.some((f) => f.type === type);

  if (semantic.class === "stalled_retry" && (hasType("repeated_failure") || hasType("retry_without_state_change"))) return true;
  if (semantic.class === "duplicate_subagent_work" && hasType("subagent_overlap")) return true;
  if (semantic.semanticRedundancy === "high" && deterministicEvidence.some((f) => STRONG_FINDING_TYPES.has(f.type as TrajectoryFeatureType | "subagent_overlap"))) return true;

  return false;
}

/**
 * Classifies one already-assembled window of evidence into a policy state.
 * Deterministic: the same input always produces the same output, and
 * nothing here is mutated -- deterministicEvidence/classification/
 * attributedUsage are only ever read, never written to, and the returned
 * stepIndexes/deterministicEvidence are fresh arrays, not aliases of the
 * caller's own.
 */
export function decideFindingPolicy(input: DecisionInput): Decision {
  const { deterministicEvidence, classification } = input;

  if (!classification.success || classification.classification === undefined) {
    return build(input, "observe", ["semantic_classification_invalid_or_failed"]);
  }
  const semantic = classification.classification;

  if (deterministicEvidence.length === 0) {
    return build(input, "observe", ["no_deterministic_evidence"]);
  }

  const hasStrongSignal = deterministicEvidence.some((f) => STRONG_FINDING_TYPES.has(f.type as TrajectoryFeatureType | "subagent_overlap"));
  if (!hasStrongSignal) {
    return build(input, "observe", ["no_strong_deterministic_signal"]);
  }

  if (!semanticCorroborates(deterministicEvidence, semantic)) {
    return build(input, "observe", semantic.class === "productive_retry" ? ["productive_retry_excludes_low_value_pattern"] : ["no_semantic_corroboration"]);
  }

  const findingReasonCodes = ["strong_deterministic_signal", "semantic_corroboration_confirmed"];

  const redirectBlockers: string[] = [];
  if (semantic.newEvidence) redirectBlockers.push("new_evidence_present");
  if (semantic.newHypothesis) redirectBlockers.push("new_hypothesis_present");
  if (semantic.progress !== "none" && semantic.progress !== "low") redirectBlockers.push("progress_not_none_or_low");
  if (semantic.semanticRedundancy !== "high") redirectBlockers.push("semantic_redundancy_not_high");
  if (deterministicEvidence.length < 2) redirectBlockers.push("insufficient_corroborating_structural_signals");

  if (redirectBlockers.length > 0) {
    return build(input, "finding", [...findingReasonCodes, ...redirectBlockers]);
  }

  return build(input, "redirect_candidate", [...findingReasonCodes, "no_new_evidence", "no_new_hypothesis", "low_or_no_progress", "high_semantic_redundancy", "multiple_corroborating_structural_signals"]);
}
