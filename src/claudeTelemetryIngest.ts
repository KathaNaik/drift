/**
 * Parses Claude Code's own OpenTelemetry export (OTLP/HTTP JSON) — a
 * separate, opt-in telemetry stream from the hook-based capture in
 * runtime.ts, configured via CLAUDE_CODE_ENABLE_TELEMETRY /
 * OTEL_EXPORTER_OTLP_ENDPOINT. This module is intentionally decoupled from
 * hook ingestion: nothing here merges telemetry into normalized events or
 * trajectories (that's explicitly out of scope for this milestone).
 *
 * Field names below (model, request_id, client_request_id, input_tokens,
 * output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
 * duration_ms, session.id) are taken directly from Claude Code's documented
 * `claude_code.api_request` event and `claude_code.token.usage` /
 * `claude_code.cost.usage` metrics — not invented. Anything not explicitly
 * listed there is left alone: it's still preserved in the raw payload this
 * module extracts records from, just not promoted into ClaudeModelUsage.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Number(value))) return Number(value);
  return undefined;
}

/**
 * Decodes an OTLP AnyValue JSON object ({ stringValue } | { intValue } |
 * { doubleValue } | { boolValue }, per the OTLP/HTTP JSON encoding, where
 * 64-bit integers are decimal strings) into a plain JS value.
 */
function decodeAttributeValue(value: unknown): string | number | boolean | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  if ("stringValue" in value) return str(value.stringValue);
  if ("intValue" in value) return num(value.intValue);
  if ("doubleValue" in value) return num(value.doubleValue);
  if ("boolValue" in value) return typeof value.boolValue === "boolean" ? value.boolValue : undefined;
  return undefined;
}

/** Exposed for modelUsageCorrelation.ts, so it can read attributes off a stored raw telemetry payload without duplicating this decoding logic. */
export function attributesToMap(attributes: unknown): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const attr of asArray(attributes)) {
    if (isPlainObject(attr) && typeof attr.key === "string") {
      map[attr.key] = decodeAttributeValue(attr.value);
    }
  }
  return map;
}

/** One record extracted from an OTLP payload, ready to persist. */
export interface ExtractedTelemetryRecord {
  sessionId: string | undefined;
  /** The specific log record / metric data point this came from — not the whole batch. */
  raw: unknown;
}

/**
 * Walks an OTLP Logs JSON body (ExportLogsServiceRequest) and returns every
 * `claude_code.api_request` log record found, in document order. Anything
 * else in the batch (other event names, malformed entries) is ignored, not
 * rejected — a batch can legitimately contain events this milestone
 * doesn't care about yet.
 */
export function extractApiRequestRecords(body: unknown): ExtractedTelemetryRecord[] {
  const records: ExtractedTelemetryRecord[] = [];
  if (!isPlainObject(body)) {
    return records;
  }

  for (const resourceLog of asArray(body.resourceLogs)) {
    if (!isPlainObject(resourceLog)) continue;
    for (const scopeLog of asArray(resourceLog.scopeLogs)) {
      if (!isPlainObject(scopeLog)) continue;
      for (const logRecord of asArray(scopeLog.logRecords)) {
        if (!isPlainObject(logRecord)) continue;

        const attributes = attributesToMap(logRecord.attributes);
        // Newer OTel log APIs carry the event name as a top-level field;
        // older ones carry it as an "event.name" attribute. Accept either.
        const eventName = str(logRecord.eventName) ?? str(attributes["event.name"]);
        if (eventName !== "claude_code.api_request") {
          continue;
        }

        records.push({ sessionId: str(attributes["session.id"]), raw: logRecord });
      }
    }
  }

  return records;
}

/**
 * Walks an OTLP Metrics JSON body (ExportMetricsServiceRequest) and returns
 * one record per individual data point found on `claude_code.token.usage`
 * and `claude_code.cost.usage` metrics, in document order (a single metric
 * can report one data point per token type/model/session combination in
 * one export). Each record's `raw` is the complete original metric object
 * — verbatim, never reconstructed or field-whitelisted — so `description`,
 * `aggregationTemporality`, `isMonotonic`, and any field OTel adds in the
 * future all survive, even though only the current data point's own
 * attributes are used to determine that record's `sessionId`. Sibling data
 * points on the same metric are therefore visible in each other's raw
 * payload too (they're part of the same original object) — an accepted
 * consequence of "verbatim", not a bug.
 */
