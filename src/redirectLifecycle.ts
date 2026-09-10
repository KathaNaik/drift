/**
 * In-memory lifecycle tracking for M12A redirect packets, and the safety
 * gate that decides whether one is currently eligible for injection (M12B).
 * Nothing here is persisted -- per this milestone's own scope, intervention
 * state lives only for the life of the running extension process.
 *
 * A session has at most one live tracked redirect at a time; preparing a
 * new one for the same session replaces whatever was tracked before it
 * (a fresh redirect cycle is always allowed to start over, regardless of
 * how the previous one ended).
 *
 * State machine: prepared -> approved -> consumed
 *                prepared -> cancelled
 *                approved -> cancelled
 * Only "approved" is ever injectable, and only once -- getInjectablePacket()
 * never mutates state itself; a caller must call markConsumed() only after
 * the injection has actually been delivered, so a delivery failure leaves
 * the packet approved (and therefore retryable) rather than silently lost.
 */

import { RedirectPacket } from "./redirectPacket";
import { SessionAnalysis } from "./sessionAnalysisPipeline";

export type RedirectLifecycleState = "prepared" | "approved" | "consumed" | "cancelled";

interface TrackedRedirect {
  packet: RedirectPacket;
  state: RedirectLifecycleState;
  /** The exact SessionAnalysis object this packet was generated from -- compared by reference at injection time so a newer, incompatible re-analysis of the SAME session invalidates it. */
  preparedFromAnalysis: SessionAnalysis;
}

export class RedirectLifecycleManager {
  private bySessionId = new Map<string, TrackedRedirect>();

  /** Registers a freshly generated packet as "prepared" -- not yet eligible for injection. Replaces any earlier tracked redirect for the same session. */
  prepare(packet: RedirectPacket, preparedFromAnalysis: SessionAnalysis): void {
    this.bySessionId.set(packet.sessionId, { packet, state: "prepared", preparedFromAnalysis });
  }

  /** Only a "prepared" redirect can become "approved". Returns false (a safe no-op) if nothing is currently prepared for this session. */
  approve(sessionId: string): boolean {
    const tracked = this.bySessionId.get(sessionId);
    if (!tracked || tracked.state !== "prepared") return false;
    tracked.state = "approved";
    return true;
  }

  /** Cancels whatever is tracked for this session, from "prepared" or "approved" -- a safe no-op once it's already "consumed" (nothing left to cancel) or already "cancelled". */
  cancel(sessionId: string): void {
    const tracked = this.bySessionId.get(sessionId);
    if (!tracked || tracked.state === "consumed") return;
    tracked.state = "cancelled";
  }

  /**
   * Returns the packet eligible for injection into this exact sessionId's
   * next matching hook call, or undefined when none is eligible: never
   * prepared, never approved, already cancelled, already consumed, or
   * bound to an analysis of this session that a newer manual re-analysis
   * has since replaced. A current analysis belonging to a DIFFERENT
   * session never invalidates this one -- it simply tells us nothing
   * about this session. Pure lookup: never mutates anything.
   */
  getInjectablePacket(sessionId: string, currentAnalysisForActiveSession: SessionAnalysis | undefined): RedirectPacket | undefined {
    const tracked = this.bySessionId.get(sessionId);
    if (!tracked || tracked.state !== "approved") return undefined;
    if (currentAnalysisForActiveSession && currentAnalysisForActiveSession.sessionId === sessionId && currentAnalysisForActiveSession !== tracked.preparedFromAnalysis) {
      return undefined; // stale: a newer, incompatible analysis for this same session has since replaced the one this packet was prepared from.
    }
    return tracked.packet;
  }

  /** Marks the session's tracked redirect consumed -- only from "approved", so this can only ever happen once per prepared/approved cycle. */
  markConsumed(sessionId: string): void {
    const tracked = this.bySessionId.get(sessionId);
    if (tracked && tracked.state === "approved") tracked.state = "consumed";
  }

  /** For observability/testing -- the current lifecycle state of whatever is tracked for this session, or undefined if nothing ever was. */
  getState(sessionId: string): RedirectLifecycleState | undefined {
    return this.bySessionId.get(sessionId)?.state;
  }
}
