import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  try {
    // A parent process (e.g. an Electron-based dev tool) may set this to run
    // Node scripts through an Electron binary. It must not propagate to the
    // VS Code test host we spawn below, or the host launches in Node/CLI
    // mode instead of as the Electron GUI app and rejects its own flags.
    delete process.env.ELECTRON_RUN_AS_NODE;

    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    // Some tests (e.g. the Claude hook installer) need a real workspace
    // folder to resolve a project-local path against.
    const testWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "drift-test-workspace-"));

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [testWorkspace],
    });
  } catch (err) {
    console.error("Failed to run tests", err);
    process.exit(1);
  }
}

main();
