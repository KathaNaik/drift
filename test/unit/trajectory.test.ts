import * as assert from "assert";
import { buildTrajectory } from "../../src/trajectory";
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

suite("trajectory (M5B)", () => {
  test("reconstructs a normal session lifecycle in order, with no tool calls", () => {
    const events: NormalizedEvent[] = [
      event({ type: "session_start", timestamp: 100, hookEventName: "SessionStart" }),
      event({ type: "user_prompt", timestamp: 200, hookEventName: "UserPromptSubmit" }),
      event({ type: "session_end", timestamp: 300, hookEventName: "SessionEnd" }),
    ];

    const trajectory = buildTrajectory("s1", events);

    assert.strictEqual(trajectory.sessionId, "s1");
    assert.strictEqual(trajectory.steps.length, 3);
    assert.deepStrictEqual(
      trajectory.steps.map((s) => s.event.hookEventName),
      ["SessionStart", "UserPromptSubmit", "SessionEnd"]
    );
    assert.ok(trajectory.steps.every((s) => s.toolUseId === undefined && s.linkedStepIndex === undefined));
  });

  test("links a tool invocation with its result without moving or merging either event", () => {
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

    assert.strictEqual(trajectory.steps.length, 2, "both events must remain as separate steps");
    assert.strictEqual(trajectory.steps[0].event, invocation);
    assert.strictEqual(trajectory.steps[1].event, result);
    assert.strictEqual(trajectory.steps[0].toolUseId, "tool-1");
    assert.strictEqual(trajectory.steps[1].toolUseId, "tool-1");
    assert.strictEqual(trajectory.steps[0].linkedStepIndex, 1);
    assert.strictEqual(trajectory.steps[1].linkedStepIndex, 0);
  });

  test("REGRESSION: an event between an invocation and its result keeps exact 1:1 order while still linking the pair", () => {
    const invocation = event({
      type: "tool_invocation",
      timestamp: 100,
      hookEventName: "PreToolUse",
      data: { toolUseId: "tool-1" },
    });
    const between = event({ type: "user_prompt", timestamp: 150, hookEventName: "UserPromptSubmit" });
    const result = event({
      type: "tool_result",
      timestamp: 200,
      hookEventName: "PostToolUse",
      data: { toolUseId: "tool-1" },
    });

    const trajectory = buildTrajectory("s1", [invocation, between, result]);

    // Order must be exactly the input order, 1:1 — nothing collapsed or moved.
    assert.strictEqual(trajectory.steps.length, 3);
    assert.deepStrictEqual(
      trajectory.steps.map((s) => s.event.hookEventName),
      ["PreToolUse", "UserPromptSubmit", "PostToolUse"]
    );
    assert.strictEqual(trajectory.steps[0].event, invocation);
    assert.strictEqual(trajectory.steps[1].event, between);
    assert.strictEqual(trajectory.steps[2].event, result);

    // The interleaved event carries no tool linkage of its own.
    assert.strictEqual(trajectory.steps[1].toolUseId, undefined);
    assert.strictEqual(trajectory.steps[1].linkedStepIndex, undefined);

    // The invocation and result are still linked to each other by index,
    // despite not being adjacent.
    assert.strictEqual(trajectory.steps[0].toolUseId, "tool-1");
    assert.strictEqual(trajectory.steps[2].toolUseId, "tool-1");
    assert.strictEqual(trajectory.steps[0].linkedStepIndex, 2);
    assert.strictEqual(trajectory.steps[2].linkedStepIndex, 0);
  });

  test("links multiple independent tool calls, even when interleaved", () => {
    const inv1 = event({ type: "tool_invocation", timestamp: 100, data: { toolUseId: "tool-1" } });
    const inv2 = event({ type: "tool_invocation", timestamp: 110, data: { toolUseId: "tool-2" } });
    const res1 = event({ type: "tool_result", timestamp: 120, data: { toolUseId: "tool-1" } });
    const res2 = event({ type: "tool_result", timestamp: 130, data: { toolUseId: "tool-2" } });

    const trajectory = buildTrajectory("s1", [inv1, inv2, res1, res2]);

    assert.strictEqual(trajectory.steps.length, 4);
    assert.deepStrictEqual(
      trajectory.steps.map((s) => s.event),
      [inv1, inv2, res1, res2]
    );
    assert.strictEqual(trajectory.steps[0].linkedStepIndex, 2); // inv1 <-> res1
    assert.strictEqual(trajectory.steps[2].linkedStepIndex, 0);
    assert.strictEqual(trajectory.steps[1].linkedStepIndex, 3); // inv2 <-> res2
    assert.strictEqual(trajectory.steps[3].linkedStepIndex, 1);
  });

  test("keeps an unmatched tool invocation visible and unlinked", () => {
    const invocation = event({ type: "tool_invocation", timestamp: 100, data: { toolUseId: "tool-1" } });

    const trajectory = buildTrajectory("s1", [invocation]);

    assert.strictEqual(trajectory.steps.length, 1);
    assert.strictEqual(trajectory.steps[0].event, invocation);
    assert.strictEqual(trajectory.steps[0].toolUseId, "tool-1");
    assert.strictEqual(trajectory.steps[0].linkedStepIndex, undefined);
  });

  test("keeps an orphan tool result (no prior invocation) visible and unlinked", () => {
    const result = event({ type: "tool_result", timestamp: 100, data: { toolUseId: "tool-1" } });

    const trajectory = buildTrajectory("s1", [result]);

    assert.strictEqual(trajectory.steps.length, 1);
    assert.strictEqual(trajectory.steps[0].event, result);
    assert.strictEqual(trajectory.steps[0].toolUseId, "tool-1");
    assert.strictEqual(trajectory.steps[0].linkedStepIndex, undefined);
  });

  test("keeps a generic/unknown normalized event visible as its own step", () => {
    const unknown = event({ type: "generic", timestamp: 100, hookEventName: "SomeFutureHookType" });

    const trajectory = buildTrajectory("s1", [unknown]);

    assert.strictEqual(trajectory.steps.length, 1);
    assert.strictEqual(trajectory.steps[0].event, unknown);
    assert.strictEqual(trajectory.steps[0].toolUseId, undefined);
  });

  test("does not mutate the normalized events it reads", () => {
    const invocation = event({ type: "tool_invocation", timestamp: 100, data: { toolUseId: "tool-1" } });
    const result = event({ type: "tool_result", timestamp: 150, data: { toolUseId: "tool-1" } });
    const before = JSON.parse(JSON.stringify([invocation, result]));

    buildTrajectory("s1", [invocation, result]);

    assert.deepStrictEqual(JSON.parse(JSON.stringify([invocation, result])), before);
  });

  test("reconstruction is deterministic for the same input", () => {
    const events: NormalizedEvent[] = [
      event({ type: "session_start", timestamp: 100 }),
      event({ type: "tool_invocation", timestamp: 200, data: { toolUseId: "tool-1" } }),
      event({ type: "tool_result", timestamp: 210, data: { toolUseId: "tool-1" } }),
      event({ type: "session_end", timestamp: 300 }),
    ];

    const first = buildTrajectory("s1", events);
    const second = buildTrajectory("s1", events);

    assert.deepStrictEqual(first, second);
  });

  test("two sessions remain fully isolated, even from a single mixed event array", () => {
    const events: NormalizedEvent[] = [
      event({ sessionId: "session-A", type: "user_prompt", timestamp: 100 }),
      event({ sessionId: "session-B", type: "user_prompt", timestamp: 100 }),
      event({ sessionId: "session-A", type: "tool_invocation", timestamp: 200, data: { toolUseId: "tool-A" } }),
      event({ sessionId: "session-B", type: "tool_invocation", timestamp: 200, data: { toolUseId: "tool-B" } }),
      event({ sessionId: "session-A", type: "tool_result", timestamp: 210, data: { toolUseId: "tool-A" } }),
      event({ sessionId: "session-B", type: "session_end", timestamp: 300 }),
    ];

    const trajectoryA = buildTrajectory("session-A", events);
    const trajectoryB = buildTrajectory("session-B", events);

    assert.strictEqual(trajectoryA.sessionId, "session-A");
    assert.strictEqual(trajectoryA.steps.length, 3, "session-A has a prompt, an invocation, and its result");
    assert.strictEqual(trajectoryA.steps[0].toolUseId, undefined);
    assert.strictEqual(trajectoryA.steps[1].toolUseId, "tool-A");
    assert.strictEqual(trajectoryA.steps[2].toolUseId, "tool-A");
    assert.strictEqual(trajectoryA.steps[1].linkedStepIndex, 2);
    assert.strictEqual(trajectoryA.steps[2].linkedStepIndex, 1);

    assert.strictEqual(trajectoryB.sessionId, "session-B");
    assert.strictEqual(trajectoryB.steps.length, 3, "session-B has a prompt, an invocation, and a session end");
    assert.strictEqual(trajectoryB.steps[1].toolUseId, "tool-B");
    assert.strictEqual(trajectoryB.steps[1].linkedStepIndex, undefined, "session-B's tool call has no result in this event list");

    // No event from one session appears in the other's trajectory.
    assert.ok(trajectoryA.steps.every((s) => s.event.sessionId === "session-A"));
    assert.ok(trajectoryB.steps.every((s) => s.event.sessionId === "session-B"));
  });
});
