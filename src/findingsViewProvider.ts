/**
 * The VS Code Findings view: renders the most recently produced M10B
 * SessionAnalysis as a compact tree, one top-level item per analysis
 * window. Nothing here re-derives or second-guesses a decision -- this is
 * a pure presentation layer over whatever analyzeSession() already
 * decided, so a "finding" the user sees here is exactly the one M10A
 * produced, never re-scored or filtered.
 *
 * Only the LATEST analysis is ever held (in memory only, never persisted
 * to storage) -- calling setAnalysis() again replaces it outright rather
 * than appending, so re-running "Drift: Analyze Session" can never
 * accumulate duplicate or stale entries.
 *
 * The primary row per window is a single compact line (state + a short
 * title derived from the evidence types involved); everything else --
 * step indexes, per-finding evidence, the semantic classification's
 * fields, attributed usage, reasonCodes -- is nested underneath as
 * expandable detail, never dumped as raw JSON.
 */

import * as vscode from "vscode";
import { DriftStorage } from "./storage";
import { normalizeRawEvent } from "./normalizedEvent";
import { buildTrajectory } from "./trajectory";
import { SessionAnalysis, SessionAnalysisWindow } from "./sessionAnalysisPipeline";
import { DecisionState, DeterministicEvidence } from "./findingDecisionPolicy";

const STATE_LABELS: Record<DecisionState, string> = {
  observe: "Observe",
  finding: "Finding",
  redirect_candidate: "Redirect Candidate",
};

/** Distinct icon per state so Observe/Finding/Redirect Candidate are visually distinguishable at a glance, not just by label text. Redirect Candidate is deliberately not given any action affordance here -- it is informational only. */
const STATE_ICONS: Record<DecisionState, vscode.ThemeIcon> = {
  observe: new vscode.ThemeIcon("eye"),
  finding: new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow")),
  redirect_candidate: new vscode.ThemeIcon("alert", new vscode.ThemeColor("charts.red")),
};

const FINDING_TYPE_LABELS: Record<string, string> = {
  unchanged_file_reread: "Unchanged file reread",
  repeated_command: "Repeated command",
  repeated_failure: "Repeated failure",
  retry_without_state_change: "Retry without state change",
  repeated_context: "Repeated context",
  subagent_overlap: "Subagent overlap",
};

function typeLabel(type: string): string {
  return FINDING_TYPE_LABELS[type] ?? type;
}

/** A short, human title from the evidence types involved -- never the raw finding/evidence payload. */
function buildTitle(window: SessionAnalysisWindow): string {
  const types = [...new Set([...window.deterministicFindings.map((f) => f.type), ...window.subagentOverlaps.map((o) => o.type)])];
  if (types.length === 0) return "Untitled";
  if (types.length === 1) return typeLabel(types[0]);
  return `${typeLabel(types[0])} + ${types.length - 1} more`;
}

/** Renders one evidence value compactly -- truncated strings, flattened one level of nested object, never a full JSON dump. */
function formatEvidenceValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.length} item(s)]`;
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? "…" : String(v)}`)
      .join(", ");
  }
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function formatEvidenceEntry(evidence: Record<string, unknown>): string {
  return Object.entries(evidence)
    .map(([key, value]) => `${key}: ${formatEvidenceValue(value)}`)
    .join(", ");
}

type FindingsTreeNode =
  | { kind: "placeholder"; message: string }
  | { kind: "window"; sessionId: string; window: SessionAnalysisWindow }
  | { kind: "steps"; sessionId: string; window: SessionAnalysisWindow }
  | { kind: "evidenceGroup"; sessionId: string; window: SessionAnalysisWindow }
  | { kind: "evidenceItem"; evidence: DeterministicEvidence }
  | { kind: "semantic"; window: SessionAnalysisWindow }
  | { kind: "usage"; window: SessionAnalysisWindow }
  | { kind: "reasonCodes"; window: SessionAnalysisWindow };

export const SHOW_FINDING_STEPS_COMMAND = "drift.showFindingSteps";

