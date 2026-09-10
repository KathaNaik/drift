import * as assert from "assert";
import { UsageSummary } from "../../src/trajectoryUsageAttribution";
import { DriftOverhead, InterventionRecord } from "../../src/interventionMeasurement";
import { comparePairedRun, ControlRun, TreatmentRun, TaskResult, PairedComparisonInput } from "../../src/pairedComparison";

function usage(fields: Partial<UsageSummary>): UsageSummary {
  return {
    modelCalls: 0,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    costUsd: undefined,
    durationMs: undefined,
    records: [],
    ...fields,
  };
}

function overhead(fields: Partial<DriftOverhead>): DriftOverhead {
  return {
    localInferenceCount: 0,
    localInferenceDurationMs: undefined,
    localInferenceInputTokens: undefined,
    localInferenceOutputTokens: undefined,
    redirectPacketSizeBytes: 0,
    analysisDurationMs: undefined,
    ...fields,
  };
}

function intervention(sessionId: string, fields: Partial<InterventionRecord> = {}): InterventionRecord {
  return {
    sessionId,
    sourceStepIndexes: [0],
    approvedAt: 10,
    deliveredAt: 20,
    preRedirectUsage: usage({}),
    postRedirectUsage: usage({}),
    driftOverhead: overhead({}),
    outcome: { finalToolCall: undefined, sessionEndReason: undefined },
    ...fields,
  };
}

function taskResult(fields: Partial<TaskResult>): TaskResult {
  return { passed: true, evaluator: "unit-test-evaluator", ...fields };
}

function control(fields: Partial<ControlRun> = {}): ControlRun {
  return { sessionId: "control-session", usage: usage({}), taskResult: taskResult({}), ...fields };
}

function treatment(fields: Partial<TreatmentRun> = {}): TreatmentRun {
  const sessionId = fields.sessionId ?? "treatment-session";
  return {
    sessionId,
    usage: usage({}),
    driftOverhead: overhead({}),
    intervention: intervention(sessionId),
    taskResult: taskResult({}),
    ...fields,
  };
}

function pair(fields: Partial<PairedComparisonInput> = {}): PairedComparisonInput {
  return { taskId: "task-1", control: control(), treatment: treatment(), ...fields };
}