export function extractModelUsageMetricDataPoints(body: unknown): ExtractedTelemetryRecord[] {
  const records: ExtractedTelemetryRecord[] = [];
  if (!isPlainObject(body)) {
    return records;
  }

  const relevantMetricNames = new Set(["claude_code.token.usage", "claude_code.cost.usage"]);

  for (const resourceMetric of asArray(body.resourceMetrics)) {
    if (!isPlainObject(resourceMetric)) continue;
    for (const scopeMetric of asArray(resourceMetric.scopeMetrics)) {
      if (!isPlainObject(scopeMetric)) continue;
      for (const metric of asArray(scopeMetric.metrics)) {
        if (!isPlainObject(metric) || !relevantMetricNames.has(str(metric.name) ?? "")) continue;

        // A counter/gauge's data points live under "sum" or "gauge" respectively.
        const aggregation = isPlainObject(metric.sum) ? metric.sum : isPlainObject(metric.gauge) ? metric.gauge : undefined;
        for (const dataPoint of asArray(aggregation?.dataPoints)) {
          if (!isPlainObject(dataPoint)) continue;
          const attributes = attributesToMap(dataPoint.attributes);
          records.push({ sessionId: str(attributes["session.id"]), raw: metric });
        }
      }
    }
  }

  return records;
}

/** Provider-independent view of one Claude API request's usage, recovered from a raw telemetry record. Any field absent from the source telemetry is simply undefined — never fabricated. */
export interface ClaudeModelUsage {
  sessionId: string | undefined;
  model: string | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheCreationTokens: number | undefined;
  requestId: string | undefined;
  durationMs: number | undefined;
  costUsd: number | undefined;
}

/** Exposed for trajectoryUsageAttribution.ts, which needs an all-undefined usage to zero out a duplicate metric occurrence (see metricOccurrenceFingerprint) without fabricating it as a real all-zero record. */
export function emptyClaudeModelUsage(): ClaudeModelUsage {
  return {
    sessionId: undefined,
    model: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheCreationTokens: undefined,
    requestId: undefined,
    durationMs: undefined,
    costUsd: undefined,
  };
}

/**
 * True for a verbatim OTLP metric object (the shape extractModelUsageMetricDataPoints
 * stores per M7A.1) -- `name` plus a `sum`/`gauge` aggregation -- and false
 * for a `claude_code.api_request` log record, which has neither.
 */
function isMetricShaped(payload: unknown): payload is Record<string, unknown> & { name: string } {
  return isPlainObject(payload) && typeof payload.name === "string" && (isPlainObject(payload.sum) || isPlainObject(payload.gauge));
}

function metricDataPoints(payload: Record<string, unknown>): Record<string, unknown>[] {
  const aggregation = isPlainObject(payload.sum) ? payload.sum : isPlainObject(payload.gauge) ? payload.gauge : undefined;
  return asArray(aggregation?.dataPoints).filter(isPlainObject);
}

/**
 * M13D: real, non-interactive (`claude -p`) Claude Code CLI sessions were
 * confirmed (live) to emit no `claude_code.api_request` log record at all --
 * only periodic `claude_code.token.usage` / `claude_code.cost.usage`
 * metrics. Recovers the same provider-independent usage fields from one of
 * those metric objects: cost.usage carries a single data point (its own
 * `asDouble`/`asInt` is the cost); token.usage carries one data point per
 * token `type` attribute (input/output/cacheRead/cacheCreation). Neither
 * metric's data points carry a request id or a per-call duration anywhere
 * in Claude Code's documented attributes for them, so those two fields stay
 * undefined here -- never reconstructed from `claude_code.active_time.total`
 * or any other CLI-wide activity metric, which measures something else
 * entirely (total wall-clock CLI activity, not one request's duration).
 */
