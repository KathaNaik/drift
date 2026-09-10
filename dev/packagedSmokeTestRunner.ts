/**
 * M15B.1: the actual assertions run inside a real VS Code extension host,
 * against Drift as installed from a packaged VSIX -- never against this
 * repository's own source. This file is copied (as its compiled .js) into
 * a throwaway, temporary "driver" extension by packagedSmokeTest.ts; it
 * contains no Drift implementation of its own, only verification.
 *
 * VS Code's own --extensionTestsPath contract expects this module to
 * export `run(): Promise<void>` -- resolving means every check passed,
 * rejecting (thrown Error) means at least one failed. The test host
 * process exits with a corresponding non-zero code on rejection, giving
 * packagedSmokeTest.ts an explicit, real PASS/FAIL signal with no manual
 * process-watching required.
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import * as vscode from "vscode";

interface CheckFailure {
  name: string;
  error: string;
}

export async function run(): Promise<void> {
  const expectedVersion = process.env.DRIFT_SMOKE_EXPECTED_VERSION;
  const cleanExtensionsDir = process.env.DRIFT_SMOKE_EXTENSIONS_DIR;
  const devCheckoutPath = process.env.DRIFT_SMOKE_DEV_CHECKOUT_PATH;

  const failures: CheckFailure[] = [];

  async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      console.log("SMOKE PASS:", name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name, error: message });
      console.log("SMOKE FAIL:", name, "--", message);
    }
  }

  const ext = vscode.extensions.getExtension("drift.drift");
  await check("Drift extension is discoverable from the installed VSIX", () => {
    assert.ok(ext, 'vscode.extensions.getExtension("drift.drift") returned undefined -- the VSIX was not installed into this extensions directory');
  });

  if (!ext) {
    throw new Error("cannot continue: drift.drift extension was not found at all");
  }

  await check("extensionPath resolves inside the clean, isolated extensions directory", () => {
    assert.ok(cleanExtensionsDir, "DRIFT_SMOKE_EXTENSIONS_DIR env var was not set by the driver");
    const real = fs.realpathSync(ext.extensionPath);
    const realClean = fs.realpathSync(cleanExtensionsDir!);
    assert.ok(real.startsWith(realClean), `extensionPath ${real} is not inside the isolated extensions directory ${realClean}`);
  });

  await check("extensionPath does NOT resolve to the development checkout", () => {
    assert.ok(devCheckoutPath, "DRIFT_SMOKE_DEV_CHECKOUT_PATH env var was not set by the driver");
    assert.ok(!ext.extensionPath.includes(devCheckoutPath!), `extensionPath unexpectedly points inside the dev checkout: ${ext.extensionPath}`);
  });

  await check("packageJSON version matches the packaged VSIX version", () => {
    assert.ok(expectedVersion, "DRIFT_SMOKE_EXPECTED_VERSION env var was not set by the driver");
    assert.strictEqual(ext.packageJSON.version, expectedVersion);
  });

  let exports: any;
  await check("packaged Drift activates successfully (no absolute dev-machine path caused activation to fail)", async () => {
    exports = await ext.activate();
    assert.ok(ext.isActive, "extension did not report isActive after activate() resolved");
  });

  await check("Drift contributes its Activity Bar container and views, per the packaged package.json", () => {
    const pkg = ext.packageJSON;
    assert.ok(pkg.contributes?.viewsContainers?.activitybar?.some((c: any) => c.id === "drift"), "missing activitybar container 'drift'");
    assert.ok(pkg.contributes?.views?.drift?.some((v: any) => v.id === "drift.findings"), "missing 'drift.findings' view");
  });

  await check("expected Drift commands are registered from the packaged extension", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const cmd of ["drift.installClaudeHooks", "drift.analyzeSession", "drift.setupLocalModel", "drift.inspectSession", "drift.viewSessionReport", "drift.prepareRedirect"]) {
      assert.ok(commands.includes(cmd), `missing registered command: ${cmd}`);
    }
  });

  let runtime: any;
  await check("the local runtime starts from packaged files", () => {
    assert.ok(exports, "no exports returned from activate()");
    runtime = exports.getRuntime();
    assert.ok(runtime && typeof runtime.port === "number" && runtime.port > 0, "getRuntime() did not return a running runtime with a real port");
  });

  await check("Drift: Configure Claude Code Hooks resolves the packaged hookBridge.js, never a dev-checkout src/ path", async () => {
    await vscode.commands.executeCommand("drift.installClaudeHooks");
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "no workspace folder open -- the driver must launch VS Code with a workspace argument");
    const settingsPath = path.join(workspaceFolder.uri.fsPath, ".claude", "settings.local.json");
    assert.ok(fs.existsSync(settingsPath), "settings.local.json was not written by drift.installClaudeHooks");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const command: string = settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? "";
    assert.ok(command.includes("hookBridge.js"), `expected the command hook to reference hookBridge.js, got: ${command}`);
    assert.ok(!command.includes(devCheckoutPath || "\0impossible"), `hook bridge command must not reference the dev checkout: ${command}`);
    const realExtensionPath = fs.realpathSync(ext.extensionPath);
    assert.ok(command.includes(realExtensionPath) || command.includes(ext.extensionPath), `hook bridge command must resolve inside the installed extension path, got: ${command}`);
  });

  await check("session capture works end-to-end against the packaged runtime", async () => {
    const sessionId = "smoke-" + Date.now();
    const statusCode = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: runtime.port, path: "/hooks/claude", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart" }));
    });
    assert.strictEqual(statusCode, 200);
    const storage = exports.getStorage();
    const stored = storage.getSession(sessionId);
    assert.ok(stored, "session was not found in packaged storage after posting a hook event");
    assert.strictEqual(stored.events.length, 1);
  });

  await check("model setup: a missing model is detected via packaged modelSetup.js, without hanging or downloading", async () => {
    const modelSetupPath = path.join(ext.extensionPath, "out", "src", "modelSetup.js");
    assert.ok(fs.existsSync(modelSetupPath), "packaged out/src/modelSetup.js not found inside the installed extension");
    delete require.cache[require.resolve(modelSetupPath)];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const modelSetup = require(modelSetupPath);
    const globalStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-smoke-globalstorage-"));
    const status = await modelSetup.checkModelStatus(globalStorageDir);
    assert.strictEqual(status.ready, false);
    assert.strictEqual(status.reason, "not_installed");

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("drift.setupLocalModel"), "the explicit setup command must be registered");
  });

  await check("llama runtime path resolves inside managed Drift storage, never Homebrew, and is honestly reported as not installed", () => {
    const modelSetupPath = path.join(ext.extensionPath, "out", "src", "modelSetup.js");
    delete require.cache[require.resolve(modelSetupPath)];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const modelSetup = require(modelSetupPath);
    const globalStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-smoke-globalstorage-"));
    const llamaPath: string = modelSetup.getManagedLlamaServerPath(globalStorageDir);
    assert.ok(llamaPath.startsWith(globalStorageDir), `llama-server path must live under managed storage, got: ${llamaPath}`);
    assert.ok(!llamaPath.includes("/opt/homebrew"), `llama-server path must never reference Homebrew, got: ${llamaPath}`);
    const llamaStatus = modelSetup.checkLlamaRuntimeStatus(globalStorageDir);
    assert.strictEqual(llamaStatus.ready, false);
    assert.strictEqual(llamaStatus.reason, "not_installed");
  });

  console.log(`\n=== SMOKE TEST SUMMARY: ${failures.length === 0 ? "ALL PASSED" : `${failures.length} FAILED`} ===`);
  if (failures.length > 0) {
    for (const f of failures) console.log(` - ${f.name}: ${f.error}`);
    throw new Error(`${failures.length} smoke check(s) failed: ${failures.map((f) => f.name).join("; ")}`);
  }
}