suite("pairedComparison (M13B)", () => {
  test("passing control + passing treatment reports taskSuccessPreserved=true", () => {
    const result = comparePairedRun(
      pair({
        control: control({ taskResult: taskResult({ passed: true }) }),
        treatment: treatment({ taskResult: taskResult({ passed: true }) }),
      })
    );
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.comparison!.taskSuccessPreserved, true);
  });

  test("passing control + failing treatment reports taskSuccessPreserved=false, and still reports the raw usage difference", () => {
    const result = comparePairedRun(
      pair({
        control: control({ taskResult: taskResult({ passed: true }), usage: usage({ modelCalls: 10, inputTokens: 1000 }) }),
        treatment: treatment({ taskResult: taskResult({ passed: false }), usage: usage({ modelCalls: 4, inputTokens: 300 }) }),
      })
    );
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.comparison!.taskSuccessPreserved, false);
    // Reduced usage is still reported as a plain number -- this module has
    // no "improved"/"regressed" label field at all, so there is nothing to
    // mislabel; the raw difference must still be present.
    assert.strictEqual(result.comparison!.grossDifference.modelCalls.difference, 6);
    assert.strictEqual(result.comparison!.grossDifference.inputTokens.difference, 700);
  });

  test("failing control is marked unsuitable for preservation comparison (undefined, not false)", () => {
    const result = comparePairedRun(
      pair({
        control: control({ taskResult: taskResult({ passed: false }) }),
        treatment: treatment({ taskResult: taskResult({ passed: true }) }),
      })
    );
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.comparison!.taskSuccessPreserved, undefined);
  });

  test("failing control + failing treatment is also unsuitable (undefined), never false", () => {
    const result = comparePairedRun(
      pair({
        control: control({ taskResult: taskResult({ passed: false }) }),
        treatment: treatment({ taskResult: taskResult({ passed: false }) }),
      })
    );
    assert.strictEqual(result.comparison!.taskSuccessPreserved, undefined);
  });

  test("gross usage differences are mathematically correct for every measured field, with explicit direction (positive = treatment used less)", () => {
    const controlUsage = usage({ modelCalls: 10, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 50, costUsd: 0.5, durationMs: 3000 });
    const treatmentUsage = usage({ modelCalls: 4, inputTokens: 300, outputTokens: 150, cacheReadTokens: 250, cacheWriteTokens: 10, costUsd: 0.7, durationMs: 5000 });
    const result = comparePairedRun(pair({ control: control({ usage: controlUsage }), treatment: treatment({ usage: treatmentUsage }) }));
    const g = result.comparison!.grossDifference;

    assert.strictEqual(g.modelCalls.difference, 6, "treatment used 6 fewer calls");
    assert.strictEqual(g.inputTokens.difference, 700);
    assert.strictEqual(g.outputTokens.difference, 350);
    assert.strictEqual(g.cacheReadTokens.difference, -50, "treatment used MORE cache-read tokens -- must be negative");
    assert.strictEqual(g.cacheWriteTokens.difference, 40);
    assert.ok(Math.abs(g.costUsd.difference! - -0.2) < 1e-9, "treatment cost MORE -- negative difference");
    assert.strictEqual(g.durationMs.difference, -2000, "treatment took longer -- negative difference");

    // Percentage direction sanity: positive % for a reduction, negative % for an increase.
    assert.ok(Math.abs(g.inputTokens.percentageDifference! - 0.7) < 1e-9);
    assert.ok(g.durationMs.percentageDifference! < 0);
  });

  test("Drift overhead remains separate and is never folded into grossDifference/controlUsage/treatmentUsage", () => {
    const treatmentUsage = usage({ modelCalls: 4, inputTokens: 300 });
    const driftOverhead = overhead({ localInferenceCount: 3, localInferenceDurationMs: 900, localInferenceInputTokens: 4000, localInferenceOutputTokens: 800, redirectPacketSizeBytes: 512, analysisDurationMs: 950 });
    const result = comparePairedRun(pair({ treatment: treatment({ usage: treatmentUsage, driftOverhead }) }));
    assert.deepStrictEqual(result.comparison!.driftOverhead, driftOverhead);
    assert.strictEqual(result.comparison!.treatmentUsage.inputTokens, 300, "treatmentUsage must be Claude-only, unaffected by driftOverhead's own 4000 local tokens");
    assert.strictEqual(result.comparison!.grossDifference.inputTokens.control, result.comparison!.controlUsage.inputTokens);
  });

  test("incomparable model-token units are never combined -- no field anywhere subtracts/adds local tokens against Claude tokens", () => {
    const result = comparePairedRun(
      pair({
        treatment: treatment({
          usage: usage({ inputTokens: 100 }),
          driftOverhead: overhead({ localInferenceInputTokens: 999999, localInferenceOutputTokens: 999999 }),
        }),
      })
    );
    const g = result.comparison!.grossDifference;
    // grossDifference.inputTokens must reflect ONLY Claude-side usage (control undefined vs treatment 100), never perturbed by the 999999 local tokens.
    assert.strictEqual(g.inputTokens.difference, undefined, "control side is undefined, so difference must stay undefined regardless of Drift's own huge local token counts");
    assert.strictEqual(g.inputTokens.treatment, 100);
    assert.strictEqual(JSON.stringify(result.comparison!.netDifference).includes("999999"), false, "local tokens must never leak into netDifference");
  });

  test("M13B.1: netDifference.durationMs is always undefined -- Claude usage.durationMs and Drift analysisDurationMs share a unit (ms) but not a measurement definition, so they are never summed", () => {
    const result = comparePairedRun(
      pair({
        control: control({ usage: usage({ durationMs: 10000 }) }),
        treatment: treatment({ usage: usage({ durationMs: 6000 }), driftOverhead: overhead({ analysisDurationMs: 1500 }) }),
      })
    );
    assert.strictEqual(result.comparison!.netDifference.durationMs, undefined, "must not compute control(10000) - (treatment(6000) + overhead(1500))");
  });

  test("M13B.1: netDifference.durationMs stays undefined even when analysisDurationMs is absent -- same outcome either way, never fabricated", () => {
    const result = comparePairedRun(
      pair({
        control: control({ usage: usage({ durationMs: 10000 }) }),
        treatment: treatment({ usage: usage({ durationMs: 6000 }), driftOverhead: overhead({ analysisDurationMs: undefined }) }),
      })
    );
    assert.strictEqual(result.comparison!.netDifference.durationMs, undefined);
  });

  test("M13B.1: gross Claude duration difference remains available and is computed independently of netDifference", () => {
    const result = comparePairedRun(
      pair({
        control: control({ usage: usage({ durationMs: 10000 }) }),
        treatment: treatment({ usage: usage({ durationMs: 6000 }), driftOverhead: overhead({ analysisDurationMs: 1500 }) }),
      })
    );
    assert.strictEqual(result.comparison!.grossDifference.durationMs.difference, 4000, "control.usage.durationMs - treatment.usage.durationMs, unaffected by analysisDurationMs");
    assert.strictEqual(result.comparison!.netDifference.durationMs, undefined);
  });

  test("net cost is always undefined -- Drift has no measured monetary cost field, so it is never silently treated as free", () => {
    const result = comparePairedRun(
      pair({
        control: control({ usage: usage({ costUsd: 1.0 }) }),
        treatment: treatment({ usage: usage({ costUsd: 0.4 }) }),
      })
    );
    assert.strictEqual(result.comparison!.netDifference.costUsd, undefined);
  });

  test("missing telemetry on either side leaves that field's comparison undefined, never coerced to zero", () => {
    const result = comparePairedRun(
      pair({
        control: control({ usage: usage({ inputTokens: 500, costUsd: undefined }) }),
        treatment: treatment({ usage: usage({ inputTokens: undefined, costUsd: 0.1 }) }),
      })
    );
    const g = result.comparison!.grossDifference;
    assert.strictEqual(g.inputTokens.difference, undefined, "treatment side missing -- must not be treated as 0");
    assert.strictEqual(g.inputTokens.percentageDifference, undefined);
    assert.strictEqual(g.costUsd.difference, undefined, "control side missing -- must not be treated as 0");
  });

  test("modelCalls is always a real number on both sides, so its difference is always computed (never undefined merely because other fields are missing)", () => {
    const result = comparePairedRun(
      pair({
        control: control({ usage: usage({ modelCalls: 7 }) }),
        treatment: treatment({ usage: usage({ modelCalls: 2 }) }),
      })
    );
    assert.strictEqual(result.comparison!.grossDifference.modelCalls.difference, 5);
  });

  test("zero control value never produces a fabricated percentage", () => {
    const result = comparePairedRun(
      pair({
        control: control({ usage: usage({ modelCalls: 0, inputTokens: 0 }) }),
        treatment: treatment({ usage: usage({ modelCalls: 0, inputTokens: 5 }) }),
      })
    );
    const g = result.comparison!.grossDifference;
    assert.strictEqual(g.modelCalls.percentageDifference, undefined);
    assert.strictEqual(g.inputTokens.percentageDifference, undefined);
    // The raw difference is still meaningful and must still be reported.
    assert.strictEqual(g.inputTokens.difference, -5);
  });

  test("undefined control value never produces a fabricated percentage", () => {
    const result = comparePairedRun(
      pair({
        control: control({ usage: usage({ costUsd: undefined }) }),
        treatment: treatment({ usage: usage({ costUsd: 0.2 }) }),
      })
    );
    assert.strictEqual(result.comparison!.grossDifference.costUsd.percentageDifference, undefined);
  });

  test("rejects when the same session is used as both control and treatment", () => {
    const result = comparePairedRun(pair({ control: control({ sessionId: "same" }), treatment: treatment({ sessionId: "same" }) }));
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.comparison, undefined);
    assert.ok(result.error?.includes("different sessions"));
  });

  test("rejects when control.taskResult.taskId does not match the requested taskId", () => {
    const result = comparePairedRun(pair({ taskId: "task-A", control: control({ taskResult: taskResult({ taskId: "task-B" }) }) }));
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("taskId"));
  });

  test("rejects when treatment.taskResult.taskId does not match the requested taskId", () => {
    const result = comparePairedRun(pair({ taskId: "task-A", treatment: treatment({ taskResult: taskResult({ taskId: "task-Z" }) }) }));
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("taskId"));
  });

  test("accepts when taskId is present and matches on both sides", () => {
    const result = comparePairedRun(
      pair({
        taskId: "task-A",
        control: control({ taskResult: taskResult({ taskId: "task-A" }) }),
        treatment: treatment({ taskResult: taskResult({ taskId: "task-A" }) }),
      })
    );
    assert.strictEqual(result.success, true, result.error);
  });

  test("rejects when the treatment's intervention record belongs to a different session than the treatment run", () => {
    const result = comparePairedRun(pair({ treatment: treatment({ sessionId: "treatment-real", intervention: intervention("some-other-session") }) }));
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("intervention"));
  });

  test("rejects a malformed evaluator result: passed is not a boolean", () => {
    const result = comparePairedRun(pair({ control: control({ taskResult: { ...taskResult({}), passed: "yes" as unknown as boolean } }) }));
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("passed"));
  });

  test("rejects a malformed evaluator result: empty evaluator string", () => {
    const result = comparePairedRun(pair({ treatment: treatment({ taskResult: taskResult({ evaluator: "" }) }) }));
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("evaluator"));
  });

  test("rejects a malformed evaluator result: checksPassed greater than checksTotal", () => {
    const result = comparePairedRun(pair({ control: control({ taskResult: taskResult({ checksPassed: 5, checksTotal: 3 }) }) }));
    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes("checksPassed"));
  });

  test("accepts a well-formed evaluator result with checksPassed/checksTotal", () => {
    const result = comparePairedRun(pair({ control: control({ taskResult: taskResult({ checksPassed: 3, checksTotal: 3 }) }) }));
    assert.strictEqual(result.success, true, result.error);
  });

  test("deterministic output for the same input", () => {
    const input = pair({
      control: control({ usage: usage({ modelCalls: 8, inputTokens: 900, durationMs: 4000 }) }),
      treatment: treatment({ usage: usage({ modelCalls: 3, inputTokens: 200, durationMs: 2500 }), driftOverhead: overhead({ analysisDurationMs: 300 }) }),
    });
    const first = comparePairedRun(input);
    const second = comparePairedRun(input);
    assert.deepStrictEqual(first, second);
  });

  test("does not mutate its inputs", () => {
    const input = pair({
      control: control({ usage: usage({ modelCalls: 8, inputTokens: 900 }) }),
      treatment: treatment({ usage: usage({ modelCalls: 3, inputTokens: 200 }) }),
    });
    const snapshot = JSON.stringify(input);
    comparePairedRun(input);
    assert.strictEqual(JSON.stringify(input), snapshot);
  });

  test("no aggregate/energy/sustainability fields exist anywhere on the output shape", () => {
    const result = comparePairedRun(pair());
    const json = JSON.stringify(result);
    for (const forbidden of ["energy", "emission", "sustain", "avoidedWaste", "savedTokens", "carbon"]) {
      assert.ok(!json.toLowerCase().includes(forbidden.toLowerCase()), `forbidden term found: ${forbidden}`);
    }
  });
});
