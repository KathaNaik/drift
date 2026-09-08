import * as path from "path";
import * as vscode from "vscode";
import { DriftSidebarProvider } from "./driftSidebarProvider";
import { DriftFindingsProvider, SHOW_FINDING_STEPS_COMMAND, buildStepDetailText } from "./findingsViewProvider";
import { startRuntime, checkHealth, DriftRuntime } from "./runtime";
import { openStorage, DriftStorage, DriftSession } from "./storage";
import { installClaudeHooks } from "./hookInstaller";
import { exportSessionOnEnd } from "./sessionExportPipeline";
import { OtlpExportConfig } from "./otlpExporter";
import { normalizeRawEvent } from "./normalizedEvent";
import { buildTrajectory } from "./trajectory";
import { attributeUsageToTrajectory } from "./trajectoryUsageAttribution";
import { analyzeSession, SessionAnalysis, SessionAnalysisWindow } from "./sessionAnalysisPipeline";
import { LocalModelRuntime, createLocalModelRuntime } from "./localModelRuntime";

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
let findingsProvider: DriftFindingsProvider | undefined;
let storage: DriftStorage | undefined;
let extensionUri: vscode.Uri | undefined;

/** The packaged local model's fixed location relative to the extension itself -- see M9A/CLAUDE.md: semantic analysis only ever uses this local, gitignored asset, never a cloud LLM. */
function resolveModelPath(): string {
  return path.join(extensionUri!.fsPath, "models", "gemma-3-4b-it-IQ4_XS.gguf");
}

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

export interface AnalyzeSessionDeps {
  listSessions: (storage: DriftStorage) => DriftSession[];
  /** Resolved to the sessionId to analyze, or undefined if the user cancelled. */
  pickSessionId: (sessions: DriftSession[]) => Promise<string | undefined>;
  createRuntime: () => LocalModelRuntime;
}

const defaultAnalyzeSessionDeps: AnalyzeSessionDeps = {
  listSessions: (storage) => storage.listSessions(),
  pickSessionId: async (sessions) => {
    if (sessions.length === 1) return sessions[0].id;
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: s.id, description: new Date(s.createdAt).toLocaleString() })),
      { placeHolder: "Select a Claude Code session to analyze" }
    );
    return picked?.label;
  },
  createRuntime: () => createLocalModelRuntime({ modelPath: resolveModelPath(), timeoutMs: 60000 }),
};

/**
 * Runs one on-demand M10B session analysis and renders it in the Findings
 * view. Analysis only ever happens here, in direct response to this
 * command -- nothing in activate() or the runtime's hook handling ever
 * calls analyzeSession() itself, so Gemma is never invoked automatically
 * or in the background. The local model runtime this spawns is closed in
 * a `finally` block regardless of outcome, so no server process is left
 * running between analyses.
 */
export async function runAnalyzeSessionCommand(deps: AnalyzeSessionDeps = defaultAnalyzeSessionDeps): Promise<SessionAnalysis | undefined> {
  if (!storage) {
    vscode.window.showErrorMessage("Drift: storage is not open yet.");
    return undefined;
  }

  const sessions = deps.listSessions(storage);
  if (sessions.length === 0) {
    vscode.window.showInformationMessage("Drift: no Claude Code sessions have been recorded yet.");
    return undefined;
  }

  const sessionId = await deps.pickSessionId(sessions);
  if (!sessionId) return undefined;

  const sessionData = storage.getSession(sessionId);
  if (!sessionData) {
    vscode.window.showErrorMessage(`Drift: session ${sessionId} could not be loaded.`);
    return undefined;
  }

  const trajectory = buildTrajectory(sessionId, sessionData.events.map(normalizeRawEvent));
  const trajectoryUsage = attributeUsageToTrajectory(trajectory, storage);

  const modelRuntime = deps.createRuntime();
  let result: SessionAnalysis;
  try {
    result = await analyzeSession(trajectoryUsage, storage, modelRuntime);
  } finally {
    await modelRuntime.close();
  }

  findingsProvider?.setAnalysis(result);
  vscode.window.showInformationMessage(`Drift: analyzed session ${sessionId} — ${result.analyses.length} window(s) found.`);
  return result;
}

/**
 * Opens a compact, read-only, human-readable summary of the trajectory
 * steps a finding points at -- never a raw JSON dump, and never mutates
 * storage.
 */
export async function runShowFindingStepsCommand(sessionId: string, window: SessionAnalysisWindow): Promise<void> {
  if (!storage) return;
  const content = buildStepDetailText(sessionId, window, storage);
  const doc = await vscode.workspace.openTextDocument({ content, language: "plaintext" });
  await vscode.window.showTextDocument(doc, { preview: true });
}

export async function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  const provider = new DriftSidebarProvider();
  sidebarProvider = provider;
  const treeView = vscode.window.createTreeView("drift.sidebar", {
    treeDataProvider: provider,
  });
  context.subscriptions.push(treeView);

  const findingsViewProvider = new DriftFindingsProvider();
  findingsProvider = findingsViewProvider;
  const findingsTreeView = vscode.window.createTreeView("drift.findings", {
    treeDataProvider: findingsViewProvider,
  });
  context.subscriptions.push(findingsTreeView);

  const installHooksCommand = vscode.commands.registerCommand(
    "drift.installClaudeHooks",
    runInstallClaudeHooksCommand
  );
  context.subscriptions.push(installHooksCommand);

  const analyzeSessionCommand = vscode.commands.registerCommand("drift.analyzeSession", () => runAnalyzeSessionCommand());
  context.subscriptions.push(analyzeSessionCommand);

  const showFindingStepsCommand = vscode.commands.registerCommand(SHOW_FINDING_STEPS_COMMAND, runShowFindingStepsCommand);
  context.subscriptions.push(showFindingStepsCommand);

  const dbPath = path.join(context.globalStorageUri.fsPath, "drift.sqlite3");
  storage = openStorage(dbPath);

  runtime = await initializeRuntimeStatus(provider, storage);

  return {
    provider,
    treeView,
    findingsProvider: findingsViewProvider,
    findingsTreeView,
    getRuntime: () => runtime,
    getStorage: () => storage,
    getStoragePath: () => dbPath,
  };
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
