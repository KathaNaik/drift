import * as vscode from "vscode";

export type RuntimeStatus = "online" | "offline";

export class DriftSidebarProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private status: RuntimeStatus = "offline";

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  setStatus(status: RuntimeStatus): void {
    this.status = status;
    this._onDidChangeTreeData.fire();
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const label = this.status === "online" ? "Runtime: Online" : "Runtime: Offline";
    return [new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None)];
  }
}
