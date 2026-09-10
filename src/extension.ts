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
/** In-memory only, per M12B's own scope -- never persisted, and reset on every extension activation. */
const redirectLifecycle = new RedirectLifecycleManager();

/** The packaged local model's fixed location relative to the extension itself -- see M9A/CLAUDE.md: semantic analysis only ever uses this local, gitignored asset, never a cloud LLM. */
function resolveModelPath(): string {
  return path.join(extensionUri!.fsPath, "models", "gemma-3-4b-it-IQ4_XS.gguf");
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
}

const defaultAnalyzeSessionDeps: AnalyzeSessionDeps = {
  ...defaultSessionPickerDeps,
  createRuntime: () => createLocalModelRuntime({ modelPath: resolveModelPath(), timeoutMs: 60000 }),
};

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
