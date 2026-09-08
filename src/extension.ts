import * as path from "path";
import * as vscode from "vscode";
import { DriftSidebarProvider } from "./driftSidebarProvider";
import { startRuntime, checkHealth, DriftRuntime } from "./runtime";
import { openStorage, DriftStorage } from "./storage";
import { installClaudeHooks } from "./hookInstaller";
import { exportSessionOnEnd } from "./sessionExportPipeline";
import { OtlpExportConfig } from "./otlpExporter";

export interface RuntimeStartDeps {
  startRuntime: (storage: DriftStorage) => Promise<DriftRuntime>;
  checkHealth: (port: number) => Promise<boolean>;
}

/** Reads the current drift.otlp.* settings fresh each time — a config change takes effect on the next SessionEnd, without needing to reload the extension. */
function currentOtlpConfig(): OtlpExportConfig {
  const config = vscode.workspace.getConfiguration("drift");
  const endpoint = config.get<string>("otlp.endpoint", "");
  return {
    enabled: config.get<boolean>("otlp.enabled", false),
    endpoint: endpoint.length > 0 ? endpoint : undefined,
  };
}

const defaultRuntimeStartDeps: RuntimeStartDeps = {
  startRuntime: (storage) =>
    startRuntime(storage, async (sessionId) => {
      await exportSessionOnEnd(sessionId, storage, currentOtlpConfig());
    }),
  checkHealth,
};

let runtime: DriftRuntime | undefined;
let sidebarProvider: DriftSidebarProvider | undefined;
let storage: DriftStorage | undefined;
let extensionUri: vscode.Uri | undefined;

/**
 * Starts the runtime and sets the sidebar's online/offline status from the
 * outcome. `deps` is injectable so a startup or health-check failure can be
 * exercised by a test without reaching into the provider directly.
 */
export async function initializeRuntimeStatus(
  provider: DriftSidebarProvider,
  storage: DriftStorage,
  deps: RuntimeStartDeps = defaultRuntimeStartDeps
): Promise<DriftRuntime | undefined> {
  let started: DriftRuntime | undefined;
  try {
    started = await deps.startRuntime(storage);
    const healthy = await deps.checkHealth(started.port);
    provider.setStatus(healthy ? "online" : "offline");
  } catch {
    provider.setStatus("offline");
  }
  return started;
}

/**
 * Configures Claude Code hooks for the first workspace folder, pointing them
 * at the currently running Drift runtime's port.
 */
export async function runInstallClaudeHooksCommand(): Promise<void> {
  if (!runtime) {
    vscode.window.showErrorMessage("Drift: the local runtime is not running, so hooks cannot be configured.");
    return;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("Drift: open a workspace folder before configuring Claude Code hooks.");
    return;
  }

  const settingsPath = path.join(workspaceFolder.uri.fsPath, ".claude", "settings.local.json");
  const bridgeScriptPath = path.join(extensionUri!.fsPath, "out", "src", "hookBridge.js");
  installClaudeHooks(settingsPath, runtime.port, bridgeScriptPath);
  vscode.window.showInformationMessage("Drift: Claude Code hooks configured for this workspace.");
}

export async function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  const provider = new DriftSidebarProvider();
  sidebarProvider = provider;
  const treeView = vscode.window.createTreeView("drift.sidebar", {
    treeDataProvider: provider,
  });
  context.subscriptions.push(treeView);

  const installHooksCommand = vscode.commands.registerCommand(
    "drift.installClaudeHooks",
    runInstallClaudeHooksCommand
  );
  context.subscriptions.push(installHooksCommand);

  const dbPath = path.join(context.globalStorageUri.fsPath, "drift.sqlite3");
  storage = openStorage(dbPath);

  runtime = await initializeRuntimeStatus(provider, storage);

  return { provider, treeView, getRuntime: () => runtime, getStorage: () => storage, getStoragePath: () => dbPath };
}

export async function deactivate(): Promise<void> {
  if (runtime) {
    await runtime.stop();
    runtime = undefined;
  }
  sidebarProvider?.setStatus("offline");

  if (storage) {
    storage.close();
    storage = undefined;
  }
}
