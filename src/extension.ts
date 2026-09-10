import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DriftSidebarProvider } from "./driftSidebarProvider";
import { DriftFindingsProvider, SHOW_FINDING_STEPS_COMMAND, buildStepDetailText } from "./findingsViewProvider";
import { DriftTrajectoryInspectorProvider, InspectorNode, OPEN_INSPECTOR_AT_STEP_COMMAND } from "./trajectoryInspectorProvider";
import { DriftSessionReportProvider } from "./sessionReportProvider";
import { buildSessionReport } from "./sessionReport";
import { generateRedirectPacket, formatRedirectPacketText, formatInjectedRedirectContext, RedirectPacket } from "./redirectPacket";
import { RedirectLifecycleManager } from "./redirectLifecycle";
import { startRuntime, checkHealth, DriftRuntime, RedirectInjectionHook } from "./runtime";
import { openStorage, DriftStorage, DriftSession, DriftRawEvent, DriftSessionWithEvents } from "./storage";
import { installClaudeHooks } from "./hookInstaller";
import { exportSessionOnEnd } from "./sessionExportPipeline";
import { OtlpExportConfig } from "./otlpExporter";
import { normalizeRawEvent } from "./normalizedEvent";
import { buildTrajectory } from "./trajectory";
import { attributeUsageToTrajectory, TrajectoryUsage } from "./trajectoryUsageAttribution";
import { analyzeSession, SessionAnalysis, SessionAnalysisWindow } from "./sessionAnalysisPipeline";
import { LocalModelRuntime, createLocalModelRuntime } from "./localModelRuntime";
import { checkModelStatus, checkLlamaRuntimeStatus, downloadModel, installLlamaRuntime, getManagedModelPath, getManagedLlamaServerPath } from "./modelSetup";

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

/**
 * The M12B injection boundary wired into the running runtime: on every
 * UserPromptSubmit hook, the runtime asks whether Drift has an approved,
 * still-current redirect for that exact session (see
 * RedirectLifecycleManager.getInjectablePacket) and, if so, formats it into
 * the restricted context-only block (formatInjectedRedirectContext -- never
 * reasonCodes, usage, or raw evidence). Marking it consumed only happens
 * after runtime.ts confirms the response was actually sent.
 */
const redirectInjectionHook: RedirectInjectionHook = {
  getInjectableContext: (sessionId) => {
    const packet = redirectLifecycle.getInjectablePacket(sessionId, findingsProvider?.getCurrentAnalysis());
    return packet ? formatInjectedRedirectContext(packet) : undefined;
  },
  markConsumed: (sessionId) => redirectLifecycle.markConsumed(sessionId),
};

const defaultRuntimeStartDeps: RuntimeStartDeps = {
  startRuntime: (storage) =>
    startRuntime(
      storage,
      async (sessionId) => {
        await exportSessionOnEnd(sessionId, storage, currentOtlpConfig());
      },
      redirectInjectionHook
    ),
  checkHealth,
};

let runtime: DriftRuntime | undefined;
let sidebarProvider: DriftSidebarProvider | undefined;
let findingsProvider: DriftFindingsProvider | undefined;
let inspectorProvider: DriftTrajectoryInspectorProvider | undefined;
let inspectorTreeView: vscode.TreeView<InspectorNode> | undefined;
let reportProvider: DriftSessionReportProvider | undefined;
let storage: DriftStorage | undefined;
let extensionUri: vscode.Uri | undefined;
/** Drift's own per-extension global storage directory (survives updates/reinstalls, never wiped when the extension package itself is replaced) -- see M15B: neither the model nor the local-inference runtime ships inside the VSIX, so both are managed here instead of relative to the (read-only, post-install) extension install directory. */
let globalStorageDir: string | undefined;
/** In-memory only, per M12B's own scope -- never persisted, and reset on every extension activation. */
const redirectLifecycle = new RedirectLifecycleManager();

/** M15B: the managed model lives in Drift's own global storage, downloaded on explicit user request via "Drift: Setup Local Model" -- never bundled inside the VSIX and never relative to the extension's own (read-only after packaging) install directory. See M9A/CLAUDE.md: semantic analysis only ever uses this local asset, never a cloud LLM. */
function resolveModelPath(): string {
  return getManagedModelPath(globalStorageDir!);
}

