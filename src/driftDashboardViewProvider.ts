import * as vscode from "vscode";
import { DriftSidebarProvider, RuntimeStatus, SetupStepStatus } from "./driftSidebarProvider";

/**
 * M17: Drift's own dashboard, replacing the plain "Runtime/Local Model/
 * Claude Hooks" TreeView that used to render as a generic collapsible
 * section under the Drift Activity Bar icon. This is now the sole view
 * registered at the "drift.sidebar" id, so clicking the Drift icon opens
 * this webview directly. It never runs analysis, hook installation, or
 * model setup itself -- every button and clickable status pill posts a
 * message back to the extension host, which executes the exact same
 * command the Command Palette already exposes (see
 * DriftDashboardDeps.executeCommand). DriftSidebarProvider remains the
 * single source of truth for status; this class only reads it and
 * re-renders when it changes.
 */
export interface DriftDashboardDeps {
  executeCommand: (command: string) => Thenable<unknown>;
}

const defaultDashboardDeps: DriftDashboardDeps = {
  executeCommand: (command) => vscode.commands.executeCommand(command),
};

export interface DashboardState {
  runtime: RuntimeStatus;
  model: SetupStepStatus;
  hooks: SetupStepStatus;
  hasWorkspaceFolder: boolean;
}

interface DashboardAction {
  command: string;
  label: string;
  accent: string;
  /** Inline SVG child markup only (no outer <svg> tag) -- keeps every icon self-contained, with no external file/codicon font dependency. */
  icon: string;
}

const ACTIONS: DashboardAction[] = [
  {
    command: "drift.analyzeSession",
    label: "Analyze Session",
    accent: "#7DD3FC",
    icon: '<circle cx="6.5" cy="6.5" r="4.5"/><line x1="9.8" y1="9.8" x2="14" y2="14"/>',
  },
  {
    command: "drift.inspectSession",
    label: "Inspect Session",
    accent: "#C4B5FD",
    icon: '<line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="11" y2="8"/><line x1="2" y1="12" x2="8" y2="12"/>',
  },
  {
    command: "drift.viewSessionReport",
    label: "View Session Report",
    accent: "#86EFAC",
    icon: '<line x1="3" y1="14" x2="3" y2="8"/><line x1="8" y1="14" x2="8" y2="4"/><line x1="13" y1="14" x2="13" y2="10"/>',
  },
  {
    command: "drift.installClaudeHooks",
    label: "Configure Claude Hooks",
    accent: "#FDBA74",
    icon: '<path d="M5 3v3M11 3v3M3.5 6h9l-.6 5a2 2 0 0 1-2 1.8h-3.8a2 2 0 0 1-2-1.8l-.6-5Z"/><line x1="8" y1="12.8" x2="8" y2="15"/>',
  },
];

function nonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

export class DriftDashboardViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly extensionUri: vscode.Uri, private readonly statusSource: DriftSidebarProvider, private readonly deps: DriftDashboardDeps = defaultDashboardDeps) {
    this.statusSource.onDidChangeTreeData(() => this.pushState());
  }

  currentState(): DashboardState {
    const hooks = this.statusSource.getHooksStatus();
    return {
      runtime: this.statusSource.getStatus(),
      model: this.statusSource.getModelStatus(),
      hooks: hooks.status,
      hasWorkspaceFolder: hooks.hasWorkspaceFolder,
    };
  }

  private pushState(): void {
    void this.view?.webview.postMessage({ type: "state", state: this.currentState() });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: { type: string; command?: string }) => {
      if (message?.type === "ready") {
        this.pushState();
      } else if (message?.type === "runCommand" && typeof message.command === "string") {
        void this.deps.executeCommand(message.command);
      }
    });

    // Belt-and-suspenders: the webview's own "ready" message is the
    // reliable delivery path (a message posted here can race the webview's
    // script attaching its listener), but sending an initial snapshot too
    // costs nothing and covers a host that replays queued messages.
    this.pushState();
  }

  private renderHtml(webview: vscode.Webview): string {
    const csp = nonce();
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "drift-icon.png"));

    const actionsHtml = ACTIONS.map(
      (a) => `
        <button class="action" data-command="${a.command}">
          <svg class="action-icon" viewBox="0 0 16 16" fill="none" stroke="${a.accent}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${a.icon}</svg>
          <span>${a.label}</span>
        </button>`
    ).join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src 'unsafe-inline'; script-src 'nonce-${csp}';">
