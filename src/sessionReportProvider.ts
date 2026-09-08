/**
 * The VS Code presentation layer for the M11C end-of-session report: a
 * compact, read-only tree over whatever buildSessionReport() (sessionReport.ts)
 * already computed. This file only formats already-known values -- it never
 * derives a new metric, count, or verdict of its own, and it never touches
 * the local model or storage.
 *
 * Terminology guard: nothing rendered here may claim compute was "saved" or
 * "avoided" -- Drift has not run a controlled intervention experiment.
 * Findings are always "detected", never "prevented".
 */

import * as vscode from "vscode";
import { SessionReport, EvidenceSummaryEntry } from "./sessionReport";
import { STATE_LABELS, STATE_ICONS, typeLabel } from "./findingsViewProvider";

type ReportNode =
  | { kind: "placeholder"; message: string }
  | { kind: "section"; id: "summary" | "usage" | "findings" | "evidence" | "outcome"; report: SessionReport }
  | { kind: "field"; label: string; description?: string; tooltip?: string; icon?: string }
  | { kind: "evidenceEntry"; entry: EvidenceSummaryEntry; index: number }
  | { kind: "evidenceEntryDetail"; label: string; description?: string; tooltip?: string };

function field(label: string, description?: string | number, tooltip?: string): ReportNode {
  return { kind: "field", label, description: description === undefined ? undefined : String(description), tooltip };
}

function usageFields(usage: SessionReport["usage"]): ReportNode[] {
  const nodes: ReportNode[] = [field("Model calls", usage.modelCalls)];
  if (usage.inputTokens !== undefined) nodes.push(field("Input tokens", usage.inputTokens));
  if (usage.outputTokens !== undefined) nodes.push(field("Output tokens", usage.outputTokens));
  if (usage.cacheReadTokens !== undefined) nodes.push(field("Cache read tokens", usage.cacheReadTokens));
  if (usage.cacheWriteTokens !== undefined) nodes.push(field("Cache write tokens", usage.cacheWriteTokens));
  if (usage.costUsd !== undefined) nodes.push(field("Cost (USD)", usage.costUsd));
  if (usage.durationMs !== undefined) nodes.push(field("Duration (ms)", usage.durationMs));
  return nodes;
}

export class DriftSessionReportProvider implements vscode.TreeDataProvider<ReportNode> {
  private report: SessionReport | undefined;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Replaces whatever report was previously shown -- never appends, so repeatedly opening the report (for the same or a different session) can never accumulate stale sections. */
  setReport(report: SessionReport | undefined): void {
    this.report = report;
    this._onDidChangeTreeData.fire();
  }

  getCurrentReport(): SessionReport | undefined {
    return this.report;
  }