/** M15B: the managed llama.cpp runtime, downloaded alongside the model -- never assumes a Homebrew (or any other) system install of llama-server. */
function resolveLlamaServerPath(): string {
  return getManagedLlamaServerPath(globalStorageDir!);
}

/** The same "normalize -> buildTrajectory -> attributeUsageToTrajectory" pipeline used everywhere else in this codebase, factored here since both Analyze Session and Inspect Session need a fresh, exact-order trajectory for a session. Pure -- reads storage, never writes it. */
function buildTrajectoryUsageFor(sessionId: string, sessionData: DriftSessionWithEvents): TrajectoryUsage {
  const trajectory = buildTrajectory(sessionId, sessionData.events.map(normalizeRawEvent));
  return attributeUsageToTrajectory(trajectory, storage!);
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

/** True when this workspace folder's own .claude/settings.local.json already has a Drift command hook installed -- read-only, matching hookInstaller.ts's own command-shape convention (a SessionStart hook whose command references hookBridge.js). */
function isHooksConfigured(workspaceFolder: vscode.WorkspaceFolder): boolean {
  const settingsPath = path.join(workspaceFolder.uri.fsPath, ".claude", "settings.local.json");
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const sessionStartGroups = settings?.hooks?.SessionStart;
    if (!Array.isArray(sessionStartGroups)) return false;
    return sessionStartGroups.some(
      (group: { hooks?: unknown }) => Array.isArray(group?.hooks) && (group.hooks as { command?: unknown }[]).some((h) => typeof h?.command === "string" && h.command.includes("hookBridge.js"))
    );
  } catch {
    return false;
  }
}

/** M16: refreshes the sidebar's two setup-status rows -- called once after activation and again after either setup command runs, so the sidebar always reflects real, current state rather than a stale first read. */
async function refreshSetupStatus(): Promise<void> {
  if (!sidebarProvider) return;

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  sidebarProvider.setHooksStatus(workspaceFolder ? (isHooksConfigured(workspaceFolder) ? "ready" : "not_ready") : "unknown", workspaceFolder !== undefined);

  if (globalStorageDir) {
    const [modelStatus, runtimeStatus] = await Promise.all([checkModelStatus(globalStorageDir), Promise.resolve(checkLlamaRuntimeStatus(globalStorageDir))]);
    sidebarProvider.setModelStatus(modelStatus.ready && runtimeStatus.ready ? "ready" : "not_ready");
  }
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
  await refreshSetupStatus();
}

/** Shared by both Analyze Session and Inspect Session -- both start from "which stored Claude Code session?" and nothing else. */
export interface SessionPickerDeps {
  listSessions: (storage: DriftStorage) => DriftSession[];
  /** Resolved to the sessionId to use, or undefined if the user cancelled. */
  pickSessionId: (sessions: DriftSession[]) => Promise<string | undefined>;
}

const defaultSessionPickerDeps: SessionPickerDeps = {
  listSessions: (storage) => storage.listSessions(),
  pickSessionId: async (sessions) => {
    if (sessions.length === 1) return sessions[0].id;
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: s.id, description: new Date(s.createdAt).toLocaleString() })),
      { placeHolder: "Select a Claude Code session" }
    );
    return picked?.label;
  },
};

export interface AnalyzeSessionDeps extends SessionPickerDeps {
  createRuntime: () => LocalModelRuntime;
  /**
   * M15B: verifies the managed model/runtime are actually installed before
   * createRuntime() is ever called. Optional -- a caller supplying its own
   * stub createRuntime() (as the existing test suite does throughout, to
   * exercise analysis without needing the real multi-gigabyte model) has
   * nothing real to check and simply omits this, so the real installation
   * gate only ever applies to the genuine, production runtime path below.
   */
  checkModelReady?: () => Promise<{ ready: boolean; message: string }>;
}

