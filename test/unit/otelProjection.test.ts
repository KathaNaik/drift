import * as assert from "assert";
import { buildTrajectory } from "../../src/trajectory";
import { buildOtelTrace, OtelSpan } from "../../src/otelProjection";
import { NormalizedEvent } from "../../src/normalizedEvent";

function event(overrides: Partial<NormalizedEvent> & Pick<NormalizedEvent, "type">): NormalizedEvent {
  return {
    sessionId: "s1",
    source: "claude",
    timestamp: 0,
    hookEventName: "Unused",
    data: {},
    rawEventId: 0,
    ...overrides,
  };
}

function toolSpans(spans: OtelSpan[]): OtelSpan[] {
  return spans.filter((s) => s.spanId !== "span-root");
}

suite("otelProjection (M6A)", () => {
  test("one session produces one trace with a root span", () => {
    const events = [event({ type: "session_start", timestamp: 100 }), event({ type: "session_end", timestamp: 200 })];
    const trajectory = buildTrajectory("s1", events);

    const trace = buildOtelTrace(trajectory);

    assert.strictEqual(trace.traceId, "s1");
    assert.strictEqual(trace.spans[0].spanId, "span-root");
    assert.strictEqual(trace.spans[0].traceId, "s1");
    assert.strictEqual(trace.spans[0].startTimeUnixMs, 100);
    assert.strictEqual(trace.spans[0].endTimeUnixMs, 200);
  });

  test("a complete tool call becomes a child span with both timestamps and incomplete: false", () => {
    const invocation = event({
      type: "tool_invocation",
      timestamp: 100,
      hookEventName: "PreToolUse",
      data: { toolName: "Read", toolUseId: "tool-1" },
    });
    const result = event({
      type: "tool_result",
      timestamp: 150,
      hookEventName: "PostToolUse",
      data: { toolName: "Read", toolUseId: "tool-1" },
    });
    const trajectory = buildTrajectory("s1", [invocation, result]);

    const trace = buildOtelTrace(trajectory);

    const spans = toolSpans(trace.spans);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "Read");
    assert.strictEqual(spans[0].startTimeUnixMs, 100);
    assert.strictEqual(spans[0].endTimeUnixMs, 150);
    assert.strictEqual(spans[0].attributes.toolUseId, "tool-1");
    assert.strictEqual(spans[0].attributes.incomplete, false);
    assert.strictEqual(spans[0].parentSpanId, "span-root");
  });

  test("an incomplete tool call (invocation only) becomes its own span marked incomplete", () => {
    const invocation = event({
      type: "tool_invocation",
      timestamp: 100,
      data: { toolName: "Bash", toolUseId: "tool-1" },
    });
    const trajectory = buildTrajectory("s1", [invocation]);

    const trace = buildOtelTrace(trajectory);

    const spans = toolSpans(trace.spans);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].name, "Bash");
    assert.strictEqual(spans[0].startTimeUnixMs, 100);
    assert.strictEqual(spans[0].endTimeUnixMs, 100);
    assert.strictEqual(spans[0].attributes.incomplete, true);
  });

  test("an incomplete tool call (orphan result only) becomes its own span marked incomplete", () => {
    const result = event({
      type: "tool_result",
      timestamp: 100,
      data: { toolName: "Bash", toolUseId: "tool-1" },
    });
    const trajectory = buildTrajectory("s1", [result]);

    const trace = buildOtelTrace(trajectory);

    const spans = toolSpans(trace.spans);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].startTimeUnixMs, 100);
    assert.strictEqual(spans[0].endTimeUnixMs, 100);
    assert.strictEqual(spans[0].attributes.incomplete, true);
  });

  test("interleaved tool calls each become their own correctly paired child span", () => {
    const inv1 = event({ type: "tool_invocation", timestamp: 100, data: { toolName: "A", toolUseId: "tool-1" } });
    const inv2 = event({ type: "tool_invocation", timestamp: 110, data: { toolName: "B", toolUseId: "tool-2" } });
    const res1 = event({ type: "tool_result", timestamp: 120, data: { toolName: "A", toolUseId: "tool-1" } });
    const res2 = event({ type: "tool_result", timestamp: 130, data: { toolName: "B", toolUseId: "tool-2" } });
    const trajectory = buildTrajectory("s1", [inv1, inv2, res1, res2]);

    const trace = buildOtelTrace(trajectory);

    const spans = toolSpans(trace.spans);
    assert.strictEqual(spans.length, 2);
    assert.strictEqual(spans[0].name, "A");
    assert.strictEqual(spans[0].startTimeUnixMs, 100);
    assert.strictEqual(spans[0].endTimeUnixMs, 120);
    assert.strictEqual(spans[0].attributes.incomplete, false);
    assert.strictEqual(spans[1].name, "B");
    assert.strictEqual(spans[1].startTimeUnixMs, 110);
    assert.strictEqual(spans[1].endTimeUnixMs, 130);
    assert.strictEqual(spans[1].attributes.incomplete, false);
  });

  test("a tool call separated by an unrelated event still produces exactly one span, not two", () => {
    const invocation = event({ type: "tool_invocation", timestamp: 100, data: { toolUseId: "tool-1" } });
    const between = event({ type: "user_prompt", timestamp: 150, hookEventName: "UserPromptSubmit" });
    const result = event({ type: "tool_result", timestamp: 200, data: { toolUseId: "tool-1" } });
    const trajectory = buildTrajectory("s1", [invocation, between, result]);

    const trace = buildOtelTrace(trajectory);

    assert.strictEqual(toolSpans(trace.spans).length, 1);
    assert.strictEqual(trace.spans[0].events.length, 1);
    assert.strictEqual(trace.spans[0].events[0].name, "UserPromptSubmit");
    assert.strictEqual(trace.spans[0].events[0].timestampUnixMs, 150);
  });

  test("REGRESSION: a PostToolBatch event with two real tool calls produces two child spans", () => {
    const batch = event({
      type: "tool_result",
      timestamp: 100,
      hookEventName: "PostToolBatch",
      data: {
        toolCalls: [
          { toolName: "Read", toolUseId: "tool-1", toolResponse: "ok1" },
          { toolName: "Bash", toolUseId: "tool-2", toolResponse: "ok2" },
        ],
      },
    });
    const trajectory = buildTrajectory("s1", [batch]);

    const trace = buildOtelTrace(trajectory);

    const spans = toolSpans(trace.spans);
    assert.strictEqual(spans.length, 2, "one child span per real tool call in the batch");

    assert.strictEqual(spans[0].name, "Read");
    assert.strictEqual(spans[0].attributes.toolUseId, "tool-1");
    assert.strictEqual(spans[0].attributes.incomplete, false);
    assert.strictEqual(spans[0].startTimeUnixMs, 100);
    assert.strictEqual(spans[0].endTimeUnixMs, 100);
    assert.strictEqual(spans[0].parentSpanId, "span-root");

    assert.strictEqual(spans[1].name, "Bash");
    assert.strictEqual(spans[1].attributes.toolUseId, "tool-2");
    assert.strictEqual(spans[1].attributes.incomplete, false);
    assert.strictEqual(spans[1].parentSpanId, "span-root");

    // Distinct, deterministic span ids -- no collision between batch entries.
    assert.notStrictEqual(spans[0].spanId, spans[1].spanId);

    // The batch event itself remains representable as a root span event.
    assert.strictEqual(trace.spans[0].events.length, 1);
    assert.strictEqual(trace.spans[0].events[0].name, "PostToolBatch");
  });

  test("REGRESSION: a batch tool call without a toolResponse is marked incomplete", () => {
    const batch = event({
      type: "tool_result",
      timestamp: 100,
      hookEventName: "PostToolBatch",
      data: {
        toolCalls: [{ toolName: "Read", toolUseId: "tool-1" }],
      },
    });
    const trajectory = buildTrajectory("s1", [batch]);

    const trace = buildOtelTrace(trajectory);

    const spans = toolSpans(trace.spans);
    assert.strictEqual(spans.length, 1);
    assert.strictEqual(spans[0].attributes.incomplete, true);
  });

  test("unknown/generic events are kept as root span events, not dropped", () => {
    const unknown = event({ type: "generic", timestamp: 100, hookEventName: "SomeFutureHookType", data: { extra: 1 } });
    const trajectory = buildTrajectory("s1", [unknown]);

    const trace = buildOtelTrace(trajectory);

    assert.strictEqual(toolSpans(trace.spans).length, 0);
    assert.strictEqual(trace.spans[0].events.length, 1);
    assert.strictEqual(trace.spans[0].events[0].name, "SomeFutureHookType");
    assert.strictEqual(trace.spans[0].events[0].attributes.normalizedType, "generic");
    assert.strictEqual(trace.spans[0].events[0].attributes.extra, 1);
  });

  test("every tool span links back to the root span as its parent", () => {
    const invocation = event({ type: "tool_invocation", timestamp: 100, data: { toolUseId: "tool-1" } });
    const result = event({ type: "tool_result", timestamp: 150, data: { toolUseId: "tool-1" } });
    const trajectory = buildTrajectory("s1", [invocation, result]);

    const trace = buildOtelTrace(trajectory);

    const rootSpanId = trace.spans[0].spanId;
    for (const span of toolSpans(trace.spans)) {
      assert.strictEqual(span.parentSpanId, rootSpanId);
      assert.strictEqual(span.traceId, trace.traceId);
    }
  });

  test("projection is deterministic for the same trajectory", () => {
    const events = [
      event({ type: "session_start", timestamp: 100 }),
      event({ type: "tool_invocation", timestamp: 200, data: { toolUseId: "tool-1" } }),
      event({ type: "tool_result", timestamp: 210, data: { toolUseId: "tool-1" } }),
      event({ type: "session_end", timestamp: 300 }),
    ];
    const trajectory = buildTrajectory("s1", events);

    const first = buildOtelTrace(trajectory);
    const second = buildOtelTrace(trajectory);

    assert.deepStrictEqual(first, second);
  });

  test("two sessions produce fully isolated traces", () => {
    const events: NormalizedEvent[] = [
      event({ sessionId: "session-A", type: "user_prompt", timestamp: 100 }),
      event({ sessionId: "session-B", type: "user_prompt", timestamp: 100 }),
      event({ sessionId: "session-A", type: "tool_invocation", timestamp: 200, data: { toolUseId: "tool-A" } }),
      event({ sessionId: "session-B", type: "tool_invocation", timestamp: 200, data: { toolUseId: "tool-B" } }),
      event({ sessionId: "session-A", type: "tool_result", timestamp: 210, data: { toolUseId: "tool-A" } }),
    ];

    const trajectoryA = buildTrajectory("session-A", events);
    const trajectoryB = buildTrajectory("session-B", events);
    const traceA = buildOtelTrace(trajectoryA);
    const traceB = buildOtelTrace(trajectoryB);

    assert.strictEqual(traceA.traceId, "session-A");
    assert.strictEqual(toolSpans(traceA.spans).length, 1);
    assert.strictEqual(toolSpans(traceA.spans)[0].attributes.incomplete, false);

    assert.strictEqual(traceB.traceId, "session-B");
    assert.strictEqual(toolSpans(traceB.spans).length, 1);
    assert.strictEqual(toolSpans(traceB.spans)[0].attributes.incomplete, true);

    for (const span of traceA.spans) {
      assert.strictEqual(span.traceId, "session-A");
    }
    for (const span of traceB.spans) {
      assert.strictEqual(span.traceId, "session-B");
    }
  });

  test("does not mutate the trajectory or its events", () => {
    const invocation = event({ type: "tool_invocation", timestamp: 100, data: { toolUseId: "tool-1" } });
    const result = event({ type: "tool_result", timestamp: 150, data: { toolUseId: "tool-1" } });
    const trajectory = buildTrajectory("s1", [invocation, result]);
    const before = JSON.parse(JSON.stringify(trajectory));

    buildOtelTrace(trajectory);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(trajectory)), before);
  });
});