function extractModelUsageFromMetric(payload: Record<string, unknown> & { name: string }): ClaudeModelUsage {
  const usage = emptyClaudeModelUsage();
  const dataPoints = metricDataPoints(payload);
  if (dataPoints.length === 0) return usage;

  const firstAttributes = attributesToMap(dataPoints[0].attributes);
  usage.sessionId = str(firstAttributes["session.id"]);
  usage.model = str(firstAttributes["model"]);

  if (payload.name === "claude_code.cost.usage") {
    usage.costUsd = num(dataPoints[0].asDouble ?? dataPoints[0].asInt);
    return usage;
  }

  if (payload.name === "claude_code.token.usage") {
    for (const dataPoint of dataPoints) {
      const attributes = attributesToMap(dataPoint.attributes);
      const type = str(attributes["type"]);
      const value = num(dataPoint.asDouble ?? dataPoint.asInt);
      if (type === "input") usage.inputTokens = value;
      else if (type === "output") usage.outputTokens = value;
      else if (type === "cacheRead") usage.cacheReadTokens = value;
      else if (type === "cacheCreation") usage.cacheCreationTokens = value;
    }
    return usage;
  }

  return usage;
}

/**
 * Recovers the fields this milestone cares about from one persisted
 * model-usage telemetry record -- either a `claude_code.api_request` log
 * record (as returned by extractApiRequestRecords) or a
 * `claude_code.token.usage` / `claude_code.cost.usage` metric object (as
 * returned by extractModelUsageMetricDataPoints; see M13D). Never throws: a
 * record missing some or all of the relevant fields just yields undefined
 * for each of them.
 */
export function extractModelUsage(usageEventPayload: unknown): ClaudeModelUsage {
  if (isMetricShaped(usageEventPayload)) {
    return extractModelUsageFromMetric(usageEventPayload);
  }

  const attributes = isPlainObject(usageEventPayload) ? attributesToMap(usageEventPayload.attributes) : {};

  return {
    sessionId: str(attributes["session.id"]),
    model: str(attributes["model"]),
    inputTokens: num(attributes["input_tokens"]),
    outputTokens: num(attributes["output_tokens"]),
    cacheReadTokens: num(attributes["cache_read_tokens"]),
    cacheCreationTokens: num(attributes["cache_creation_tokens"]),
    requestId: str(attributes["request_id"]) ?? str(attributes["client_request_id"]),
    durationMs: num(attributes["duration_ms"]),
    costUsd: num(attributes["cost_usd"]),
  };
}

/**
 * A stable identity for one metric *occurrence*, built only from fields
 * Claude Code itself reports on each data point (its own `type`, and its
 * own declared `startTimeUnixNano`/`timeUnixNano` aggregation window) --
 * never a timestamp *guess*. Two stored model-usage rows sharing this
 * fingerprint describe the exact same real occurrence, either because
 * extractModelUsageMetricDataPoints stored one row per sibling data point
 * on a single multi-data-point export (M7A.1's own "one row per data
 * point" convention), or because the real CLI's periodic exporter re-sent
 * an unchanged delta window on a later tick (confirmed live in M13D-LIVE) --
 * and must be counted as ONE occurrence, not once per stored row. Returns
 * undefined for a `claude_code.api_request` log record: each one already
 * represents its own distinct request, with nothing to deduplicate against.
 */
export function metricOccurrenceFingerprint(payload: unknown): string | undefined {
  if (!isMetricShaped(payload)) return undefined;
  const dataPoints = metricDataPoints(payload);
  if (dataPoints.length === 0) return undefined;

  const parts = dataPoints
    .map((dataPoint) => {
      const attributes = attributesToMap(dataPoint.attributes);
      return [str(attributes["session.id"]) ?? "", str(attributes["type"]) ?? "", str(dataPoint.startTimeUnixNano) ?? "", str(dataPoint.timeUnixNano) ?? ""].join("|");
    })
    .sort();

  return `${payload.name}::${parts.join(";")}`;
}