const defaultAnalyzeSessionDeps: AnalyzeSessionDeps = {
  ...defaultSessionPickerDeps,
  createRuntime: () => createLocalModelRuntime({ modelPath: resolveModelPath(), llamaServerPath: resolveLlamaServerPath(), timeoutMs: 60000 }),
  checkModelReady: async () => {
    const [modelStatus, runtimeStatus] = await Promise.all([checkModelStatus(globalStorageDir!), Promise.resolve(checkLlamaRuntimeStatus(globalStorageDir!))]);
    return {
      ready: modelStatus.ready && runtimeStatus.ready,
      message: 'Drift: the local model/runtime are not installed yet. Run "Drift: Setup Local Model" first.',
    };
  },
};

/**
 * M15B: the explicit, user-triggered download action for Drift's two
 * managed local-inference assets (Gemma GGUF model, llama.cpp runtime).
 * Never invoked automatically -- not on activation, not from
 * runAnalyzeSessionCommand's own pre-check, which only ever tells the user
 * to run this command rather than triggering a download itself. Already-
 * installed, checksum-valid assets are detected and skipped, never
 * redownloaded.
 */
export interface SetupLocalModelDeps {
  globalStorageDir: string;
  withProgress: (title: string, task: (report: (message: string) => void) => Promise<void>) => Promise<void>;
  showInfo: (message: string) => void;
  showError: (message: string) => void;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "?";
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

export async function runSetupLocalModelCommand(deps: SetupLocalModelDeps): Promise<void> {
  const [modelStatus, runtimeStatus] = await Promise.all([checkModelStatus(deps.globalStorageDir), Promise.resolve(checkLlamaRuntimeStatus(deps.globalStorageDir))]);

  if (modelStatus.ready && runtimeStatus.ready) {
    deps.showInfo("Drift: local model and runtime are already installed.");
    return;
  }

  try {
    await deps.withProgress("Drift: setting up local model", async (report) => {
      if (!runtimeStatus.ready) {
        report("Downloading local inference runtime...");
        const result = await installLlamaRuntime(deps.globalStorageDir, (p) => report(`Downloading runtime... ${formatBytes(p.receivedBytes)} / ${formatBytes(p.totalBytes)}`));
        if (!result.success) throw new Error(`runtime setup failed: ${result.error}`);
      }
      if (!modelStatus.ready) {
        report("Downloading local model (this is a large file, please be patient)...");
        const result = await downloadModel(deps.globalStorageDir, (p) => report(`Downloading model... ${formatBytes(p.receivedBytes)} / ${formatBytes(p.totalBytes)}`));
        if (!result.success) throw new Error(`model setup failed: ${result.error}`);
      }
    });
  } catch (error) {
    deps.showError(`Drift: local model setup failed -- ${error instanceof Error ? error.message : String(error)}`);
    await refreshSetupStatus();
    return;
  }

  deps.showInfo("Drift: local model setup complete.");
  await refreshSetupStatus();
}

const defaultSetupLocalModelDeps: () => SetupLocalModelDeps = () => ({
  globalStorageDir: globalStorageDir!,
  withProgress: async (title, task) => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, async (progress) => {
      await task((message) => progress.report({ message }));
    });
  },
  showInfo: (message) => {
    vscode.window.showInformationMessage(message);
  },
  showError: (message) => {
    vscode.window.showErrorMessage(message);
  },
});

export type InspectSessionDeps = SessionPickerDeps;
const defaultInspectSessionDeps: InspectSessionDeps = defaultSessionPickerDeps;

export type ViewSessionReportDeps = SessionPickerDeps;
const defaultViewSessionReportDeps: ViewSessionReportDeps = defaultSessionPickerDeps;

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

  const trajectoryUsage = buildTrajectoryUsageFor(sessionId, sessionData);

  // M15B: the model/runtime are managed, downloaded assets, never bundled
  // and never auto-downloaded -- give a clear, actionable message instead
  // of letting analysis fail with a raw "no such file" from a missing
  // model or a spawn failure from a missing llama-server binary. Only the
  // real production deps provide this check (see AnalyzeSessionDeps).
  if (deps.checkModelReady) {
    const status = await deps.checkModelReady();
    if (!status.ready) {
      vscode.window.showErrorMessage(status.message);
      return undefined;
    }
  }

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

