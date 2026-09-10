/**
 * M15B.1: verifies the actual packaged Drift VSIX -- not this repository's
 * own source -- by installing it into a fresh, isolated extensions
 * directory and running a throwaway "driver" extension
 * (packagedSmokeTestRunner.ts) against it inside a real, isolated VS Code
 * extension host (downloaded/cached by @vscode/test-electron, never the
 * user's own installed VS Code).
 *
 * Usage: node ./out/dev/packagedSmokeTest.js [path-to-vsix]
 * If no path is given, the newest drift-darwin-arm64-*.vsix in the repo
 * root is used.
 *
 * Not part of the shipped extension -- see .vscodeignore's dev/**
 * exclusion, same as harness.ts/inspect-session.ts.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as child_process from "child_process";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

function findNewestVsix(repoRoot: string): string | undefined {
  const candidates = fs
    .readdirSync(repoRoot)
    .filter((f) => f.endsWith(".vsix"))
    .map((f) => path.join(repoRoot, f));
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function main(): Promise<void> {
  // Same fix as test/runTest.ts: a parent Electron-based dev tool may set
  // this, and it must not propagate into the VS Code test host we spawn,
  // or it launches in Node/CLI mode instead of as the real Electron GUI
  // app and rejects its own flags.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const repoRoot = path.resolve(__dirname, "../..");
  const vsixPath = process.argv[2] ?? findNewestVsix(repoRoot);
  if (!vsixPath || !fs.existsSync(vsixPath)) {
    throw new Error("No VSIX found. Run `npm run compile && npx vsce package --target darwin-arm64` first, or pass the .vsix path as an argument.");
  }
  console.log("Testing packaged VSIX:", vsixPath);

  const expectedVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;

  // Prefer @vscode/test-electron's own managed VS Code binary (cached under
  // .vscode-test/) rather than the user's real, already-running VS Code
  // installation -- isolated, and never conflicts with or disturbs it.
  const vscodeExecutablePath = await downloadAndUnzipVSCode();
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath, { reuseMachineInstall: false });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-smoke-userdata-"));
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-smoke-extensions-"));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-smoke-workspace-"));

  console.log("Installing the packaged VSIX into a fresh, isolated extensions directory:", extensionsDir);
  const installEnv = { ...process.env };
  delete installEnv.ELECTRON_RUN_AS_NODE;
  child_process.execFileSync(cli, [...cliArgs, "--user-data-dir", userDataDir, "--extensions-dir", extensionsDir, "--install-extension", vsixPath], {
    stdio: "inherit",
    env: installEnv,
  });

  // The throwaway "driver" extension: no Drift implementation of its own,
  // just enough of a package.json for --extensionDevelopmentPath to load,
  // plus the compiled smoke-test assertions as its test entry point.
  const smokeExtDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-smoke-driver-ext-"));
  fs.writeFileSync(
    path.join(smokeExtDir, "package.json"),
    JSON.stringify(
      {
        name: "drift-smoke-test-driver",
        displayName: "Drift Smoke Test Driver (temporary, not part of Drift)",
        version: "0.0.0",
        engines: { vscode: "^1.85.0" },
        private: true,
      },
      null,
      2
    )
  );
  const smokeOutDir = path.join(smokeExtDir, "out");
  fs.mkdirSync(smokeOutDir);
  const compiledRunnerPath = path.resolve(__dirname, "packagedSmokeTestRunner.js");
  fs.copyFileSync(compiledRunnerPath, path.join(smokeOutDir, "testRunner.js"));

  console.log("Launching the isolated extension host (Drift enabled, no --disable-extensions)...");
  const exitCode = await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: smokeExtDir,
    extensionTestsPath: path.join(smokeOutDir, "testRunner.js"),
    launchArgs: ["--user-data-dir", userDataDir, "--extensions-dir", extensionsDir, workspaceDir],
    extensionTestsEnv: {
      DRIFT_SMOKE_EXTENSIONS_DIR: extensionsDir,
      DRIFT_SMOKE_EXPECTED_VERSION: expectedVersion,
      DRIFT_SMOKE_DEV_CHECKOUT_PATH: repoRoot,
    },
  });

  const driftExtensionPath = fs.existsSync(path.join(extensionsDir))
    ? fs.readdirSync(extensionsDir).find((d) => d.toLowerCase().startsWith("kathanaik.drift-agent-monitor"))
    : undefined;

  console.log("\n=== CLEAN-PROFILE PROOF ===");
  console.log("userDataDir:      ", userDataDir);
  console.log("extensionsDir:    ", extensionsDir);
  console.log("installed as:     ", driftExtensionPath ? path.join(extensionsDir, driftExtensionPath) : "(not found)");
  console.log("vsixPath:         ", vsixPath);
  console.log("expectedVersion:  ", expectedVersion);
  console.log("exitCode:         ", exitCode, exitCode === 0 ? "(PASS)" : "(FAIL)");

  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error("packagedSmokeTest.ts failed:", error);
  process.exitCode = 1;
});
