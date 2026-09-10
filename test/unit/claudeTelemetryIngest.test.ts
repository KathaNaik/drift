import * as assert from "assert";
import {
  extractApiRequestRecords,
  extractModelUsageMetricDataPoints,
  extractModelUsage,
  metricOccurrenceFingerprint,
} from "../../src/claudeTelemetryIngest";

// Shapes below follow Claude Code's documented `claude_code.api_request`
// event and `claude_code.token.usage` / `claude_code.cost.usage` metrics,
// and the OTLP/HTTP JSON encoding (64-bit ints as decimal strings).

function apiRequestLogsPayload() {
  return {
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            scope: { name: "com.anthropics.claude_code.events" },
            logRecords: [
              {
                timeUnixNano: "1700000000000000000",
                eventName: "claude_code.api_request",
                attributes: [
                  { key: "model", value: { stringValue: "claude-sonnet-5" } },
                  { key: "request_id", value: { stringValue: "req_011abc" } },
                  { key: "input_tokens", value: { intValue: "1234" } },
                  { key: "output_tokens", value: { intValue: "567" } },
                  { key: "cache_read_tokens", value: { intValue: "100" } },
                  { key: "cache_creation_tokens", value: { intValue: "50" } },
                  { key: "cost_usd", value: { doubleValue: 0.0123 } },
                  { key: "duration_ms", value: { intValue: "845" } },
                  { key: "session.id", value: { stringValue: "session-1" } },
                  { key: "prompt.id", value: { stringValue: "prompt-1" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

suite("claudeTelemetryIngest (M7A)", () => {
  test("extracts a claude_code.api_request log record from a real-shaped OTLP logs payload", () => {
    const payload = apiRequestLogsPayload();
    const records = extractApiRequestRecords(payload);

    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].sessionId, "session-1");
    assert.deepStrictEqual(records[0].raw, payload.resourceLogs[0].scopeLogs[0].logRecords[0]);
  });

  test("recovers all documented usage fields from an extracted api_request record", () => {
    const records = extractApiRequestRecords(apiRequestLogsPayload());
    const usage = extractModelUsage(records[0].raw);

    assert.deepStrictEqual(usage, {
      sessionId: "session-1",
      model: "claude-sonnet-5",
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      requestId: "req_011abc",
      durationMs: 845,
      costUsd: 0.0123,
    });
  });

  test("falls back to client_request_id when request_id is absent", () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "claude_code.api_request",
                  attributes: [
                    { key: "model", value: { stringValue: "claude-sonnet-5" } },
                    { key: "client_request_id", value: { stringValue: "client-uuid-1" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const usage = extractModelUsage(extractApiRequestRecords(payload)[0].raw);
    assert.strictEqual(usage.requestId, "client-uuid-1");
  });

  test("missing optional usage fields do not break extraction", () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "claude_code.api_request",
                  attributes: [{ key: "model", value: { stringValue: "claude-sonnet-5" } }],
                },
              ],
            },
          ],
        },
      ],
    };

    const records = extractApiRequestRecords(payload);
    assert.strictEqual(records.length, 1, "the record must still be extracted despite missing optional fields");

    const usage = extractModelUsage(records[0].raw);
    assert.strictEqual(usage.model, "claude-sonnet-5");
    assert.strictEqual(usage.inputTokens, undefined);
    assert.strictEqual(usage.costUsd, undefined);
    assert.strictEqual(usage.sessionId, undefined);
  });

  test("ignores log records that are not claude_code.api_request events", () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                { eventName: "claude_code.user_prompt", attributes: [] },
                { eventName: "claude_code.api_request", attributes: [{ key: "model", value: { stringValue: "x" } }] },
                { eventName: "claude_code.tool_result", attributes: [] },
              ],
            },
          ],
        },
      ],
    };

    const records = extractApiRequestRecords(payload);
    assert.strictEqual(records.length, 1);
  });

  test("preserves multiple api_request records in document order across a batch", () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: "claude_code.api_request",
                  attributes: [
                    { key: "session.id", value: { stringValue: "session-1" } },
                    { key: "request_id", value: { stringValue: "req-1" } },
                  ],
                },
                {
                  eventName: "claude_code.api_request",
                  attributes: [
                    { key: "session.id", value: { stringValue: "session-1" } },
                    { key: "request_id", value: { stringValue: "req-2" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const records = extractApiRequestRecords(payload);
    assert.strictEqual(records.length, 2);
    assert.strictEqual(extractModelUsage(records[0].raw).requestId, "req-1");
    assert.strictEqual(extractModelUsage(records[1].raw).requestId, "req-2");
  });

  test("recognizes the event.name attribute form as well as the top-level eventName field", () => {
    const payload = {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: "event.name", value: { stringValue: "claude_code.api_request" } },
                    { key: "model", value: { stringValue: "claude-sonnet-5" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const records = extractApiRequestRecords(payload);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(extractModelUsage(records[0].raw).model, "claude-sonnet-5");
  });

  test("handles empty, missing, or malformed OTLP logs bodies without throwing", () => {
    assert.deepStrictEqual(extractApiRequestRecords({}), []);
    assert.deepStrictEqual(extractApiRequestRecords(null), []);
    assert.deepStrictEqual(extractApiRequestRecords(undefined), []);
    assert.deepStrictEqual(extractApiRequestRecords("not an object"), []);
    assert.deepStrictEqual(extractApiRequestRecords({ resourceLogs: "not an array" }), []);
    assert.deepStrictEqual(extractApiRequestRecords({ resourceLogs: [{ scopeLogs: [{ logRecords: ["oops"] }] }] }), []);
  });

  test("extractModelUsage never throws even for a completely malformed record", () => {
    assert.doesNotThrow(() => extractModelUsage(null));
    assert.doesNotThrow(() => extractModelUsage("garbage"));
    assert.doesNotThrow(() => extractModelUsage({ attributes: "not an array" }));
  });

  test("extracts claude_code.token.usage metric data points, correlated by session", () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  unit: "tokens",
                  sum: {
                    dataPoints: [
                      {
                        timeUnixNano: "1700000000000000000",
                        asInt: "1234",
                        attributes: [
                          { key: "type", value: { stringValue: "input" } },
                          { key: "model", value: { stringValue: "claude-sonnet-5" } },
                          { key: "session.id", value: { stringValue: "session-1" } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const records = extractModelUsageMetricDataPoints(payload);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].sessionId, "session-1");
    const raw = records[0].raw as any;
    assert.strictEqual(raw.name, "claude_code.token.usage");
    assert.strictEqual(raw.sum.dataPoints[0].asInt, "1234");
  });

  test("extracts claude_code.cost.usage metric data points from a gauge", () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.cost.usage",
                  unit: "USD",
                  gauge: {
                    dataPoints: [
                      {
                        asDouble: 0.0456,
                        attributes: [
                          { key: "model", value: { stringValue: "claude-sonnet-5" } },
                          { key: "session.id", value: { stringValue: "session-2" } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const records = extractModelUsageMetricDataPoints(payload);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].sessionId, "session-2");
  });

  test("ignores metrics that are not token.usage or cost.usage", () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                { name: "claude_code.session.count", sum: { dataPoints: [{ attributes: [] }] } },
                {
                  name: "claude_code.token.usage",
                  sum: { dataPoints: [{ attributes: [{ key: "session.id", value: { stringValue: "s1" } }] }] },
                },
              ],
            },
          ],
        },
      ],
    };

    const records = extractModelUsageMetricDataPoints(payload);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].sessionId, "s1");
  });

  test("handles empty, missing, or malformed OTLP metrics bodies without throwing", () => {
    assert.deepStrictEqual(extractModelUsageMetricDataPoints({}), []);
    assert.deepStrictEqual(extractModelUsageMetricDataPoints(null), []);
    assert.deepStrictEqual(extractModelUsageMetricDataPoints({ resourceMetrics: "nope" }), []);
  });

  test("a data point with no session.id attribute yields an undefined sessionId rather than throwing", () => {
    const payload = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  sum: { dataPoints: [{ attributes: [{ key: "type", value: { stringValue: "output" } }] }] },
                },
              ],
            },
          ],
        },
      ],
    };

    const records = extractModelUsageMetricDataPoints(payload);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].sessionId, undefined);
  });

  function fullMetricPayload() {
    return {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  description: "Number of tokens used",
                  unit: "tokens",
                  future_field_from_a_newer_otel_sdk: { nested: true },
                  sum: {
                    aggregationTemporality: 2,
                    isMonotonic: true,
                    dataPoints: [
                      {
                        timeUnixNano: "1700000000000000000",
                        asInt: "1234",
                        attributes: [
                          { key: "type", value: { stringValue: "input" } },
                          { key: "session.id", value: { stringValue: "session-A" } },
                        ],
                      },
                      {
                        timeUnixNano: "1700000000100000000",
                        asInt: "567",
                        attributes: [
                          { key: "type", value: { stringValue: "output" } },
                          { key: "session.id", value: { stringValue: "session-B" } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
  }

  test("REGRESSION (M7A.1): preserves the complete original metric object verbatim, including description, aggregationTemporality, isMonotonic, and an unknown future field", () => {
    const payload = fullMetricPayload();
    const records = extractModelUsageMetricDataPoints(payload);
    const originalMetric = payload.resourceMetrics[0].scopeMetrics[0].metrics[0];

    for (const record of records) {
      assert.strictEqual(record.raw, originalMetric, "raw must be the actual original metric object, not a reconstruction");
    }

    const raw = records[0].raw as any;
    assert.strictEqual(raw.description, "Number of tokens used");
    assert.strictEqual(raw.sum.aggregationTemporality, 2);
    assert.strictEqual(raw.sum.isMonotonic, true);
    assert.deepStrictEqual(raw.future_field_from_a_newer_otel_sdk, { nested: true });
  });

  test("REGRESSION (M7A.1): extracted session correlation still comes from each record's own data point, not a sibling's", () => {
    const records = extractModelUsageMetricDataPoints(fullMetricPayload());

    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].sessionId, "session-A");
    assert.strictEqual(records[1].sessionId, "session-B");
  });

  test("REGRESSION (M7A.1): multiple data points remain ordered", () => {
    const records = extractModelUsageMetricDataPoints(fullMetricPayload());

    assert.deepStrictEqual(
      records.map((r) => r.sessionId),
      ["session-A", "session-B"]
    );
  });

  test("REGRESSION (M7A.1): does not mutate the input payload", () => {
    const payload = fullMetricPayload();
    const before = JSON.parse(JSON.stringify(payload));

    extractModelUsageMetricDataPoints(payload);

    assert.deepStrictEqual(payload, before);
  });
});

// Shapes below are transcribed verbatim (field-for-field) from genuine OTLP
// bodies captured live from the real, installed Claude Code CLI (v2.1.259)
// running `claude -p ... --output-format json` -- see M13D-LIVE. A real,
// non-interactive session was confirmed to emit NO claude_code.api_request
// log record at all: only these two metrics, exported once per real API
// call (plus periodic re-exports of the same values on later ticks while
// the process stays alive -- see the fingerprint suite below).
function realCostUsageMetric(sessionId: string, costUsd: number, startTime: string, endTime: string) {
  return {
    name: "claude_code.cost.usage",
    description: "Cost of the Claude Code session",
    unit: "USD",
    sum: {
      aggregationTemporality: 1,
      isMonotonic: true,
      dataPoints: [
        {
          attributes: [
            { key: "user.id", value: { stringValue: "u1" } },
            { key: "session.id", value: { stringValue: sessionId } },
            { key: "organization.id", value: { stringValue: "org1" } },
            { key: "terminal.type", value: { stringValue: "non-interactive" } },
            { key: "model", value: { stringValue: "claude-sonnet-5" } },
          ],
          startTimeUnixNano: startTime,
          timeUnixNano: endTime,
          asDouble: costUsd,
        },
      ],
    },
  };
}

function realTokenUsageMetric(sessionId: string, tokens: { input: number; output: number; cacheRead: number; cacheCreation: number }, startTime: string, endTime: string) {
  const typeMap: [string, number][] = [
    ["input", tokens.input],
    ["output", tokens.output],
    ["cacheRead", tokens.cacheRead],
    ["cacheCreation", tokens.cacheCreation],
  ];
  return {
    name: "claude_code.token.usage",
    description: "Number of tokens used",
    unit: "tokens",
    sum: {
      aggregationTemporality: 1,
      isMonotonic: true,
      dataPoints: typeMap.map(([type, value]) => ({
        attributes: [
          { key: "user.id", value: { stringValue: "u1" } },
          { key: "session.id", value: { stringValue: sessionId } },
          { key: "model", value: { stringValue: "claude-sonnet-5" } },
          { key: "type", value: { stringValue: type } },
        ],
        startTimeUnixNano: startTime,
        timeUnixNano: endTime,
        asDouble: value,
      })),
    },
  };
}

suite("claudeTelemetryIngest real CLI metric shapes (M13D)", () => {
  test("extractModelUsage recovers costUsd from a genuine claude_code.cost.usage metric, and nothing else is fabricated", () => {
    const metric = realCostUsageMetric("session-1", 0.0505506, "1789009620902000000", "1789009620992000000");
    const usage = extractModelUsage(metric);

    assert.strictEqual(usage.sessionId, "session-1");
    assert.strictEqual(usage.model, "claude-sonnet-5");
    assert.strictEqual(usage.costUsd, 0.0505506);
    assert.strictEqual(usage.inputTokens, undefined);
    assert.strictEqual(usage.outputTokens, undefined);
    assert.strictEqual(usage.cacheReadTokens, undefined);
    assert.strictEqual(usage.cacheCreationTokens, undefined);
    assert.strictEqual(usage.requestId, undefined, "a metric never carries a request id -- never guessed");
    assert.strictEqual(usage.durationMs, undefined, "a metric never carries a per-call duration -- never reconstructed from an unrelated CLI-wide activity metric");
  });

  test("extractModelUsage recovers all four token fields from a genuine claude_code.token.usage metric's typed data points", () => {
    const metric = realTokenUsageMetric("session-1", { input: 2, output: 126, cacheRead: 29433, cacheCreation: 10850 }, "1789009620902000000", "1789009620992000000");
    const usage = extractModelUsage(metric);

    assert.strictEqual(usage.inputTokens, 2);
    assert.strictEqual(usage.outputTokens, 126);
    assert.strictEqual(usage.cacheReadTokens, 29433);
    assert.strictEqual(usage.cacheCreationTokens, 10850);
    assert.strictEqual(usage.costUsd, undefined, "token.usage never carries cost -- that lives only on the sibling cost.usage metric");
    assert.strictEqual(usage.sessionId, "session-1");
  });

  test("extractModelUsage never throws for a metric-shaped payload with no data points", () => {
    assert.doesNotThrow(() => extractModelUsage({ name: "claude_code.cost.usage", sum: { dataPoints: [] } }));
    const usage = extractModelUsage({ name: "claude_code.cost.usage", sum: { dataPoints: [] } });
    assert.strictEqual(usage.costUsd, undefined);
  });

  test("extractModelUsage ignores a metric name it doesn't recognize, without throwing or fabricating", () => {
    const usage = extractModelUsage({ name: "claude_code.active_time.total", sum: { dataPoints: [{ attributes: [{ key: "session.id", value: { stringValue: "s1" } }], asDouble: 3.4 }] } });
    assert.strictEqual(usage.costUsd, undefined);
    assert.strictEqual(usage.inputTokens, undefined);
    assert.strictEqual(usage.sessionId, "s1", "session id is still recoverable even from a metric this module doesn't otherwise act on");
  });

  suite("metricOccurrenceFingerprint", () => {
    test("returns undefined for a claude_code.api_request log record -- each one is already its own distinct request, nothing to deduplicate", () => {
      const records = extractApiRequestRecords({
        resourceLogs: [{ scopeLogs: [{ logRecords: [{ eventName: "claude_code.api_request", attributes: [{ key: "session.id", value: { stringValue: "s1" } }] }] }] }],
      });
      assert.strictEqual(metricOccurrenceFingerprint(records[0].raw), undefined);
    });

    test("two metric objects with the identical session/type/start/end window produce the same fingerprint -- the real CLI's own re-exported delta", () => {
      const a = realCostUsageMetric("session-1", 0.05, "1000", "2000");
      const b = realCostUsageMetric("session-1", 0.05, "1000", "2000");
      assert.strictEqual(metricOccurrenceFingerprint(a), metricOccurrenceFingerprint(b));
    });

    test("two metric objects with different time windows produce different fingerprints -- a genuinely later, distinct call", () => {
      const a = realCostUsageMetric("session-1", 0.05, "1000", "2000");
      const b = realCostUsageMetric("session-1", 0.09, "3000", "4000");
      assert.notStrictEqual(metricOccurrenceFingerprint(a), metricOccurrenceFingerprint(b));
    });

    test("cost.usage and token.usage for the very same underlying call produce different fingerprints -- they are two separate metrics, deduplicated independently", () => {
      const cost = realCostUsageMetric("session-1", 0.05, "1000", "2000");
      const tokens = realTokenUsageMetric("session-1", { input: 2, output: 14, cacheRead: 1, cacheCreation: 1 }, "1000", "2000");
      assert.notStrictEqual(metricOccurrenceFingerprint(cost), metricOccurrenceFingerprint(tokens));
    });

    test("a different session's identical-looking metric produces a different fingerprint -- session identity is part of the occurrence's own identity", () => {
      const a = realCostUsageMetric("session-1", 0.05, "1000", "2000");
      const b = realCostUsageMetric("session-2", 0.05, "1000", "2000");
      assert.notStrictEqual(metricOccurrenceFingerprint(a), metricOccurrenceFingerprint(b));
    });

    test("returns undefined for a metric with no data points", () => {
      assert.strictEqual(metricOccurrenceFingerprint({ name: "claude_code.cost.usage", sum: { dataPoints: [] } }), undefined);
    });
  });
});