/**
 * Loads one session's trajectory (fresh, exact-order, never cached) into
 * the Trajectory Inspector, overlaying the most recently manually-triggered
 * analysis ONLY when it belongs to this exact session -- a leftover
 * analysis for a different session is never misapplied. Never touches the
 * local model: this is a pure storage-read + presentation step, so opening
 * or reopening the inspector causes zero additional Gemma calls. Returns
 * false (with an error message shown) when the session can no longer be
 * loaded.
 */
async function openInspectorForSession(sessionId: string): Promise<boolean> {
  if (!storage || !inspectorProvider) return false;

  const sessionData = storage.getSession(sessionId);
  if (!sessionData) {
    vscode.window.showErrorMessage(`Drift: session ${sessionId} could not be loaded.`);
    return false;
  }

  const rawEventsById = new Map<number, DriftRawEvent>();
  for (const rawEvent of sessionData.events) rawEventsById.set(rawEvent.id, rawEvent);

  const trajectoryUsage = buildTrajectoryUsageFor(sessionId, sessionData);
  const currentAnalysis = findingsProvider?.getCurrentAnalysis();
  const overlay = currentAnalysis && currentAnalysis.sessionId === sessionId ? currentAnalysis : undefined;

  inspectorProvider.setData(sessionId, trajectoryUsage, rawEventsById, overlay);
  return true;
}

/**
 * Opens the Trajectory Inspector for a user-picked stored session. Renders
 * the raw trajectory even when no analysis has ever been run for it (per
 * M11B: "If no analysis exists yet, show the raw trajectory without
 * findings") -- an overlay is applied opportunistically, never required.
 */
export async function runInspectSessionCommand(deps: InspectSessionDeps = defaultInspectSessionDeps): Promise<void> {
  if (!storage) {
    vscode.window.showErrorMessage("Drift: storage is not open yet.");
    return;
  }

  const sessions = deps.listSessions(storage);
  if (sessions.length === 0) {
    vscode.window.showInformationMessage("Drift: no Claude Code sessions have been recorded yet.");
    return;
  }

  const sessionId = await deps.pickSessionId(sessions);
  if (!sessionId) return;

  const opened = await openInspectorForSession(sessionId);
  if (opened) {
    await vscode.commands.executeCommand("drift.inspector.focus");
  }
}

/**
 * Selecting a finding in the Findings view opens/focuses the Trajectory
 * Inspector at that finding's first involved trajectory step (M11B).
 */
export async function runOpenInspectorAtStepCommand(sessionId: string, stepIndex: number): Promise<void> {
  const opened = await openInspectorForSession(sessionId);
  if (!opened || !inspectorProvider) return;

  const rootNodes = inspectorProvider.getChildren();
  const target = rootNodes.find((n): n is Extract<InspectorNode, { kind: "step" }> => n.kind === "step" && n.step.index === stepIndex);

  if (target && inspectorTreeView) {
    await inspectorTreeView.reveal(target, { select: true, focus: true });
  } else {
    await vscode.commands.executeCommand("drift.inspector.focus");
  }
}

/**
 * Builds and shows the M11C end-of-session report for a user-picked stored
 * session. Purely reads storage and whatever analysis the Findings view most
 * recently produced for this exact session (never a mismatched leftover) --
 * it never touches the local model, so viewing a report causes zero
 * additional Gemma calls, and it never writes anything back to storage.
 * Renders a full session/usage/outcome report even when no M10B analysis
 * has ever been run for this session, per M11C's own requirement.
 */
