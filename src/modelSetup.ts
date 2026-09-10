/**
 * Manages Drift's two local-inference assets -- the Gemma GGUF model and
 * the llama.cpp `llama-server` runtime -- neither of which ships inside
 * the extension's VSIX (see M15B). Both are downloaded, on explicit user
 * request only, into Drift's own global storage (never the extension's
 * install directory, which is read-only after packaging and gets wiped on
 * every update/reinstall anyway).
 *
 * "Detect existing" is a pure, read-only check: it never re-downloads,
 * never re-verifies more than a single checksum read, and is always safe
 * to call on every activation. Downloading only ever happens in direct
 * response to the explicit setup command -- never automatically.
 *
 * The download URL/checksum for each asset are configurable (defaulting to
 * the real, pinned values below), purely so tests can exercise the full
 * detect/download/verify/extract flow against small local fixtures instead
 * of the real multi-gigabyte model or a live network call.
 */

import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import { downloadAndVerifyFile, sha256File, DownloadProgressCallback } from "./managedDownload";

export interface ModelAssetConfig {
  fileName: string;
  downloadUrl: string;
  sha256: string;
}

export interface LlamaRuntimeAssetConfig {
  /** A subdirectory name under global storage -- keeping different pinned versions from ever colliding on disk. */
  version: string;
  downloadUrl: string;
  sha256: string;
}

// A real, verified-live Hugging Face asset (bartowski's GGUF quantization
// of google/gemma-3-4b-it) paired with its own published LFS SHA-256 --
// checked directly against the Hugging Face API when this was pinned.
export const DEFAULT_MODEL_CONFIG: ModelAssetConfig = {
  fileName: "gemma-3-4b-it-IQ4_XS.gguf",
  downloadUrl: "https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-IQ4_XS.gguf",
  sha256: "454203445fa713897277e2e4cbfc07db003006198126031e7e622a10058c459f",
};

// A real, verified-live llama.cpp GitHub release asset for macOS arm64.
// Its own dylibs ship alongside the binary with an @loader_path rpath (no
// Homebrew or any other absolute install-path dependency) -- confirmed
// directly against the downloaded archive when this was pinned.
export const DEFAULT_LLAMA_RUNTIME_CONFIG: LlamaRuntimeAssetConfig = {
  version: "b10886",
  downloadUrl: "https://github.com/ggml-org/llama.cpp/releases/download/b10886/llama-b10886-bin-macos-arm64.tar.gz",
  sha256: "7c91c1c307a0eb13f921310a965a064f4549b810f3a93ba869ea4d8d1c25bc98",
};

export type ManagedAssetReason = "not_installed" | "checksum_mismatch";

export interface ManagedAssetStatus {
  ready: boolean;
  path: string;
  reason: ManagedAssetReason | undefined;
}

export interface ManagedAssetResult {
  success: boolean;
  path: string | undefined;
  error: string | undefined;
}

function modelsDir(globalStorageDir: string): string {
  return path.join(globalStorageDir, "models");
}

function llamaRuntimeDir(globalStorageDir: string, config: LlamaRuntimeAssetConfig): string {
  return path.join(globalStorageDir, "llama-runtime", config.version);
}

export function getManagedModelPath(globalStorageDir: string, config: ModelAssetConfig = DEFAULT_MODEL_CONFIG): string {
  return path.join(modelsDir(globalStorageDir), config.fileName);
}

export function getManagedLlamaServerPath(globalStorageDir: string, config: LlamaRuntimeAssetConfig = DEFAULT_LLAMA_RUNTIME_CONFIG): string {
  return path.join(llamaRuntimeDir(globalStorageDir, config), "llama-server");
}

/** Read-only: existence plus a checksum re-read, never a network call and never a write. Safe to call on every activation. */
export async function checkModelStatus(globalStorageDir: string, config: ModelAssetConfig = DEFAULT_MODEL_CONFIG): Promise<ManagedAssetStatus> {
  const modelPath = getManagedModelPath(globalStorageDir, config);
  if (!fs.existsSync(modelPath)) {
    return { ready: false, path: modelPath, reason: "not_installed" };
  }
  const actual = await sha256File(modelPath);
  if (actual !== config.sha256) {
    return { ready: false, path: modelPath, reason: "checksum_mismatch" };
  }
  return { ready: true, path: modelPath, reason: undefined };
}

/**
 * Read-only: the runtime's own binary is only ever placed here by
 * installLlamaRuntime, which already verified the archive's checksum
 * before extracting it -- presence of the binary is itself sufficient
 * evidence of a successful, verified install, so this never re-hashes the
 * (much larger, already-extracted) directory on every activation.
 */
export function checkLlamaRuntimeStatus(globalStorageDir: string, config: LlamaRuntimeAssetConfig = DEFAULT_LLAMA_RUNTIME_CONFIG): ManagedAssetStatus {
  const binaryPath = getManagedLlamaServerPath(globalStorageDir, config);
  return fs.existsSync(binaryPath) ? { ready: true, path: binaryPath, reason: undefined } : { ready: false, path: binaryPath, reason: "not_installed" };
}

/** Downloads and verifies the model. Only ever called in direct response to an explicit user action -- never from checkModelStatus, never on activation. */
export async function downloadModel(globalStorageDir: string, onProgress?: DownloadProgressCallback, config: ModelAssetConfig = DEFAULT_MODEL_CONFIG): Promise<ManagedAssetResult> {
  return downloadAndVerifyFile(config.downloadUrl, getManagedModelPath(globalStorageDir, config), config.sha256, onProgress);
}

/**
 * Downloads the llama.cpp release archive, verifies it, and extracts it
 * into Drift's global storage. The archive itself is removed once
 * extraction succeeds -- only the runnable binary and its sibling dylibs
 * remain. Any failure (download, checksum, or extraction) leaves no
 * partial install directory behind: interrupted or corrupted attempts are
 * contained exactly like a plain file download.
 */
export async function installLlamaRuntime(globalStorageDir: string, onProgress?: DownloadProgressCallback, config: LlamaRuntimeAssetConfig = DEFAULT_LLAMA_RUNTIME_CONFIG): Promise<ManagedAssetResult> {
  const archivePath = path.join(globalStorageDir, "llama-runtime", `llama-${config.version}.tar.gz`);
  const downloadResult = await downloadAndVerifyFile(config.downloadUrl, archivePath, config.sha256, onProgress);
  if (!downloadResult.success) {
    return { success: false, path: undefined, error: downloadResult.error };
  }

  const extractDir = llamaRuntimeDir(globalStorageDir, config);
  try {
    fs.mkdirSync(extractDir, { recursive: true });
    // The archive's own top-level directory (e.g. "llama-b10886/") is
    // stripped so its contents land directly in extractDir, matching
    // getManagedLlamaServerPath's own layout expectation.
    child_process.execFileSync("/usr/bin/tar", ["-xzf", archivePath, "--strip-components=1", "-C", extractDir]);
    fs.chmodSync(getManagedLlamaServerPath(globalStorageDir, config), 0o755);
  } catch (error) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    return { success: false, path: undefined, error: error instanceof Error ? error.message : String(error) };
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  return { success: true, path: getManagedLlamaServerPath(globalStorageDir, config), error: undefined };
}
