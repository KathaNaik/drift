import * as assert from "assert";
import * as vscode from "vscode";
import { DriftDashboardViewProvider } from "../../src/driftDashboardViewProvider";
import { DriftSidebarProvider } from "../../src/driftSidebarProvider";

/**
 * A minimal test double for vscode.WebviewView -- enough surface for
 * DriftDashboardViewProvider to resolve against, with hooks to inspect
 * what the provider posts and to drive the same onDidReceiveMessage path
 * the real webview would use. This mirrors how DriftSidebarProvider itself
 * is tested directly (constructed and exercised without a real rendered
 * TreeView), rather than trying to reach into a real webview's iframe.
 */
function createFakeWebviewView() {
  let messageHandler: ((message: { type: string; command?: string }) => void) | undefined;
  const posted: unknown[] = [];

  const webview = {
    options: {} as vscode.WebviewOptions,
    html: "",
    cspSource: "vscode-webview://test",
    asWebviewUri: (uri: vscode.Uri) => uri,
    onDidReceiveMessage: (callback: (message: { type: string; command?: string }) => void) => {
      messageHandler = callback;
      return { dispose() {} };
    },
    postMessage: (message: unknown) => {
      posted.push(message);
      return Promise.resolve(true);
    },
  } as unknown as vscode.Webview;

  const view = { webview } as unknown as vscode.WebviewView;

  return {
    view,
    posted,
    send: (message: { type: string; command?: string }) => messageHandler?.(message),
  };
}

function extensionUri(): vscode.Uri {
  const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
  return ext.extensionUri;
}

suite("DriftDashboardViewProvider (M17)", () => {
  test("resolveWebviewView enables scripts and renders the header logo, all three status pills, and all four action buttons", () => {
    const statusSource = new DriftSidebarProvider();
    const provider = new DriftDashboardViewProvider(extensionUri(), statusSource);
    const fake = createFakeWebviewView();

    provider.resolveWebviewView(fake.view);

    assert.strictEqual(fake.view.webview.options.enableScripts, true);
    const html = fake.view.webview.html;
    assert.ok(html.includes("drift-icon.png"), "header logo should reference the existing Drift icon asset");
    assert.ok(html.includes('id="pill-runtime"'), "missing runtime status pill");
    assert.ok(html.includes('id="pill-model"'), "missing local model status pill");
    assert.ok(html.includes('id="pill-hooks"'), "missing Claude hooks status pill");
    for (const command of ["drift.analyzeSession", "drift.inspectSession", "drift.viewSessionReport", "drift.installClaudeHooks"]) {
      assert.ok(html.includes(`data-command="${command}"`), `missing action button wired to ${command}`);
    }
  });

  test("a runCommand message from the webview executes the exact same command, never a duplicated implementation", async () => {
    const statusSource = new DriftSidebarProvider();
    const executed: string[] = [];
    const provider = new DriftDashboardViewProvider(extensionUri(), statusSource, {
      executeCommand: async (command) => {
        executed.push(command);
      },
    });
    const fake = createFakeWebviewView();
    provider.resolveWebviewView(fake.view);

    fake.send({ type: "runCommand", command: "drift.analyzeSession" });
    fake.send({ type: "runCommand", command: "drift.viewSessionReport" });

    assert.deepStrictEqual(executed, ["drift.analyzeSession", "drift.viewSessionReport"]);
  });

  test("a ready message from the webview receives the real current status, not a placeholder", () => {
    const statusSource = new DriftSidebarProvider();
    statusSource.setStatus("online");
    statusSource.setModelStatus("ready");
    statusSource.setHooksStatus("not_ready", true);

    const provider = new DriftDashboardViewProvider(extensionUri(), statusSource);
    const fake = createFakeWebviewView();
    provider.resolveWebviewView(fake.view);
    fake.posted.length = 0; // clear the initial resolve-time push; isolate the "ready" response

    fake.send({ type: "ready" });

    assert.strictEqual(fake.posted.length, 1);
    assert.deepStrictEqual(fake.posted[0], {
      type: "state",
      state: { runtime: "online", model: "ready", hooks: "not_ready", hasWorkspaceFolder: true },
    });
  });

  test("resolving immediately pushes the current state, before any message is received", () => {
    const statusSource = new DriftSidebarProvider();
    statusSource.setStatus("offline");
    statusSource.setModelStatus("not_ready");
    statusSource.setHooksStatus("unknown", false);

    const provider = new DriftDashboardViewProvider(extensionUri(), statusSource);
    const fake = createFakeWebviewView();
    provider.resolveWebviewView(fake.view);

    assert.strictEqual(fake.posted.length, 1);
    assert.deepStrictEqual(fake.posted[0], {
      type: "state",
      state: { runtime: "offline", model: "not_ready", hooks: "unknown", hasWorkspaceFolder: false },
    });
  });

  test("a later status change is pushed to an already-resolved webview automatically", () => {
    const statusSource = new DriftSidebarProvider();
    const provider = new DriftDashboardViewProvider(extensionUri(), statusSource);
    const fake = createFakeWebviewView();
    provider.resolveWebviewView(fake.view);
    fake.posted.length = 0;

    statusSource.setStatus("online");

    assert.strictEqual(fake.posted.length, 1);
    assert.strictEqual((fake.posted[0] as { state: { runtime: string } }).state.runtime, "online");
  });

  test("currentState() reflects DriftSidebarProvider's real, live fields -- never a fabricated value", () => {
    const statusSource = new DriftSidebarProvider();
    statusSource.setStatus("online");
    statusSource.setModelStatus("ready");
    statusSource.setHooksStatus("ready", true);
    const provider = new DriftDashboardViewProvider(extensionUri(), statusSource);

    assert.deepStrictEqual(provider.currentState(), { runtime: "online", model: "ready", hooks: "ready", hasWorkspaceFolder: true });
  });

  test("package.json contributes drift.sidebar as a webview view, not a tree", () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const views: { id: string; type?: string }[] = ext.packageJSON.contributes.views.drift;
    const sidebarView = views.find((v) => v.id === "drift.sidebar");
    assert.ok(sidebarView, "drift.sidebar view not contributed");
    assert.strictEqual(sidebarView!.type, "webview");
  });

  test("the real running extension registers the dashboard against drift.sidebar without error, and exposes it from activate()", async () => {
    const ext = vscode.extensions.getExtension("kathanaik.drift-agent-monitor")!;
    const exports = await ext.activate();
    assert.ok(exports.dashboardProvider instanceof DriftDashboardViewProvider, "activate() should expose the real dashboard provider");
  });
});
