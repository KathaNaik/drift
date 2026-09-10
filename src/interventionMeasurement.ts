/**
 * A pure measurement layer for a completed Drift redirect intervention --
 * approved via M12A, delivered via M12B/M12B.1. This module makes no claim
 * about whether the redirect helped: it does not estimate energy, does not
 * calculate "saved" or "avoided" compute, and does not compare against an
 * imagined baseline (see sessionReport.ts's own terminology rule, which
 * applies here identically). It only assembles an evidence record from data
 * that already exists -- M7C usage attribution, the approved RedirectPacket,
 * and whatever local-inference/analysis timing the caller observed while
 * producing that packet -- so a later milestone can judge outcomes without
 * this one having fabricated anything.
 *
 * Never calls the local model, never writes to storage, and never mutates
 * any input it's given.
 */

import { AttributedUsageRecord, TrajectoryUsage, UsageSummary, summarize } from "./trajectoryUsageAttribution";
import { RedirectPacket, formatInjectedRedirectContext } from "./redirectPacket";
import { SessionOutcome, buildOutcome } from "./sessionReport";

function sumDefined(values: (number | undefined)[]): number | undefined {
  const defined = values.filter((v): v is number => typeof v === "number");
  return defined.length === 0 ? undefined : defined.reduce((a, b) => a + b, 0);
}

