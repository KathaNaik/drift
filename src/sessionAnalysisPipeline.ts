/**
 * The single orchestration layer that runs one attributed trajectory (M7C)
 * through the full Drift analysis chain -- M8A deterministic findings, M8B
 * subagent overlap, M9B/M9B.2/M9B.3 semantic classification, and M10A's
 * decision policy -- and returns one decision per analysis window. Nothing
 * here decides what to DO with a decision: no UI, no persistence, no
 * redirect execution, no hook injection, no sustainability score, no
 * background monitoring. It only wires the existing modules together and
 * groups their evidence into windows.
 *
 * Windows are built ONLY from M8A/M8B evidence -- this module never scans
 * or classifies a trajectory step that no deterministic finding already
 * points at, so the local model is never run "blindly" over the whole
 * trajectory. When several findings/overlaps share at least one trajectory
 * step (directly, or transitively through a chain of shared steps), they
 * describe the same underlying activity and are merged into one window
 * before classification, so that activity is sent to the model exactly
 * once -- never once per finding that happens to describe it.
 */

import { DriftStorage } from "./storage";
import { LocalModelRuntime } from "./localModelRuntime";
import { TrajectoryStepWithUsage, TrajectoryUsage, UsageSummary, AttributedUsageRecord, summarize } from "./trajectoryUsageAttribution";
import { TrajectoryFeatureFinding, extractTrajectoryFeatures } from "./trajectoryFeatures";
import { SubagentOverlapFinding, detectSubagentOverlap } from "./subagentOverlap";
import { ClassificationResult, ClassificationRequest, classifyWindow } from "./semanticClassifier";
import { Decision, DeterministicEvidence, decideFindingPolicy } from "./findingDecisionPolicy";

export interface SessionAnalysisWindow {
  /** Every original trajectory step this window's evidence is grounded in, ascending, deduplicated. */
  stepIndexes: number[];
  deterministicFindings: TrajectoryFeatureFinding[];
  subagentOverlaps: SubagentOverlapFinding[];
  semanticResult: ClassificationResult;
  decision: Decision;
}

export interface SessionAnalysis {
  sessionId: string;
  analyses: SessionAnalysisWindow[];
}

/** Same "nearest preceding user_prompt step" rule trajectoryFeatures.ts/subagentOverlap.ts/semanticClassifier.ts each already use, duplicated here for the same reason as in those files. */
function buildOwnerPromptIndex(steps: TrajectoryStepWithUsage[]): number[] {
  const owner: number[] = [];
  let current = -1;
  for (const step of steps) {
    if (step.event.type === "user_prompt") current = step.index;
    owner.push(current);
  }
  return owner;
}

function usageForWindow(steps: TrajectoryStepWithUsage[], ownerPromptIndex: number[], stepIndexes: number[]): UsageSummary | undefined {
  const ownerIndexes = new Set<number>();
  for (const index of stepIndexes) {
    const owner = ownerPromptIndex[index];
    if (owner !== undefined && owner !== -1) ownerIndexes.add(owner);
  }

  const records: AttributedUsageRecord[] = [];
  for (const ownerIndex of ownerIndexes) {
    const usage = steps[ownerIndex]?.usage;
    if (usage) records.push(...usage.records);
  }
  return records.length > 0 ? summarize(records) : undefined;
}

interface EvidenceItem {
  type: string;
  stepIndexes: number[];
  finding?: TrajectoryFeatureFinding;
  overlap?: SubagentOverlapFinding;
}

interface EvidenceCluster {
  stepIndexes: number[];
  findings: TrajectoryFeatureFinding[];
  overlaps: SubagentOverlapFinding[];
}

/**
 * Groups M8A findings and M8B overlaps into windows by shared trajectory
 * steps -- a union-find over step-index membership, so two pieces of
 * evidence that share even one step (directly, or transitively through a
 * chain of other evidence) land in the same window, while evidence with
 * disjoint step indexes stays in separate windows. Processing order is
 * fixed (by each item's earliest step index, then its type name) purely so
 * clustering -- and the resulting window order -- is deterministic
 * regardless of the order findings/overlaps happen to arrive in.
 */
