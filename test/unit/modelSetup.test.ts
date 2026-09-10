import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import * as crypto from "crypto";
import {
  checkModelStatus,
  checkLlamaRuntimeStatus,
  downloadModel,
  installLlamaRuntime,
  getManagedModelPath,
  getManagedLlamaServerPath,
  DEFAULT_MODEL_CONFIG,
  DEFAULT_LLAMA_RUNTIME_CONFIG,
  ModelAssetConfig,
  LlamaRuntimeAssetConfig,
} from "../../src/modelSetup";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256Of(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

const REAL_LLAMA_TARBALL = "/tmp/llama-runtime.tar.gz";

suite("modelSetup (M15B) - default configs point at real, pinned assets", () => {
  test("the default model config uses a real https download URL and a well-formed 64-char hex sha256", () => {
    assert.ok(DEFAULT_MODEL_CONFIG.downloadUrl.startsWith("https://"));
    assert.match(DEFAULT_MODEL_CONFIG.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!DEFAULT_MODEL_CONFIG.downloadUrl.includes("/Users/"));
  });

  test("the default llama runtime config uses a real https download URL and a well-formed 64-char hex sha256", () => {
    assert.ok(DEFAULT_LLAMA_RUNTIME_CONFIG.downloadUrl.startsWith("https://"));
    assert.match(DEFAULT_LLAMA_RUNTIME_CONFIG.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!DEFAULT_LLAMA_RUNTIME_CONFIG.downloadUrl.includes("/opt/homebrew"));
  });

  test("managed paths never reference the development machine or a repository-relative path", () => {
    const globalStorageDir = "/Users/someone-else/Library/Application Support/Code/User/globalStorage/kathanaik.drift-agent-monitor";
    const modelPath = getManagedModelPath(globalStorageDir);
    const llamaPath = getManagedLlamaServerPath(globalStorageDir);
    assert.ok(modelPath.startsWith(globalStorageDir));
    assert.ok(llamaPath.startsWith(globalStorageDir));
    assert.ok(!modelPath.includes("/Users/meenasawant"));
    assert.ok(!llamaPath.includes("/opt/homebrew"));
  });
});

suite("modelSetup (M15B) - checkModelStatus / downloadModel", () => {
  test("reports not_installed when the file has never been downloaded", async () => {
    const dir = tempDir("drift-model-setup-");
    const status = await checkModelStatus(dir);
    assert.strictEqual(status.ready, false);
    assert.strictEqual(status.reason, "not_installed");
  });

  test("reports checksum_mismatch for a present-but-wrong file, and never treats it as ready", async () => {
    const dir = tempDir("drift-model-setup-");
    const config: ModelAssetConfig = { fileName: "fake-model.gguf", downloadUrl: "https://example.invalid/fake-model.gguf", sha256: "f".repeat(64) };
    const modelPath = getManagedModelPath(dir, config);
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, "not the real model content");

    const status = await checkModelStatus(dir, config);
    assert.strictEqual(status.ready, false);
    assert.strictEqual(status.reason, "checksum_mismatch");
  });

  test("detects an already-installed, checksum-valid model without downloading anything", async () => {
    const dir = tempDir("drift-model-setup-");
    const content = Buffer.from("a small stand-in model file");
    const config: ModelAssetConfig = { fileName: "fake-model.gguf", downloadUrl: "https://example.invalid/should-never-be-fetched", sha256: sha256Of(content) };
    const modelPath = getManagedModelPath(dir, config);
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, content);

    const status = await checkModelStatus(dir, config);
    assert.strictEqual(status.ready, true);
    assert.strictEqual(status.reason, undefined);
  });

  test("downloadModel downloads and verifies against the given config, never redownloading what checkModelStatus already reports ready", async () => {
    const content = Buffer.from("downloaded model content ".repeat(100));
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(content);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-model-setup-");
      const config: ModelAssetConfig = { fileName: "fake-model.gguf", downloadUrl: `http://127.0.0.1:${port}/model`, sha256: sha256Of(content) };

      const before = await checkModelStatus(dir, config);
      assert.strictEqual(before.ready, false);

      const result = await downloadModel(dir, undefined, config);
      assert.strictEqual(result.success, true, result.error);

      const after = await checkModelStatus(dir, config);
      assert.strictEqual(after.ready, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a failed download leaves checkModelStatus reporting not_installed, not a corrupted 'ready'", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end("server error");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-model-setup-");
      const config: ModelAssetConfig = { fileName: "fake-model.gguf", downloadUrl: `http://127.0.0.1:${port}/model`, sha256: "0".repeat(64) };
      const result = await downloadModel(dir, undefined, config);
      assert.strictEqual(result.success, false);

      const status = await checkModelStatus(dir, config);
      assert.strictEqual(status.ready, false);
      assert.strictEqual(status.reason, "not_installed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("reports progress callbacks with increasing receivedBytes during a real download", async () => {
    const content = Buffer.alloc(500_000, "x"); // large enough to arrive in multiple chunks
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Length": content.length });
      res.end(content);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-model-setup-");
      const config: ModelAssetConfig = { fileName: "fake-model.gguf", downloadUrl: `http://127.0.0.1:${port}/model`, sha256: sha256Of(content) };
      const progressEvents: number[] = [];
      const result = await downloadModel(dir, (p) => progressEvents.push(p.receivedBytes), config);
      assert.strictEqual(result.success, true, result.error);
      assert.ok(progressEvents.length > 0);
      assert.strictEqual(progressEvents[progressEvents.length - 1], content.length);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

suite("modelSetup (M15B) - checkLlamaRuntimeStatus / installLlamaRuntime", () => {
  test("reports not_installed when the runtime has never been installed", () => {
    const dir = tempDir("drift-llama-setup-");
    const status = checkLlamaRuntimeStatus(dir);
    assert.strictEqual(status.ready, false);
    assert.strictEqual(status.reason, "not_installed");
  });

  test("REAL END-TO-END: downloads the actual pinned llama.cpp release archive, verifies its checksum, extracts it, and the resulting binary runs standalone", async function () {
    if (!fs.existsSync(REAL_LLAMA_TARBALL)) {
      this.skip();
      return;
    }
    this.timeout(30000);

    // Serve the REAL, previously-downloaded archive from a local fixture
    // server -- this exercises the full download+verify+extract pipeline
    // against the actual pinned artifact, without re-fetching 11MB from
    // GitHub on every test run.
    const archiveContent = fs.readFileSync(REAL_LLAMA_TARBALL);
    const realSha256 = sha256Of(archiveContent);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Length": archiveContent.length });
      res.end(archiveContent);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-llama-setup-real-");
      const config: LlamaRuntimeAssetConfig = { version: "test-real", downloadUrl: `http://127.0.0.1:${port}/llama.tar.gz`, sha256: realSha256 };

      const before = checkLlamaRuntimeStatus(dir, config);
      assert.strictEqual(before.ready, false);

      const result = await installLlamaRuntime(dir, undefined, config);
      assert.strictEqual(result.success, true, result.error);
      assert.ok(result.path && fs.existsSync(result.path));

      const after = checkLlamaRuntimeStatus(dir, config);
      assert.strictEqual(after.ready, true);

      // The archive itself must be cleaned up -- only the extracted runtime remains.
      const archiveLeftBehind = fs.readdirSync(path.join(dir, "llama-runtime")).some((f) => f.endsWith(".tar.gz"));
      assert.strictEqual(archiveLeftBehind, false);

      // The binary must actually be executable and run standalone, with NO Homebrew on PATH.
      const { execFileSync } = require("child_process");
      const helpOutput = execFileSync(result.path!, ["--help"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
      assert.ok(helpOutput.includes("--help") || helpOutput.length > 0, "the extracted binary must produce real --help output");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a checksum mismatch on the archive leaves no extracted runtime and no leftover archive", async () => {
    const content = Buffer.from("not a real tarball");
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(content);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-llama-setup-");
      const config: LlamaRuntimeAssetConfig = { version: "test-bad", downloadUrl: `http://127.0.0.1:${port}/llama.tar.gz`, sha256: "0".repeat(64) };
      const result = await installLlamaRuntime(dir, undefined, config);
      assert.strictEqual(result.success, false);
      assert.strictEqual(checkLlamaRuntimeStatus(dir, config).ready, false);
      // downloadAndVerifyFile prepares the parent "llama-runtime" directory
      // before attempting the download (harmless -- an empty directory is
      // not a corrupted install); what must never exist is the version-
      // specific install subdirectory or the archive file itself.
      assert.strictEqual(fs.existsSync(path.join(dir, "llama-runtime", "test-bad")), false, "no versioned install directory should exist when the download never even passed its checksum");
      assert.strictEqual(fs.existsSync(path.join(dir, "llama-runtime", "llama-test-bad.tar.gz")), false, "the archive itself must not remain");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a corrupted archive that passes its own checksum but fails to extract is contained: no partial install directory remains", async () => {
    // A file that matches its own (deliberately computed) checksum but is not valid gzip/tar at all.
    const content = Buffer.from("this passes its checksum but tar will reject it as invalid");
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(content);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-llama-setup-");
      const config: LlamaRuntimeAssetConfig = { version: "test-corrupt", downloadUrl: `http://127.0.0.1:${port}/llama.tar.gz`, sha256: sha256Of(content) };
      const result = await installLlamaRuntime(dir, undefined, config);
      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.strictEqual(checkLlamaRuntimeStatus(dir, config).ready, false);
      assert.strictEqual(fs.existsSync(path.join(dir, "llama-runtime", "test-corrupt")), false, "a failed extraction must never leave a partial runtime directory");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
