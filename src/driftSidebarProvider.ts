import * as vscode from "vscode";

export type RuntimeStatus = "online" | "offline";

/** "unknown" only until the first async check resolves after activation -- never shown as a false "not_ready". */
export type SetupStepStatus = "unknown" | "ready" | "not_ready";

/**
 * M16: the sidebar is the first thing a newly-installed user sees, so it
 * must make the two setup steps Drift can't do for itself (the local
 * model/runtime, and per-workspace Claude Code hooks) immediately visible
 * and immediately actionable -- each row that isn't ready is clickable and
 * runs the real command that fixes it, so no Command Palette search or
 * terminal use is required for normal setup.
 */
export class DriftSidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private status: RuntimeStatus = "offline";
  private modelStatus: SetupStepStatus = "unknown";
  private hooksStatus: SetupStepStatus = "unknown";
  private hasWorkspaceFolder = false;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  setStatus(status: RuntimeStatus): void {
    this.status = status;
    this._onDidChangeTreeData.fire();
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  setModelStatus(status: SetupStepStatus): void {
    this.modelStatus = status;
    this._onDidChangeTreeData.fire();
  }

  setHooksStatus(status: SetupStepStatus, hasWorkspaceFolder: boolean): void {
    this.hooksStatus = status;
    this.hasWorkspaceFolder = hasWorkspaceFolder;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return [this.runtimeItem(), this.modelItem(), this.hooksItem()];
  }

  private runtimeItem(): vscode.TreeItem {
    return new vscode.TreeItem(this.status === "online" ? "Runtime: Online" : "Runtime: Offline", vscode.TreeItemCollapsibleState.None);
  }

  private modelItem(): vscode.TreeItem {
    let label: string;
    if (this.modelStatus === "ready") label = "Local Model: Ready";
    else if (this.modelStatus === "not_ready") label = "Local Model: Not Installed (click to set up)";
    else label = "Local Model: Checking...";

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    if (this.modelStatus === "not_ready") {
      item.command = { command: "drift.setupLocalModel", title: "Drift: Setup Local Model" };
    }
    return item;
  }

  private hooksItem(): vscode.TreeItem {
    let label: string;
    if (!this.hasWorkspaceFolder) label = "Claude Hooks: Open a workspace folder to configure";
    else if (this.hooksStatus === "ready") label = "Claude Hooks: Configured";
    else if (this.hooksStatus === "not_ready") label = "Claude Hooks: Not Configured (click to set up)";
    else label = "Claude Hooks: Checking...";

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    if (this.hasWorkspaceFolder && this.hooksStatus === "not_ready") {
      item.command = { command: "drift.installClaudeHooks", title: "Drift: Configure Claude Code Hooks" };
    }
    return item;
  }
}