function clusterEvidence(findings: TrajectoryFeatureFinding[], overlaps: SubagentOverlapFinding[]): EvidenceCluster[] {
  const items: EvidenceItem[] = [
    ...findings.map((f) => ({ type: f.type, stepIndexes: f.stepIndexes, finding: f })),
    ...overlaps.map((o) => ({ type: o.type, stepIndexes: o.stepIndexes, overlap: o })),
  ];
  items.sort((a, b) => a.stepIndexes[0] - b.stepIndexes[0] || a.type.localeCompare(b.type));

  const stepOwner = new Map<number, number>();
  const clusters: Array<{ stepIndexes: Set<number>; items: EvidenceItem[] } | undefined> = [];

  for (const item of items) {
    const ownerClusters = new Set<number>();
    for (const index of item.stepIndexes) {
      const owner = stepOwner.get(index);
      if (owner !== undefined) ownerClusters.add(owner);
    }

    if (ownerClusters.size === 0) {
      const clusterIndex = clusters.length;
      clusters.push({ stepIndexes: new Set(item.stepIndexes), items: [item] });
      for (const index of item.stepIndexes) stepOwner.set(index, clusterIndex);
      continue;
    }

    const [targetIndex, ...mergeIndexes] = [...ownerClusters].sort((a, b) => a - b);
    const target = clusters[targetIndex]!;
    for (const index of item.stepIndexes) {
      target.stepIndexes.add(index);
      stepOwner.set(index, targetIndex);
    }
    target.items.push(item);

    for (const mergeIndex of mergeIndexes) {
      const merged = clusters[mergeIndex];
      if (!merged) continue;
      for (const index of merged.stepIndexes) {
        target.stepIndexes.add(index);
        stepOwner.set(index, targetIndex);
      }
      target.items.push(...merged.items);
      clusters[mergeIndex] = undefined;
    }
  }

  return clusters
    .filter((c): c is { stepIndexes: Set<number>; items: EvidenceItem[] } => c !== undefined)
    .map((c) => ({
      stepIndexes: [...c.stepIndexes].sort((a, b) => a - b),
      findings: c.items
        .filter((i): i is EvidenceItem & { finding: TrajectoryFeatureFinding } => i.finding !== undefined)
        .map((i) => i.finding)
        .sort((a, b) => a.stepIndexes[0] - b.stepIndexes[0] || a.type.localeCompare(b.type)),
      overlaps: c.items
        .filter((i): i is EvidenceItem & { overlap: SubagentOverlapFinding } => i.overlap !== undefined)
        .map((i) => i.overlap)
        .sort((a, b) => a.stepIndexes[0] - b.stepIndexes[0]),
    }))
    .sort((a, b) => a.stepIndexes[0] - b.stepIndexes[0]);
}

/**
 * Runs one attributed trajectory through the full analysis chain. Pure with
 * respect to trajectoryUsage (never mutated) and makes no writes to
 * storage; the only side effect is the local model inference calls
 * themselves, one per evidence window (never per individual finding, and
 * never for a trajectory step no finding points at). A window whose
 * inference call fails or returns invalid output still gets a decision --
 * decideFindingPolicy resolves an unsuccessful ClassificationResult to
 * "observe" -- so one window's semantic failure never aborts the rest of
 * the session's analysis.
 */
export async function analyzeSession(trajectoryUsage: TrajectoryUsage, storage: DriftStorage, runtime: LocalModelRuntime): Promise<SessionAnalysis> {
  const { sessionId, steps } = trajectoryUsage;
  const ownerPromptIndex = buildOwnerPromptIndex(steps);

  const findings = extractTrajectoryFeatures(trajectoryUsage);
  const overlaps = detectSubagentOverlap(trajectoryUsage, storage);
  const clusters = clusterEvidence(findings, overlaps);

  const analyses: SessionAnalysisWindow[] = [];

  for (const cluster of clusters) {
    const request: ClassificationRequest = {
      trajectoryUsage,
      features: findings,
      overlaps,
      focusStepIndexes: cluster.stepIndexes,
    };

    let semanticResult: ClassificationResult;
    try {
      semanticResult = await classifyWindow(request, storage, runtime);
    } catch (error) {
      // classifyWindow itself never throws (every failure path is reported
      // through its returned result) -- this is defense-in-depth only, so a
      // window's semantic step can never abort the rest of the session's
      // analysis regardless of how it fails.
      semanticResult = { classification: undefined, raw: undefined, success: false, error: error instanceof Error ? error.message : String(error) };
    }

    const deterministicEvidence: DeterministicEvidence[] = [...cluster.findings, ...cluster.overlaps];
    const decision = decideFindingPolicy({
      sessionId,
      stepIndexes: cluster.stepIndexes,
      deterministicEvidence,
      classification: semanticResult,
      attributedUsage: usageForWindow(steps, ownerPromptIndex, cluster.stepIndexes),
    });

    analyses.push({
      stepIndexes: [...cluster.stepIndexes],
      deterministicFindings: [...cluster.findings],
      subagentOverlaps: [...cluster.overlaps],
      semanticResult,
      decision,
    });
  }

  return { sessionId, analyses };
}