/** One local-model inference call's own cost, as already reported by its InferenceRecord -- never re-derived here. */
export interface LocalInferenceUsage {
  durationMs: number | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

/** The cost of Drift's own detection-and-delivery work, kept entirely separate from the target session's usage above. */
export interface DriftOverhead {
  localInferenceCount: number;
  localInferenceDurationMs: number | undefined;
  localInferenceInputTokens: number | undefined;
  localInferenceOutputTokens: number | undefined;
  redirectPacketSizeBytes: number;
  /**
   * Wall-clock duration of the whole analysis run that produced this
   * intervention (see sessionAnalysisPipeline.ts's analyzeSession), as
   * tracked by whatever caller supplied it -- a superset of, not a sibling
   * to, localInferenceDurationMs: analyzeSession's own elapsed time already
   * contains the local inference calls it makes (M9B/M10B classification
   * runs synchronously inside it, with no other significant work), so this
   * field and localInferenceDurationMs describe overlapping time, not
   * additional time. Never sum them (see pairedComparison.ts's
   * NetDifference.durationMs, which for a different reason also never sums
   * a Claude duration with this field).
   */
  analysisDurationMs: number | undefined;
}

export interface InterventionRecord {
  sessionId: string;
  /** Exactly the approved packet's own sourceStepIndexes -- never recomputed. */
  sourceStepIndexes: number[];
  approvedAt: number;
  deliveredAt: number;
  /** The session's own usage strictly before deliveredAt. */
  preRedirectUsage: UsageSummary;
  /** The session's own usage at or after deliveredAt -- includes the very call the redirect could have influenced. */
  postRedirectUsage: UsageSummary;
  driftOverhead: DriftOverhead;
  outcome: SessionOutcome;
}

export interface InterventionMeasurementInput {
  sessionId: string;
  /** The packet that was actually approved and delivered for this session (see redirectLifecycle.ts). */
  packet: RedirectPacket;
  approvedAt: number;
  deliveredAt: number;
  trajectoryUsage: TrajectoryUsage;
  /** modelUsageEventId -> its own DriftModelUsageEvent.timestamp, e.g. from storage.getModelUsageEvents(sessionId). Used only to place each usage record before or after deliveredAt -- never to recompute the usage itself. */
  usageEventTimestamps: Map<number, number>;
  /** Every local-model inference call made while detecting/preparing this specific redirect -- e.g. one entry per SessionAnalysisWindow classification in the analysis run that produced `packet`. */
  localInferenceCalls: LocalInferenceUsage[];
  /** Wall-clock duration of that analysis run, when the caller tracked it. */
  analysisDurationMs: number | undefined;
}

export interface InterventionMeasurementResult {
  success: boolean;
  record: InterventionRecord | undefined;
  error: string | undefined;
}

/**
 * Splits `records` into strictly-before and at-or-after `deliveredAt`, using
 * each record's own underlying model-usage-event timestamp. A record whose
 * timestamp can't be found (should not happen in practice, since both
 * `records` and `usageEventTimestamps` are derived from the same session's
 * storage) is conservatively placed in "post" -- it can never be mistaken
 * for usage that predates, and therefore could have influenced, the
 * redirect being delivered. Every record lands in exactly one bucket, so
 * summarize(pre) and summarize(post) always reconcile with summarize(all).
 */
function splitUsageByDeliveryBoundary(
  records: AttributedUsageRecord[],
  usageEventTimestamps: Map<number, number>,
  deliveredAt: number
): { pre: UsageSummary; post: UsageSummary } {
  const preRecords: AttributedUsageRecord[] = [];
  const postRecords: AttributedUsageRecord[] = [];

  for (const record of records) {
    const timestamp = usageEventTimestamps.get(record.modelUsageEventId);
    if (timestamp !== undefined && timestamp < deliveredAt) {
      preRecords.push(record);
    } else {
      postRecords.push(record);
    }
  }

  return { pre: summarize(preRecords), post: summarize(postRecords) };
}

function buildDriftOverhead(localInferenceCalls: LocalInferenceUsage[], redirectPacketSizeBytes: number, analysisDurationMs: number | undefined): DriftOverhead {
  return {
    localInferenceCount: localInferenceCalls.length,
    localInferenceDurationMs: sumDefined(localInferenceCalls.map((c) => c.durationMs)),
    localInferenceInputTokens: sumDefined(localInferenceCalls.map((c) => c.inputTokens)),
    localInferenceOutputTokens: sumDefined(localInferenceCalls.map((c) => c.outputTokens)),
    redirectPacketSizeBytes,
    analysisDurationMs,
  };
}

/**
 * Builds one intervention measurement record. Pure and deterministic: the
 * same input always produces the same record, and nothing is mutated.
 *
 * Rejects (never fabricates a record) when:
 * - `sessionId` doesn't match either the packet's own session or the
 *   trajectory passed in -- a mismatched packet/trajectory is never
 *   silently attributed to the wrong session, or
 * - `deliveredAt` precedes `approvedAt` -- a redirect cannot have been
 *   delivered before it was approved.
 */
export function buildInterventionRecord(input: InterventionMeasurementInput): InterventionMeasurementResult {
  const { sessionId, packet, approvedAt, deliveredAt, trajectoryUsage, usageEventTimestamps, localInferenceCalls, analysisDurationMs } = input;

  if (packet.sessionId !== sessionId || trajectoryUsage.sessionId !== sessionId) {
    return {
      success: false,
      record: undefined,
      error: `session mismatch: requested sessionId "${sessionId}" does not match the packet (session "${packet.sessionId}") and/or trajectory (session "${trajectoryUsage.sessionId}")`,
    };
  }

  if (deliveredAt < approvedAt) {
    return {
      success: false,
      record: undefined,
      error: `deliveredAt (${deliveredAt}) precedes approvedAt (${approvedAt})`,
    };
  }

  const { pre, post } = splitUsageByDeliveryBoundary(trajectoryUsage.sessionTotals.records, usageEventTimestamps, deliveredAt);
  const redirectPacketSizeBytes = Buffer.byteLength(formatInjectedRedirectContext(packet), "utf8");

  const record: InterventionRecord = {
    sessionId,
    sourceStepIndexes: [...packet.sourceStepIndexes],
    approvedAt,
    deliveredAt,
    preRedirectUsage: pre,
    postRedirectUsage: post,
    driftOverhead: buildDriftOverhead(localInferenceCalls, redirectPacketSizeBytes, analysisDurationMs),
    outcome: buildOutcome(trajectoryUsage),
  };

  return { success: true, record, error: undefined };
}
