/**
 * The VS Code Trajectory Inspector: a read-only, step-by-step view of one
 * session's trajectory in exact original order. This module never
 * reconstructs, reorders, or filters steps for presentation -- it renders
 * whatever TrajectoryUsage.steps already is, one tree row per step, in the
 * same array order buildTrajectory()/attributeUsageToTrajectory() produced.
 *
 * It never runs the local model, never calls analyzeSession(), and never
 * writes to storage: opening or reopening the inspector, for the same or a
 * different session, only ever replaces this provider's in-memory view --
 * it is never appended to and nothing is persisted. When a M10B
 * SessionAnalysis for the SAME session is available (the caller passes
 * whatever the Findings view most recently produced -- see
 * DriftFindingsProvider.getCurrentAnalysis() in extension.ts), each step it
 * covers is visually marked with that analysis's decision state and, when
 * expanded, exposes that analysis's complete evidence and reasonCodes. A
 * session with no analysis yet still renders its full raw trajectory.
 */

import * as vscode from "vscode";
import { DriftRawEvent } from "./storage";
import { TrajectoryStepWithUsage, TrajectoryUsage, UsageSummary } from "./trajectoryUsageAttribution";
import { SessionAnalysis, SessionAnalysisWindow } from "./sessionAnalysisPipeline";
import { DeterministicEvidence } from "./findingDecisionPolicy";
import { STATE_LABELS, STATE_ICONS, typeLabel, formatEvidenceValue, formatEvidenceEntry } from "./findingsViewProvider";

export const OPEN_INSPECTOR_AT_STEP_COMMAND = "drift.openInspectorAtStep";

