import * as http from "http";
import { DriftStorage } from "./storage";

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

function handleClaudeHook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  storage: DriftStorage,
  onSessionEnd?: SessionEndListener
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

    sendJson(res, 200, { status: "ok" });

    if (body.hook_event_name === "SessionEnd" && onSessionEnd) {
      notifySessionEndListener(body.session_id, onSessionEnd);
    }
  });
  req.on("error", () => {
    sendJson(res, 400, { error: "Invalid request" });
  });
}

export function startRuntime(storage: DriftStorage, onSessionEnd?: SessionEndListener): Promise<DriftRuntime> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "POST" && req.url === "/hooks/claude") {
        handleClaudeHook(req, res, storage, onSessionEnd);
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
