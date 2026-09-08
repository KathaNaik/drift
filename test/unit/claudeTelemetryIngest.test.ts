import * as assert from "assert";
import {
  extractApiRequestRecords,
  extractModelUsageMetricDataPoints,
  extractModelUsage,
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
