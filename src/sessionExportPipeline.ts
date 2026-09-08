import { DriftStorage } from "./storage";
import { normalizeRawEvent } from "./normalizedEvent";
import { buildTrajectory } from "./trajectory";
import { buildOtelTrace } from "./otelProjection";
import { exportTrace, OtlpExportConfig, OtlpExportResult } from "./otlpExporter";

/**
 * Runs one session's already-persisted raw events through the full
 * pipeline: normalization (M5A) -> trajectory reconstruction (M5B) -> OTel
 * projection (M6A) -> OTLP export (M6B/M6B.1/M6B.2).
 *
 * SQLite remains the source of truth throughout: this only reads raw
 * events that are already durably stored, and the only writes that happen
 * anywhere in the pipeline are exportTrace's own export bookkeeping
 * (exported_traces / export_leases) — nothing here ever touches or
 * mutates the stored raw events or sessions.
 *
 * Every step through buildOtelTrace is a pure, synchronous, in-memory
 * transformation with nothing to fail; exportTrace itself already
 * guarantees it never throws for the network step. This function adds one
 * more layer of defense (a session that no longer exists, or an
 * unexpected error in an earlier step) so a caller invoking this
 * fire-and-forget can rely on it never rejecting.
 */
export async function exportSessionOnEnd(
  sessionId: string,
  storage: DriftStorage,
  config: OtlpExportConfig
): Promise<OtlpExportResult | undefined> {
  try {
    const sessionData = storage.getSession(sessionId);
    if (!sessionData) {
      return undefined;
    }

    const normalizedEvents = sessionData.events.map(normalizeRawEvent);
    const trajectory = buildTrajectory(sessionId, normalizedEvents);
    const trace = buildOtelTrace(trajectory);

    return await exportTrace(trace, config, storage);
  } catch (err) {
    return { attempted: false, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
