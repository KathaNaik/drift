/**
 * Local inference adapter for Drift's packaged semantic model: Gemma 3 1B
 * Instruct, GGUF, run entirely through a local llama.cpp `llama-server`
 * process (https://github.com/ggml-org/llama.cpp). There is no cloud
 * fallback anywhere in this module — a model path and, optionally, an
 * already-running server URL are the only ways it reaches a model, both
 * supplied explicitly by the caller. It never downloads a model itself.
 *
 * This module is intentionally standalone: it has no dependency on
 * storage.ts, trajectory.ts, or any of the trajectory/telemetry modules,
 * and nothing in those modules depends on this one. Model execution is
 * kept fully separate from trajectory analysis, per this milestone's
 * scope — no detector calls into this module yet.
 *
 * `infer()` never throws. Every failure — a missing binary, a model that
 * fails to load, a request that times out, a malformed response — is
 * caught and reported through the returned InferenceResult's record
 * instead, so a local model problem can never propagate into (or block)
 * a Claude Code hook response.
 */

import { ChildProcess, spawn } from "child_process";
import * as net from "net";

export interface LocalModelConfig {
  /** Absolute path to a local GGUF model file. Required, explicit, never inferred or downloaded. */
  modelPath: string;
  /** Path to the llama-server binary. Defaults to "llama-server", resolved via PATH. */
  llamaServerPath?: string;
  /** Base URL of an already-running llama-server instance to connect to (e.g. "http://127.0.0.1:8712"), instead of spawning a new one. */
  serverUrl?: string;
  /** Context size (-c) passed to a freshly spawned llama-server. Ignored when serverUrl is given. */
  contextSize?: number;
  /** Hard ceiling, in milliseconds, on one infer() call — covers spawning/health-checking a new server (when needed) and the completion request itself. */
  timeoutMs?: number;
}

/** What happened during one inference call, independent of whether it succeeded. */
export interface InferenceRecord {
  startedAt: number;
  durationMs: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  success: boolean;
  error: string | undefined;
}

export interface InferenceResult {
  /** The generated text, or undefined when the call failed. */
  text: string | undefined;
  record: InferenceRecord;
}

/** Per-call generation constraints, layered onto the runtime's own config. */
export interface InferOptions {
  /** Hard cap on generated tokens (llama-server's max_tokens), enforced server-side -- not merely requested via prompt text. Required by callers that need runaway generation structurally bounded, e.g. a JSON-only classifier. */
  maxTokens?: number;
  /** Forces the response to conform to this JSON Schema via llama-server's grammar-constrained decoding (OpenAI-compatible response_format). The schema itself is passed through untouched -- this module doesn't interpret it. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface LocalModelRuntime {
  /** Submits one structured prompt and returns generated text, bounded by the configured timeout. Never throws. */
  infer(prompt: string, options?: InferOptions): Promise<InferenceResult>;
  /** Stops a server this runtime itself spawned. A safe no-op if it only ever connected to an externally-managed server, or never started one. */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CONTEXT_SIZE = 2048;
const HEALTH_POLL_INTERVAL_MS = 250;

interface LlamaChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => {
        if (port !== undefined) resolve(port);
        else reject(new Error("failed to allocate a free local port"));
      });
    });
  });
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(2000, HEALTH_POLL_INTERVAL_MS * 4));
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function waitForHealthy(baseUrl: string, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await isHealthy(baseUrl)) {
      return true;
    }
    await sleep(Math.min(HEALTH_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  return false;
}

const TERMINATE_GRACE_MS = 3000;

/**
 * Terminates a child process Drift itself spawned, waiting for its actual
 * exit event rather than assuming a signal took effect. Escalates to
 * SIGKILL if graceful termination doesn't complete within the grace
 * period. Deliberately has NO absolute give-up ceiling beyond that: a
 * process can be briefly unkillable while blocked in an uninterruptible
 * I/O wait (a real, observed risk during heavy mmap-based model loading
 * under system load), and "zero leaked processes" is an unconditional
 * guarantee this runtime makes -- reporting failure before termination is
 * actually confirmed would silently break that guarantee exactly when the
 * system is busiest. SIGKILL cannot be blocked once the process leaves
 * that wait state, so this always resolves eventually. A safe no-op if
 * the process has already exited.
 */
function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(escalateTimer);
      resolve();
    };

    child.once("exit", finish);

    const escalateTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone -- but exit may not have fired yet if this races
        // with it; finish() will still be invoked by the exit listener.
      }
    }, TERMINATE_GRACE_MS);

    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(escalateTimer);
      finish();
    }
  });
}

type ServerHandle = { ok: true; baseUrl: string } | { ok: false; error: string };

class LocalModelRuntimeImpl implements LocalModelRuntime {
  private readonly modelPath: string;
  private readonly llamaServerPath: string;
  private readonly externalServerUrl: string | undefined;
  private readonly contextSize: number;
  private readonly timeoutMs: number;

  private serverProcess: ChildProcess | undefined;
  private ownedBaseUrl: string | undefined;
  private startPromise: Promise<ServerHandle> | undefined;
  private recentStderr = "";