<title>Drift</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 0; margin: 0; }
  .header { display: flex; align-items: center; gap: 10px; padding: 16px 14px 12px 14px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); }
  .header img { width: 32px; height: 32px; border-radius: 8px; }
  .header h1 { font-size: 14px; margin: 0; }
  .header p { font-size: 11px; margin: 2px 0 0 0; opacity: 0.7; }
  .section { padding: 12px 14px; }
  .section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6; margin: 0 0 8px 0; }
  .pill { display: flex; align-items: center; gap: 8px; padding: 7px 10px; margin-bottom: 6px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2)); border-radius: 6px; font-size: 12px; background: var(--vscode-editorWidget-background, transparent); }
  .pill.clickable { cursor: pointer; }
  .pill.clickable:hover { background: var(--vscode-list-hoverBackground); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #888; }
  .pill .label { flex: 1; }
  .pill .value { opacity: 0.8; }
  .action { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; margin-bottom: 6px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 6px; background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font-size: 12px; cursor: pointer; text-align: left; }
  .action:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .action-icon { width: 16px; height: 16px; flex: none; }
</style>
</head>
<body>
  <div class="header">
    <img src="${logoUri}" alt="Drift" />
    <div>
      <h1>Drift</h1>
      <p>Local coding-agent monitor</p>
    </div>
  </div>

  <div class="section">
    <p class="section-title">Status</p>
    <div id="pill-runtime" class="pill">
      <span class="dot"></span>
      <span class="label">Runtime</span>
      <span class="value">Checking...</span>
    </div>
    <div id="pill-model" class="pill" data-command="drift.setupLocalModel">
      <span class="dot"></span>
      <span class="label">Local Model</span>
      <span class="value">Checking...</span>
    </div>
    <div id="pill-hooks" class="pill" data-command="drift.installClaudeHooks">
      <span class="dot"></span>
      <span class="label">Claude Hooks</span>
      <span class="value">Checking...</span>
    </div>
  </div>

  <div class="section">
    <p class="section-title">Actions</p>
    ${actionsHtml}
  </div>

  <script nonce="${csp}">
    const vscode = acquireVsCodeApi();

    function run(command) {
      vscode.postMessage({ type: "runCommand", command });
    }

    document.querySelectorAll(".action").forEach((el) => {
      el.addEventListener("click", () => run(el.getAttribute("data-command")));
    });

    function setPill(id, text, color, clickable) {
      const el = document.getElementById(id);
      el.querySelector(".dot").style.background = color;
      el.querySelector(".value").textContent = text;
      el.classList.toggle("clickable", clickable);
      el.onclick = clickable ? () => run(el.getAttribute("data-command")) : null;
    }

    function applyState(state) {
      setPill("pill-runtime", state.runtime === "online" ? "Online" : "Offline", state.runtime === "online" ? "#4ADE80" : "#F87171", false);

      if (state.model === "ready") setPill("pill-model", "Ready", "#4ADE80", false);
      else if (state.model === "not_ready") setPill("pill-model", "Not Installed", "#F87171", true);
      else setPill("pill-model", "Checking...", "#FBBF24", false);

      if (!state.hasWorkspaceFolder) setPill("pill-hooks", "Open a workspace folder", "#FBBF24", false);
      else if (state.hooks === "ready") setPill("pill-hooks", "Configured", "#4ADE80", false);
      else if (state.hooks === "not_ready") setPill("pill-hooks", "Not Configured", "#F87171", true);
      else setPill("pill-hooks", "Checking...", "#FBBF24", false);
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message && message.type === "state") applyState(message.state);
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
