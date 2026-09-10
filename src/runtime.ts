import * as http from "http";
import { DriftStorage } from "./storage";
import { extractApiRequestRecords, extractModelUsageMetricDataPoints, ExtractedTelemetryRecord } from "./claudeTelemetryIngest";

export interface DriftRuntime {
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * Invoked after a SessionEnd hook has been durably persisted and the HTTP
 * response for it has already been sent — never before, and never in a way
 * that can delay that response. May return a promise; whether it resolves
 * or rejects, its outcome can never affect the hook response (already sent)
 * or the ingestion path.
 */
export type SessionEndListener = (sessionId: string) => void | Promise<void>;

/**
 * The M12B injection boundary. Kept as a plain string-in/string-out
 * interface (never the redirect packet/lifecycle types themselves) so this
 * module stays decoupled from Drift's redirect-approval concerns -- it only
 * ever asks "is there context to inject for this session right now?" and,
 * once that context has actually been written into a real HTTP response,
 * is told so it can mark that redirect consumed.
 */
export interface RedirectInjectionHook {
  /** Returns the exact context block to inject into this session's next UserPromptSubmit, or undefined when nothing is currently eligible. Pure lookup -- never mutates anything. */
  getInjectableContext: (sessionId: string) => string | undefined;
  /** Called only once the injected response has actually been sent successfully -- never on a fallback/failure path. */
  markConsumed: (sessionId: string) => void;
}

interface ClaudeHookPayload {
  session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

function isValidHookPayload(body: unknown): body is ClaudeHookPayload {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const record = body as Record<string, unknown>;
  return (
    typeof record.session_id === "string" &&
    record.session_id.length > 0 &&
    typeof record.hook_event_name === "string" &&
    record.hook_event_name.length > 0
  );
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function notifySessionEndListener(sessionId: string, onSessionEnd: SessionEndListener): void {
  // The hook response has already been sent by the time this runs. Whether
  // the listener throws synchronously or its returned promise rejects, that
  // must never surface here — an unhandled rejection can crash the whole
  // extension host, and even a handled one must never be allowed to affect
  // ingestion, which is already complete.
  try {
    Promise.resolve(onSessionEnd(sessionId)).catch(() => {});
  } catch {
    // Same guarantee for a listener that throws before returning a promise.
  }
}

/**
 * Builds the response body for a UserPromptSubmit hook, injecting Drift's
 * approved redirect context via the real, documented
 * `hookSpecificOutput.additionalContext` field when one is eligible for
 * this exact session -- the same field Claude Code already honors for this
 * event, not an invented transport. Any failure while looking up or
 * formatting the context (redirectInjection is caller-supplied, so
 * defensively guarded here) falls back to the plain ack: an injection
 * failure must never corrupt the hook response or block Claude's session.
 */
function buildUserPromptSubmitResponse(sessionId: string, redirectInjection: RedirectInjectionHook | undefined): { body: unknown; injected: boolean } {
  if (!redirectInjection) return { body: { status: "ok" }, injected: false };
  try {
    const context = redirectInjection.getInjectableContext(sessionId);
    if (context === undefined) return { body: { status: "ok" }, injected: false };
    return {
      body: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: [context] } },
      injected: true,
    };
  } catch {
    return { body: { status: "ok" }, injected: false };
  }
}

function handleClaudeHook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storage: DriftStorage,
  onSessionEnd?: SessionEndListener,
  redirectInjection?: RedirectInjectionHook
): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    if (!isValidHookPayload(body)) {
      sendJson(res, 400, { error: "session_id and hook_event_name are required" });
      return;
    }

    const receivedAt = Date.now();
    storage.ensureSession(body.session_id);
    storage.insertRawEvent(body.session_id, body, receivedAt);

    let responseBody: unknown = { status: "ok" };
    let injected = false;
    if (body.hook_event_name === "UserPromptSubmit") {
      ({ body: responseBody, injected } = buildUserPromptSubmitResponse(body.session_id, redirectInjection));
    }

    try {
      sendJson(res, 200, responseBody);
    } catch {
      // The response never went out -- nothing was consumed, and Claude's
      // own retry/continuation behavior for a failed hook call is unaffected
      // by anything Drift does here.
      injected = false;
    }

    if (injected) {
      try {
        redirectInjection!.markConsumed(body.session_id);
      } catch {
        // Best-effort bookkeeping only; a failure here must never affect the
        // hook exchange, which has already completed successfully.
      }
    }

    if (body.hook_event_name === "SessionEnd" && onSessionEnd) {
      notifySessionEndListener(body.session_id, onSessionEnd);
    }
  });
  req.on("error", () => {
    sendJson(res, 400, { error: "Invalid request" });
  });
}

/**
 * Persists whichever telemetry records `extractRecords` finds in the OTLP
 * body, associating each with a Drift session when the record carried one.
 * Shared by the /v1/logs and /v1/metrics handlers below; the only
 * difference between them is which extractor recognizes their payload
 * shape and which Claude Code events/metrics it looks for.
 */
function handleOtlpTelemetry(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storage: DriftStorage,
  extractRecords: (body: unknown) => ExtractedTelemetryRecord[]
): void {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const receivedAt = Date.now();
    for (const record of extractRecords(body)) {
      if (record.sessionId) {
        storage.ensureSession(record.sessionId);
      }
      storage.insertModelUsageEvent(record.sessionId ?? null, record.raw, receivedAt);
    }

    sendJson(res, 200, { status: "ok" });
  });
  req.on("error", () => {
    sendJson(res, 400, { error: "Invalid request" });
  });
}

export function startRuntime(storage: DriftStorage, onSessionEnd?: SessionEndListener, redirectInjection?: RedirectInjectionHook): Promise<DriftRuntime> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "POST" && req.url === "/hooks/claude") {
        handleClaudeHook(req, res, storage, onSessionEnd, redirectInjection);
        return;
      }

      // Standard OTLP/HTTP JSON receiver paths, for Claude Code's own
      // OpenTelemetry export (a separate, opt-in signal from the hooks
      // above) — see claudeTelemetryIngest.ts.
      if (req.method === "POST" && req.url === "/v1/logs") {
        handleOtlpTelemetry(req, res, storage, extractApiRequestRecords);
        return;
      }

      if (req.method === "POST" && req.url === "/v1/metrics") {
        handleOtlpTelemetry(req, res, storage, extractModelUsageMetricDataPoints);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Drift runtime failed to bind to a port"));
        return;
      }
      resolve({
        port: address.port,
        stop: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

export function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}