/**
 * A compact, human-readable (never raw-JSON) line per involved trajectory
 * step -- the "link back to the relevant trajectory steps" the finding
 * points at. Reads storage only; never mutates it.
 */
export function buildStepDetailText(sessionId: string, window: SessionAnalysisWindow, storage: DriftStorage): string {
  const sessionData = storage.getSession(sessionId);
  if (!sessionData) return `Session ${sessionId} is no longer available.`;

  const trajectory = buildTrajectory(sessionId, sessionData.events.map(normalizeRawEvent));
  const lines = window.stepIndexes.map((index) => {
    const step = trajectory.steps[index];
    if (!step) return `Step ${index}: (not found)`;
    const data = step.event.data;
    const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
    const hasResult = Object.prototype.hasOwnProperty.call(data, "toolResponse");
    const resultText = hasResult ? formatEvidenceValue(data.toolResponse) : undefined;
    return `Step ${index}: ${step.event.hookEventName}${toolName ? ` (${toolName})` : ""}${resultText !== undefined ? ` -> ${resultText}` : ""}`;
  });
  return lines.join("\n");
}

export class DriftFindingsProvider implements vscode.TreeDataProvider<FindingsTreeNode> {
  private analysis: SessionAnalysis | undefined;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Replaces whatever analysis was previously shown -- never appends, so a repeated "Analyze Session" run can never accumulate duplicate windows. */
  setAnalysis(analysis: SessionAnalysis | undefined): void {
    this.analysis = analysis;
    this._onDidChangeTreeData.fire();
  }

  getCurrentAnalysis(): SessionAnalysis | undefined {
    return this.analysis;
  }

  getTreeItem(node: FindingsTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "placeholder": {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }

      case "window": {
        const { window } = node;
        const item = new vscode.TreeItem(`${STATE_LABELS[window.decision.state]}: ${buildTitle(window)}`, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = STATE_ICONS[window.decision.state];
        item.description = `${window.stepIndexes.length} step(s)`;
        item.contextValue = `drift.finding.${window.decision.state}`;
        return item;
      }

      case "steps": {
        const item = new vscode.TreeItem(`Steps: ${node.window.stepIndexes.join(", ")}`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("list-ordered");
        item.command = { command: SHOW_FINDING_STEPS_COMMAND, title: "Show Trajectory Steps", arguments: [node.sessionId, node.window] };
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
        // A failed/invalid classification is contained and shown plainly --
        // never thrown, never a raw JSON dump of the failure.
        const item = new vscode.TreeItem(`Semantic: unavailable (${result.error ?? "no result"})`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("circle-slash");
        return item;
      }

      case "usage": {
        const usage = node.window.decision.attributedUsage!;
        const parts = [`${usage.modelCalls} call(s)`];
        if (usage.inputTokens !== undefined) parts.push(`${usage.inputTokens} in`);
        if (usage.outputTokens !== undefined) parts.push(`${usage.outputTokens} out`);
        const item = new vscode.TreeItem(`Usage: ${parts.join(", ")}`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("pulse");
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

  getChildren(node?: FindingsTreeNode): FindingsTreeNode[] {
    if (!node) {
      if (!this.analysis || this.analysis.analyses.length === 0) {
        return [{ kind: "placeholder", message: 'Run "Drift: Analyze Session" to see findings.' }];
      }
      return this.analysis.analyses.map((window) => ({ kind: "window", sessionId: this.analysis!.sessionId, window }));
    }

    switch (node.kind) {
      case "window": {
        const children: FindingsTreeNode[] = [
          { kind: "steps", sessionId: node.sessionId, window: node.window },
          { kind: "evidenceGroup", sessionId: node.sessionId, window: node.window },
          { kind: "semantic", window: node.window },
        ];
        if (node.window.decision.attributedUsage) children.push({ kind: "usage", window: node.window });
        children.push({ kind: "reasonCodes", window: node.window });
        return children;
      }
      case "evidenceGroup":
        return [...node.window.deterministicFindings, ...node.window.subagentOverlaps].map((evidence) => ({ kind: "evidenceItem", evidence }));
      default:
        return [];
    }
  }
}