  getTreeItem(node: ReportNode): vscode.TreeItem {
    switch (node.kind) {
      case "placeholder": {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }

      case "field": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.tooltip = node.tooltip ?? node.description;
        return item;
      }

      case "section": {
        const report = node.report;
        switch (node.id) {
          case "summary": {
            const item = new vscode.TreeItem("Session Summary", vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon("notebook");
            return item;
          }
          case "usage": {
            const item = new vscode.TreeItem("Model Usage", vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon("pulse");
            return item;
          }
          case "findings": {
            if (!report.findings) {
              const item = new vscode.TreeItem("Drift Findings: no analysis has been run yet", vscode.TreeItemCollapsibleState.None);
              item.iconPath = new vscode.ThemeIcon("info");
              return item;
            }
            const item = new vscode.TreeItem("Drift Findings", vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon("checklist");
            item.description = `${report.findings.observeCount + report.findings.findingCount + report.findings.redirectCandidateCount} analyzed`;
            return item;
          }
          case "evidence": {
            const count = report.evidenceSummary?.length ?? 0;
            const item = new vscode.TreeItem("Evidence Summary", count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon("list-tree");
            item.description = count > 0 ? `${count} detected` : "none detected";
            return item;
          }
          case "outcome": {
            const item = new vscode.TreeItem("Outcome", vscode.TreeItemCollapsibleState.Collapsed);
            item.iconPath = new vscode.ThemeIcon("milestone");
            return item;
          }
        }
        break;
      }

      case "evidenceEntry": {
        const { entry } = node;
        const item = new vscode.TreeItem(`${STATE_LABELS[entry.state]}: steps ${entry.stepIndexes.join(", ")}`, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = STATE_ICONS[entry.state];
        return item;
      }

      case "evidenceEntryDetail": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.tooltip = node.tooltip ?? node.description;
        return item;
      }
    }
  }

  getChildren(node?: ReportNode): ReportNode[] {
    if (!node) {
      if (!this.report) {
        return [{ kind: "placeholder", message: 'Run "Drift: View Session Report" to generate a report.' }];
      }
      const report = this.report;
      const sections: ReportNode[] = [
        { kind: "section", id: "summary", report },
        { kind: "section", id: "usage", report },
        { kind: "section", id: "findings", report },
      ];
      if (report.evidenceSummary !== undefined) sections.push({ kind: "section", id: "evidence", report });
      sections.push({ kind: "section", id: "outcome", report });
      return sections;
    }

    switch (node.kind) {
      case "section": {
        const { report } = node;
        switch (node.id) {
          case "summary":
            return [
              field("Session ID", report.summary.sessionId),
              field("Total steps", report.summary.totalSteps),
              field("Tool calls", report.summary.toolCallCount),
              ...(report.summary.subagentCount !== undefined ? [field("Subagents", report.summary.subagentCount)] : []),
            ];
          case "usage":
            return usageFields(report.usage);
          case "findings": {
            if (!report.findings) return [];
            const f = report.findings;
            const typeFields = Object.entries(f.evidenceTypeCounts)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([type, count]) => field(`Detected pattern: ${typeLabel(type)}`, count));
            return [
              field("Observe", f.observeCount),
              field("Finding", f.findingCount),
              field("Redirect Candidate", f.redirectCandidateCount),
              ...typeFields,
              ...(f.semanticClassesObserved.length > 0 ? [field("Semantic classes observed", f.semanticClassesObserved.join(", "))] : []),
            ];
          }
          case "evidence":
            return (report.evidenceSummary ?? []).map((entry, index) => ({ kind: "evidenceEntry", entry, index }));
          case "outcome": {
            const o = report.outcome;
            const nodes: ReportNode[] = [];
            if (o.finalToolCall) {
              const t = o.finalToolCall;
              nodes.push(
                field(
                  "Final tool call",
                  `${t.toolName ?? "unknown"} -> ${t.outcome}`,
                  `step ${t.stepIndex}${t.inputSummary ? ` — ${t.inputSummary}` : ""}`
                )
              );
            }
            if (o.sessionEndReason !== undefined) nodes.push(field("Session end reason", o.sessionEndReason));
            if (nodes.length === 0) nodes.push(field("No objective outcome evidence available."));
            return nodes;
          }
        }
        break;
      }

      case "evidenceEntry": {
        const { entry } = node;
        return [
          { kind: "evidenceEntryDetail", label: "Deterministic evidence", description: entry.deterministicEvidenceTypes.map(typeLabel).join(", ") },
          { kind: "evidenceEntryDetail", label: "Semantic class", description: entry.semanticClass ?? "(none valid)" },
          { kind: "evidenceEntryDetail", label: "Reason codes", description: entry.reasonCodes.join(", "), tooltip: entry.reasonCodes.join("\n") },
          ...(entry.attributedUsage
            ? [
                {
                  kind: "evidenceEntryDetail" as const,
                  label: "Attributed usage",
                  description: `${entry.attributedUsage.modelCalls} call(s)${entry.attributedUsage.inputTokens !== undefined ? `, ${entry.attributedUsage.inputTokens} in` : ""}${entry.attributedUsage.outputTokens !== undefined ? `/${entry.attributedUsage.outputTokens} out` : ""}`,
                },
              ]
            : []),
        ];
      }

      default:
        return [];
    }
  }
}