export async function runViewSessionReportCommand(deps: ViewSessionReportDeps = defaultViewSessionReportDeps): Promise<void> {
  if (!storage || !reportProvider) {
    vscode.window.showErrorMessage("Drift: storage is not open yet.");
    return;
  }

  const sessions = deps.listSessions(storage);
  if (sessions.length === 0) {
    vscode.window.showInformationMessage("Drift: no Claude Code sessions have been recorded yet.");
    return;
  }

  const sessionId = await deps.pickSessionId(sessions);
  if (!sessionId) return;

  const sessionData = storage.getSession(sessionId);
  if (!sessionData) {
    vscode.window.showErrorMessage(`Drift: session ${sessionId} could not be loaded.`);
    return;
  }

  const rawEventsById = new Map<number, DriftRawEvent>();
  for (const rawEvent of sessionData.events) rawEventsById.set(rawEvent.id, rawEvent);

  const trajectoryUsage = buildTrajectoryUsageFor(sessionId, sessionData);
  const currentAnalysis = findingsProvider?.getCurrentAnalysis();

  const report = buildSessionReport(trajectoryUsage, rawEventsById, currentAnalysis);
  reportProvider.setReport(report);
  await vscode.commands.executeCommand("drift.report.focus");
}

export interface RedirectApprovalDeps {
  /** Shows the packet for review and returns the developer's explicit choice. Never called for anything but a successfully generated packet. */
  showPacketAndConfirm: (packetText: string) => Promise<"approved" | "cancelled">;
}

const defaultRedirectApprovalDeps: RedirectApprovalDeps = {
  showPacketAndConfirm: async (packetText) => {
    const doc = await vscode.workspace.openTextDocument({ content: packetText, language: "plaintext" });
    await vscode.window.showTextDocument(doc, { preview: true });
    const choice = await vscode.window.showInformationMessage(
      "Drift: review the redirect packet, then Approve or Cancel. Nothing is sent to Claude yet either way.",
      "Approve",
      "Cancel"
    );
    return choice === "Approve" ? "approved" : "cancelled";
  },
};

export interface RedirectPreparationResult {
  packet: RedirectPacket | undefined;
  /** "rejected" means generateRedirectPacket itself refused (wrong state, or a stale/mismatched session) -- the developer was never shown a packet to decide on. */
  decision: "approved" | "cancelled" | "rejected";
  error: string | undefined;
}

/**
 * "Prepare Redirect" (M12A): generates a redirect packet for one
 * redirect_candidate analysis window and shows it for explicit Approve/
 * Cancel review. This never touches the local model (packet generation is
 * pure and read-only) and, whichever way the developer decides, nothing is
 * sent to Claude, no hook is called, and no configuration is changed --
 * Cancel and Approve are both no-ops beyond the informational message shown
 * afterward. Rejects outright (never fabricates a packet) for any window
 * that is not redirect_candidate, or whose session doesn't match `sessionId`.
 */
export async function runPrepareRedirectCommand(
  sessionId: string,
  window: SessionAnalysisWindow,
  deps: RedirectApprovalDeps = defaultRedirectApprovalDeps
): Promise<RedirectPreparationResult> {
  if (!storage) {
    vscode.window.showErrorMessage("Drift: storage is not open yet.");
    return { packet: undefined, decision: "rejected", error: "storage is not open yet" };
  }

  const sessionData = storage.getSession(sessionId);
  if (!sessionData) {
    vscode.window.showErrorMessage(`Drift: session ${sessionId} could not be loaded.`);
    return { packet: undefined, decision: "rejected", error: `session ${sessionId} could not be loaded` };
  }

  const trajectoryUsage = buildTrajectoryUsageFor(sessionId, sessionData);
  const result = generateRedirectPacket(sessionId, window, trajectoryUsage);
  if (!result.success || !result.packet) {
    vscode.window.showErrorMessage(`Drift: cannot prepare a redirect for this analysis (${result.error}).`);
    return { packet: undefined, decision: "rejected", error: result.error };
  }

  // Bind the packet to the exact analysis it came from (M12B session
  // binding) -- if the Findings view's current analysis doesn't match this
  // session, there's nothing valid to bind to, so refuse before ever
  // showing the developer anything to approve.
  const currentAnalysis = findingsProvider?.getCurrentAnalysis();
  if (!currentAnalysis || currentAnalysis.sessionId !== sessionId) {
    vscode.window.showErrorMessage("Drift: cannot prepare a redirect -- no current analysis is bound to this session.");
    return { packet: undefined, decision: "rejected", error: "no current analysis bound to this session" };
  }
  redirectLifecycle.prepare(result.packet, currentAnalysis);

  const decision = await deps.showPacketAndConfirm(formatRedirectPacketText(result.packet));
  if (decision === "approved") {
    redirectLifecycle.approve(sessionId);
    vscode.window.showInformationMessage("Drift: redirect packet approved. It will be delivered as guidance on this session's next prompt -- nothing has been sent to Claude yet.");
  } else {
    redirectLifecycle.cancel(sessionId);
    vscode.window.showInformationMessage("Drift: redirect preparation cancelled. Nothing changed.");
  }
  return { packet: result.packet, decision, error: undefined };
}