  constructor(config: LocalModelConfig) {
    this.modelPath = config.modelPath;
    this.llamaServerPath = config.llamaServerPath ?? "llama-server";
    this.externalServerUrl = config.serverUrl;
    this.contextSize = config.contextSize ?? DEFAULT_CONTEXT_SIZE;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private spawnOwnServer(deadline: number): Promise<ServerHandle> {
    return getFreePort().then(
      (port) =>
        new Promise<ServerHandle>((resolve) => {
          const baseUrl = `http://127.0.0.1:${port}`;
          let settled = false;
          const settle = (result: ServerHandle) => {
            if (settled) return;
            settled = true;
            resolve(result);
          };

          let child: ChildProcess;
          try {
            child = spawn(
              this.llamaServerPath,
              ["-m", this.modelPath, "--port", String(port), "--host", "127.0.0.1", "-c", String(this.contextSize)],
              { stdio: ["ignore", "ignore", "pipe"] }
            );
          } catch (error) {
            settle({ ok: false, error: `failed to start ${this.llamaServerPath}: ${error instanceof Error ? error.message : String(error)}` });
            return;
          }

          this.serverProcess = child;

          // Set only when we ourselves decide to kill this process after
          // giving up on it (see below) -- distinguishes "we terminated it
          // after a timeout" from "it crashed on its own" for the exit
          // handler's error message, without changing when that handler
          // fires or what it clears.
          let killedAfterTimeout = false;

          child.stderr?.on("data", (chunk: Buffer) => {
            this.recentStderr = (this.recentStderr + chunk.toString()).slice(-4000);
          });

          child.once("error", (error) => {
            settle({ ok: false, error: `failed to start ${this.llamaServerPath}: ${error.message}` });
          });

          child.once("exit", (code, signal) => {
            if (this.serverProcess === child) {
              this.serverProcess = undefined;
              this.ownedBaseUrl = undefined;
            }
            settle({
              ok: false,
              error: killedAfterTimeout
                ? `llama-server did not become healthy before the timeout${this.recentStderr ? `: ${this.recentStderr.slice(-500)}` : ""}`
                : `llama-server exited before becoming ready (code ${code}, signal ${signal})${this.recentStderr ? `: ${this.recentStderr.slice(-500)}` : ""}`,
            });
          });

          waitForHealthy(baseUrl, deadline).then(async (healthy) => {
            if (healthy) {
              this.ownedBaseUrl = baseUrl;
              settle({ ok: true, baseUrl });
              return;
            }

            // Timed out. If the process already exited on its own, the exit
            // handler above has already settled us with an accurate message
            // and there's nothing left to terminate. Otherwise it's still
            // alive and must not be left running: a caller who just saw
            // infer() fail has no reason to think a process still needs to
            // be torn down.
            if (child.exitCode === null && child.signalCode === null) {
              killedAfterTimeout = true;
              await terminateChild(child);
            }

            // Safety net: guarantees this attempt always settles even in
            // the pathological case where the exit handler above never
            // fires (terminateChild gave up without an exit event).
            settle({
              ok: false,
              error: `llama-server did not become healthy before the timeout${this.recentStderr ? `: ${this.recentStderr.slice(-500)}` : ""}`,
            });
          });
        })
    ).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }

  private ensureServer(deadline: number): Promise<ServerHandle> {
    if (this.externalServerUrl) {
      const url = this.externalServerUrl;
      return waitForHealthy(url, deadline).then((healthy) =>
        healthy ? { ok: true, baseUrl: url } : { ok: false, error: `could not reach existing llama-server at ${url}` }
      );
    }

    if (this.ownedBaseUrl && this.serverProcess && this.serverProcess.exitCode === null) {
      return Promise.resolve({ ok: true, baseUrl: this.ownedBaseUrl });
    }

    if (!this.startPromise) {
      this.startPromise = this.spawnOwnServer(deadline).finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  async infer(prompt: string, options?: InferOptions): Promise<InferenceResult> {
    const startedAt = Date.now();
    const deadline = startedAt + this.timeoutMs;
    const fail = (error: string, inputTokens?: number, outputTokens?: number): InferenceResult => ({
      text: undefined,
      record: { startedAt, durationMs: Date.now() - startedAt, inputTokens, outputTokens, success: false, error },
    });

    try {
      const server = await this.ensureServer(deadline);
      if (!server.ok) {
        return fail(server.error);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return fail("timed out before the completion request could be sent");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: prompt }],
            temperature: 0,
            ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
            ...(options?.jsonSchema !== undefined ? { response_format: { type: "json_schema", json_schema: options.jsonSchema } } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          return fail(`llama-server returned ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`);
        }

        const json = (await response.json()) as LlamaChatCompletionResponse;
        const text = json.choices?.[0]?.message?.content;
        const inputTokens = typeof json.usage?.prompt_tokens === "number" ? json.usage.prompt_tokens : undefined;
        const outputTokens = typeof json.usage?.completion_tokens === "number" ? json.usage.completion_tokens : undefined;

        if (typeof text !== "string") {
          return fail("llama-server response did not contain generated text", inputTokens, outputTokens);
        }

        return {
          text,
          record: { startedAt, durationMs: Date.now() - startedAt, inputTokens, outputTokens, success: true, error: undefined },
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "inference timed out"
          : error instanceof Error
            ? error.message
            : String(error);
      return fail(message);
    }
  }

  async close(): Promise<void> {
    const child = this.serverProcess;
    this.serverProcess = undefined;
    this.ownedBaseUrl = undefined;
    if (!child) {
      return;
    }
    await terminateChild(child);
  }
}

/** Creates a local model runtime for the given config. Nothing is started or connected to until the first infer() call. */
export function createLocalModelRuntime(config: LocalModelConfig): LocalModelRuntime {
  return new LocalModelRuntimeImpl(config);
}