const EVENT_TYPE_LABELS: Record<string, string> = {
  session_start: "Session Start",
  session_end: "Session End",
  user_prompt: "User Prompt",
  tool_invocation: "Tool Call",
  tool_result: "Tool Result",
  subagent_lifecycle: "Subagent Lifecycle",
  task_lifecycle: "Task Lifecycle",
  compaction: "Compaction",
  generic: "Event",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface StepRow {
  index: number;
  eventType: string;
  hookEventName: string;
  toolName: string | undefined;
  inputSummary: string | undefined;
  outcome: "success" | "failure" | undefined;
  resultSummary: string | undefined;
  usage: UsageSummary | undefined;
  agentId: string | undefined;
  linkedStepIndex: number | undefined;
}

function rawAgentId(rawEvent: DriftRawEvent | undefined): string | undefined {
  if (!rawEvent || !isPlainObject(rawEvent.payload)) return undefined;
  return typeof rawEvent.payload.agent_id === "string" ? rawEvent.payload.agent_id : undefined;
}

function buildStepRow(step: TrajectoryStepWithUsage, rawEventsById: Map<number, DriftRawEvent>): StepRow {
  const data = step.event.data;
  const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
  const outcome: "success" | "failure" | undefined =
    step.event.type === "tool_result" ? (step.event.hookEventName === "PostToolUseFailure" ? "failure" : "success") : undefined;
  const hasResult = Object.prototype.hasOwnProperty.call(data, "toolResponse");
  const inputSummary = data.toolInput !== undefined ? formatEvidenceValue(data.toolInput) : typeof data.prompt === "string" ? formatEvidenceValue(data.prompt) : undefined;

  return {
    index: step.index,
    eventType: step.event.type,
    hookEventName: step.event.hookEventName,
    toolName,
    inputSummary,
    outcome,
    resultSummary: hasResult ? formatEvidenceValue(data.toolResponse) : undefined,
    usage: step.usage,
    agentId: rawAgentId(rawEventsById.get(step.event.rawEventId)),
    linkedStepIndex: step.linkedStepIndex,
  };
}

// Nested nodes each carry the stepIndex of the step row they were expanded
// from, purely so getParent() can reconstruct the exact chain back to that
// root "step" node -- VS Code's TreeView.reveal() requires getParent to be
// implemented, even to reveal a root-level element.
export type InspectorNode =
  | { kind: "placeholder"; message: string }
  | { kind: "step"; sessionId: string; step: StepRow; window: SessionAnalysisWindow | undefined }
  | { kind: "analysis"; stepIndex: number; window: SessionAnalysisWindow }
  | { kind: "evidenceGroup"; stepIndex: number; window: SessionAnalysisWindow }
  | { kind: "evidenceItem"; stepIndex: number; evidence: DeterministicEvidence }
  | { kind: "semantic"; stepIndex: number; window: SessionAnalysisWindow }
  | { kind: "reasonCodes"; stepIndex: number; window: SessionAnalysisWindow };

export class DriftTrajectoryInspectorProvider implements vscode.TreeDataProvider<InspectorNode> {
  private sessionId: string | undefined;
  private steps: StepRow[] = [];
  private windowByStep = new Map<number, SessionAnalysisWindow>();

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /**
   * Replaces whatever trajectory/overlay was previously shown -- never
   * appends, so repeatedly opening the inspector (for the same or a
   * different session) can never accumulate stale or duplicate rows.
   * `analysis` is only used as an overlay when it belongs to this exact
   * `sessionId`; a leftover analysis for a different session is ignored
   * rather than misapplied.
   */
  setData(sessionId: string, trajectoryUsage: TrajectoryUsage, rawEventsById: Map<number, DriftRawEvent>, analysis: SessionAnalysis | undefined): void {
    this.sessionId = sessionId;
    this.steps = trajectoryUsage.steps.map((step) => buildStepRow(step, rawEventsById));

    this.windowByStep = new Map();
    if (analysis && analysis.sessionId === sessionId) {
      for (const window of analysis.analyses) {
        for (const index of window.stepIndexes) this.windowByStep.set(index, window);
      }
    }

    this._onDidChangeTreeData.fire();
  }

  getCurrentSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Required by VS Code for TreeView.reveal() to work, including for root-level "step" elements. Reconstructs the logical parent from the node's own stepIndex/window rather than tracking object identity. */
  getParent(element: InspectorNode): InspectorNode | undefined {
    switch (element.kind) {
      case "placeholder":
      case "step":
        return undefined;
      case "analysis": {
        const step = this.steps[element.stepIndex];
        if (!step || !this.sessionId) return undefined;
        return { kind: "step", sessionId: this.sessionId, step, window: this.windowByStep.get(step.index) };
      }
      case "evidenceGroup":
      case "semantic":
      case "reasonCodes":
        return { kind: "analysis", stepIndex: element.stepIndex, window: element.window };
      case "evidenceItem": {
        const window = this.windowByStep.get(element.stepIndex);
        return window ? { kind: "evidenceGroup", stepIndex: element.stepIndex, window } : undefined;
      }
    }
  }

  getTreeItem(node: InspectorNode): vscode.TreeItem {
    switch (node.kind) {
      case "placeholder": {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }

      case "step": {
        const { step, window } = node;
        const typeText = EVENT_TYPE_LABELS[step.eventType] ?? step.hookEventName;
        const label = `#${step.index} ${typeText}${step.toolName ? ` (${step.toolName})` : ""}`;
        const item = new vscode.TreeItem(label, window ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);

        const descriptionParts: string[] = [];
        if (step.outcome) descriptionParts.push(`-> ${step.outcome}`);
        if (step.inputSummary) descriptionParts.push(step.inputSummary);
        if (step.resultSummary) descriptionParts.push(`= ${step.resultSummary}`);
        if (step.agentId) descriptionParts.push(`agent:${step.agentId}`);
        if (step.linkedStepIndex !== undefined) {
          descriptionParts.push(step.eventType === "tool_result" ? `(from step ${step.linkedStepIndex})` : `(-> step ${step.linkedStepIndex})`);
        }
        if (step.usage) {
          const usageParts = [`${step.usage.modelCalls} call(s)`];
          if (step.usage.inputTokens !== undefined) usageParts.push(`${step.usage.inputTokens} in`);
          if (step.usage.outputTokens !== undefined) usageParts.push(`${step.usage.outputTokens} out`);
          descriptionParts.push(usageParts.join(", "));
        }
        item.description = descriptionParts.join("  ");

        if (window) {
          item.iconPath = STATE_ICONS[window.decision.state];
          const referencingTypes = [...window.deterministicFindings, ...window.subagentOverlaps]
            .filter((e) => e.stepIndexes.includes(step.index))
            .map((e) => typeLabel(e.type));
          const semanticClass = window.semanticResult.success && window.semanticResult.classification ? window.semanticResult.classification.class : undefined;
          item.tooltip = [
            `${STATE_LABELS[window.decision.state]}${referencingTypes.length > 0 ? ` — ${referencingTypes.join(", ")}` : ""}`,
            semanticClass ? `class: ${semanticClass}` : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join("\n");
          item.contextValue = `drift.inspectorStep.${window.decision.state}`;
        } else {
          item.iconPath = new vscode.ThemeIcon("circle-outline");
          item.contextValue = "drift.inspectorStep";
        }
        return item;
      }

      case "analysis": {
        const item = new vscode.TreeItem(`Analysis: ${STATE_LABELS[node.window.decision.state]}`, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = STATE_ICONS[node.window.decision.state];
        return item;
      }

      case "evidenceGroup": {
        const count = node.window.deterministicFindings.length + node.window.subagentOverlaps.length;
        const item = new vscode.TreeItem(`Evidence (${count})`, count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("checklist");
        return item;
      }

      case "evidenceItem": {
        const item = new vscode.TreeItem(typeLabel(node.evidence.type), vscode.TreeItemCollapsibleState.None);
        const summary = formatEvidenceEntry(node.evidence.evidence);
        item.description = summary;
        item.tooltip = summary;
        item.iconPath = new vscode.ThemeIcon("circle-small");
        return item;
      }

      case "semantic": {
        const result = node.window.semanticResult;
        if (result.success && result.classification) {
          const c = result.classification;
          const label = `Semantic: ${c.class} · progress=${c.progress} · newEvidence=${c.newEvidence} · newHypothesis=${c.newHypothesis} · redundancy=${c.semanticRedundancy}`;
          const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
          item.iconPath = new vscode.ThemeIcon("symbol-class");
          return item;
        }
        const item = new vscode.TreeItem(`Semantic: unavailable (${result.error ?? "no result"})`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("circle-slash");
        return item;
      }

      case "reasonCodes": {
        const codes = node.window.decision.reasonCodes;
        const item = new vscode.TreeItem(`Why: ${codes.join(", ")}`, vscode.TreeItemCollapsibleState.None);
        item.tooltip = codes.join("\n");
        item.iconPath = new vscode.ThemeIcon("comment");
        return item;
      }
    }
  }

  getChildren(node?: InspectorNode): InspectorNode[] {
    if (!node) {
      if (!this.sessionId || this.steps.length === 0) {
        return [{ kind: "placeholder", message: 'Run "Drift: Inspect Session" to view a trajectory.' }];
      }
      return this.steps.map((step) => ({ kind: "step", sessionId: this.sessionId!, step, window: this.windowByStep.get(step.index) }));
    }

    switch (node.kind) {
      case "step":
        return node.window ? [{ kind: "analysis", stepIndex: node.step.index, window: node.window }] : [];
      case "analysis":
        return [
          { kind: "evidenceGroup", stepIndex: node.stepIndex, window: node.window },
          { kind: "semantic", stepIndex: node.stepIndex, window: node.window },
          { kind: "reasonCodes", stepIndex: node.stepIndex, window: node.window },
        ];
      case "evidenceGroup":
        return [...node.window.deterministicFindings, ...node.window.subagentOverlaps].map((evidence) => ({ kind: "evidenceItem", stepIndex: node.stepIndex, evidence }));
      default:
        return [];
    }
  }
}