export async function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;
  globalStorageDir = context.globalStorageUri.fsPath;
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

  const trajectoryInspectorProvider = new DriftTrajectoryInspectorProvider();
  inspectorProvider = trajectoryInspectorProvider;
  const inspectorView = vscode.window.createTreeView("drift.inspector", {
    treeDataProvider: trajectoryInspectorProvider,
  });
  inspectorTreeView = inspectorView;
  context.subscriptions.push(inspectorView);

  const sessionReportProvider = new DriftSessionReportProvider();
  reportProvider = sessionReportProvider;
  const reportView = vscode.window.createTreeView("drift.report", {
    treeDataProvider: sessionReportProvider,
  });
  context.subscriptions.push(reportView);

  const installHooksCommand = vscode.commands.registerCommand(
    "drift.installClaudeHooks",
    runInstallClaudeHooksCommand
  );
  context.subscriptions.push(installHooksCommand);

  const analyzeSessionCommand = vscode.commands.registerCommand("drift.analyzeSession", () => runAnalyzeSessionCommand());
  context.subscriptions.push(analyzeSessionCommand);

  const setupLocalModelCommand = vscode.commands.registerCommand("drift.setupLocalModel", () => runSetupLocalModelCommand(defaultSetupLocalModelDeps()));
  context.subscriptions.push(setupLocalModelCommand);

  const showFindingStepsCommand = vscode.commands.registerCommand(SHOW_FINDING_STEPS_COMMAND, runShowFindingStepsCommand);
  context.subscriptions.push(showFindingStepsCommand);

  const inspectSessionCommand = vscode.commands.registerCommand("drift.inspectSession", () => runInspectSessionCommand());
  context.subscriptions.push(inspectSessionCommand);

  const openInspectorAtStepCommand = vscode.commands.registerCommand(OPEN_INSPECTOR_AT_STEP_COMMAND, runOpenInspectorAtStepCommand);
  context.subscriptions.push(openInspectorAtStepCommand);

  const viewSessionReportCommand = vscode.commands.registerCommand("drift.viewSessionReport", () => runViewSessionReportCommand());
  context.subscriptions.push(viewSessionReportCommand);

  // Invoked from the Findings view's context menu (see package.json's
  // view/item/context contribution, scoped to redirect_candidate rows only)
  // -- VS Code passes the exact tree node DriftFindingsProvider returned,
  // which structurally carries {sessionId, window}.
  const prepareRedirectCommand = vscode.commands.registerCommand("drift.prepareRedirect", (node: { sessionId: string; window: SessionAnalysisWindow }) =>
    runPrepareRedirectCommand(node.sessionId, node.window)
  );
  context.subscriptions.push(prepareRedirectCommand);

  const dbPath = path.join(context.globalStorageUri.fsPath, "drift.sqlite3");
  storage = openStorage(dbPath);

  runtime = await initializeRuntimeStatus(provider, storage);

  // Fire-and-forget: the model/runtime checks below hash a multi-gigabyte
  // file and stat a binary, so activation must not block on them -- the
  // sidebar starts at "Checking..." and updates in place once this resolves.
  void refreshSetupStatus();

  return {
    provider,
    treeView,
    findingsProvider: findingsViewProvider,
    findingsTreeView,
    inspectorProvider: trajectoryInspectorProvider,
    inspectorTreeView: inspectorView,
    reportProvider: sessionReportProvider,
    reportTreeView: reportView,
    redirectLifecycle,
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
