import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
import { OtelTrace, OtelSpan, OtelSpanEvent } from "./otelProjection";
import { DriftStorage } from "./storage";

const EXPORT_TIMEOUT_MS = 5000;

/**
 * A lease must outlive the request it protects, or a still-in-flight export
 * could have its lease reclaimed by another caller before it even finishes.
 * Derived from the actual timeoutMs used for this call (with a 50% buffer
 * for the surrounding claim/release bookkeeping) rather than a fixed
 * constant unrelated to that timeout, so a shorter timeoutMs (e.g. in
 * tests) yields a proportionally shorter, still-safe lease.
 */
const LEASE_SAFETY_MARGIN_MULTIPLIER = 1.5;

function leaseDurationFor(timeoutMs: number): number {
  return Math.ceil(timeoutMs * LEASE_SAFETY_MARGIN_MULTIPLIER);
}

export interface OtlpExportConfig {
  enabled: boolean;
  /** Full OTLP/HTTP JSON traces endpoint, e.g. "http://localhost:4318/v1/traces". */
  endpoint?: string;
}

export type OtlpExportSkippedReason = "disabled" | "no_endpoint" | "already_exported" | "already_exporting";

export interface OtlpExportResult {
  /** Whether a network request was actually made. */
  attempted: boolean;
  success: boolean;
  skippedReason?: OtlpExportSkippedReason;
  error?: string;
}

function msToUnixNanoString(ms: number): string {
  return String(Math.round(ms * 1_000_000));
}

/**
 * A real OTLP collector expects fixed-length hex trace/span ids (128-bit /
 * 64-bit). Drift's own ids (a session id, "span-root", "span-3-1", ...) are
 * human-readable and not shaped that way, so they're deterministically
 * hashed into valid OTLP ids at export time only — the ids Drift itself
 * uses internally (OtelTrace.traceId, OtelSpan.spanId) are never changed.
 */
function otlpTraceId(traceId: string): string {
  return crypto.createHash("sha256").update(traceId).digest("hex").slice(0, 32);
}

function otlpSpanId(spanId: string): string {
  return crypto.createHash("sha256").update(spanId).digest("hex").slice(0, 16);
}

function otlpAttributeValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { intValue: String(Math.trunc(value)) };
  if (value === undefined) return { stringValue: "" };
  return { stringValue: JSON.stringify(value) };
}

function otlpAttributes(attributes: Record<string, unknown>): unknown[] {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: otlpAttributeValue(value) }));
}

function otlpSpanEvent(event: OtelSpanEvent): unknown {
  return {
    name: event.name,
    timeUnixNano: msToUnixNanoString(event.timestampUnixMs),
    attributes: otlpAttributes(event.attributes),
  };
}

function otlpSpan(span: OtelSpan): unknown {
  return {
    traceId: otlpTraceId(span.traceId),
    spanId: otlpSpanId(span.spanId),
    ...(span.parentSpanId ? { parentSpanId: otlpSpanId(span.parentSpanId) } : {}),
    name: span.name,
    startTimeUnixNano: msToUnixNanoString(span.startTimeUnixMs),
    endTimeUnixNano: msToUnixNanoString(span.endTimeUnixMs),
    attributes: otlpAttributes(span.attributes),
    events: span.events.map(otlpSpanEvent),
  };
}

/**
 * Converts a Drift OtelTrace into an OTLP/HTTP JSON traces request body.
 * Pure and deterministic: the same trace always produces the same body.
 */
export function buildOtlpPayload(trace: OtelTrace): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "drift" } }] },
        scopeSpans: [
          {
            scope: { name: "drift" },
            spans: trace.spans.map(otlpSpan),
          },
        ],
      },
    ],
  };
}

function postJson(endpoint: string, body: string, timeoutMs: number): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch (err) {
      reject(err);
      return;
    }

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0 }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("OTLP export timed out"));
    });
    req.end(body);
  });
}

/**
 * Exports one trace to the configured OTLP endpoint, at most once per
 * session (tracked durably in Drift's own storage — the local database
 * remains the source of truth for what has and hasn't been exported).
 *
 * Safe under concurrent callers for the same session: before ever reaching
 * the network, a caller must atomically claim a time-bounded lease via
 * `storage.claimExport`, keyed by a fresh `ownerId` generated for this call.
 * That claim attempt happens synchronously (no `await` before it), so a
 * second concurrent call can only run its own claim attempt after the first
 * has already completed synchronously — exactly one caller ever wins the
 * lease and reaches the network, and the loser returns
 * `skippedReason: "already_exporting"` without attempting anything.
 *
 * A failed attempt releases its own lease (matched by `ownerId`, so it can
 * never release a lease someone else has since reclaimed) so a later retry
 * is allowed immediately. If the process instead crashes mid-export and
 * never reaches the release, the lease isn't released — but because it was
 * granted for a bounded duration (see `leaseDurationFor`), it simply
 * expires, and the next attempt reclaims it rather than being blocked
 * forever. A successful export is recorded permanently in exported_traces.
 *
 * Never throws and always resolves within `timeoutMs`: disabled config, a
 * missing endpoint, a network error, a timeout, or a non-2xx response all
 * produce a result object describing what happened instead of an
 * exception, so a broken or slow OTLP collector can never block or disrupt
 * the Claude session that produced this trace.
 */
export async function exportTrace(
  trace: OtelTrace,
  config: OtlpExportConfig,
  storage: DriftStorage,
  timeoutMs: number = EXPORT_TIMEOUT_MS
): Promise<OtlpExportResult> {
  if (!config.enabled) {
    return { attempted: false, success: false, skippedReason: "disabled" };
  }
  if (!config.endpoint) {
    return { attempted: false, success: false, skippedReason: "no_endpoint" };
  }
  if (storage.hasExportedTrace(trace.traceId)) {
    return { attempted: false, success: false, skippedReason: "already_exported" };
  }

  const ownerId = crypto.randomUUID();
  if (!storage.claimExport(trace.traceId, ownerId, leaseDurationFor(timeoutMs))) {
    return { attempted: false, success: false, skippedReason: "already_exporting" };
  }

  try {
    const body = JSON.stringify(buildOtlpPayload(trace));
    const response = await postJson(config.endpoint, body, timeoutMs);

    if (response.statusCode >= 200 && response.statusCode < 300) {
      storage.markTraceExported(trace.traceId);
      storage.releaseExportClaim(trace.traceId, ownerId);
      return { attempted: true, success: true };
    }
    storage.releaseExportClaim(trace.traceId, ownerId);
    return { attempted: true, success: false, error: `HTTP ${response.statusCode}` };
  } catch (err) {
    storage.releaseExportClaim(trace.traceId, ownerId);
    return { attempted: true, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
