import * as assert from "assert";
import { RedirectLifecycleManager } from "../../src/redirectLifecycle";
import { RedirectPacket } from "../../src/redirectPacket";
import { SessionAnalysis } from "../../src/sessionAnalysisPipeline";

function packet(sessionId: string): RedirectPacket {
  return {
    sessionId,
    sourceStepIndexes: [0, 1, 2, 3],
    reasonCodes: ["strong_deterministic_signal"],
    currentState: ["Bash (npm test) failed: 2 failing"],
    avoidRepeating: "Repeated identical failing command: Bash failed 3 times",
    suggestedNextAction: "Reassess the current approach before continuing.",
  };
}

function analysis(sessionId: string): SessionAnalysis {
  return { sessionId, analyses: [] };
}

suite("redirectLifecycle (M12B)", () => {
  test("a freshly prepared packet is not yet injectable (unapproved packet cannot inject)", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    assert.strictEqual(manager.getState("s1"), "prepared");
    assert.strictEqual(manager.getInjectablePacket("s1", a1), undefined);
  });

  test("approving a prepared packet makes it injectable", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    const approved = manager.approve("s1");
    assert.strictEqual(approved, true);
    assert.strictEqual(manager.getState("s1"), "approved");
    const injectable = manager.getInjectablePacket("s1", a1);
    assert.ok(injectable);
    assert.strictEqual(injectable!.sessionId, "s1");
  });

  test("approve() is a safe no-op when nothing was ever prepared for that session", () => {
    const manager = new RedirectLifecycleManager();
    assert.strictEqual(manager.approve("never-prepared"), false);
    assert.strictEqual(manager.getState("never-prepared"), undefined);
  });

  test("approve() cannot re-approve an already-approved, consumed, or cancelled packet", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    manager.approve("s1");
    assert.strictEqual(manager.approve("s1"), false, "already approved -- re-approving must be a no-op");

    manager.markConsumed("s1");
    assert.strictEqual(manager.approve("s1"), false, "consumed -- cannot be approved again");

    const manager2 = new RedirectLifecycleManager();
    manager2.prepare(packet("s2"), analysis("s2"));
    manager2.cancel("s2");
    assert.strictEqual(manager2.approve("s2"), false, "cancelled -- cannot be approved");
  });

  test("cancelling a prepared (unapproved) packet makes it permanently non-injectable", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    manager.cancel("s1");
    assert.strictEqual(manager.getState("s1"), "cancelled");
    assert.strictEqual(manager.getInjectablePacket("s1", a1), undefined);
  });

  test("cancelling an approved (but not yet consumed) packet makes it non-injectable (cancelled packet cannot inject)", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    manager.approve("s1");
    manager.cancel("s1");
    assert.strictEqual(manager.getState("s1"), "cancelled");
    assert.strictEqual(manager.getInjectablePacket("s1", a1), undefined);
  });

  test("cancel() on an already-consumed packet is a no-op -- consumed stays consumed", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    manager.approve("s1");
    manager.markConsumed("s1");
    manager.cancel("s1");
    assert.strictEqual(manager.getState("s1"), "consumed", "cancel() must never overwrite a terminal 'consumed' state");
  });

  test("a consumed packet cannot inject twice (one-shot delivery)", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    manager.approve("s1");
    const first = manager.getInjectablePacket("s1", a1);
    assert.ok(first, "first lookup, before consumption, must succeed");
    manager.markConsumed("s1");
    const second = manager.getInjectablePacket("s1", a1);
    assert.strictEqual(second, undefined, "a second lookup after consumption must return nothing -- one-shot only");
  });

  test("markConsumed() only ever transitions from 'approved' -- it is a safe no-op from 'prepared' or 'cancelled'", () => {
    const manager = new RedirectLifecycleManager();
    manager.prepare(packet("s1"), analysis("s1"));
    manager.markConsumed("s1");
    assert.strictEqual(manager.getState("s1"), "prepared", "markConsumed on a merely-prepared packet must not change its state");

    const manager2 = new RedirectLifecycleManager();
    manager2.prepare(packet("s2"), analysis("s2"));
    manager2.cancel("s2");
    manager2.markConsumed("s2");
    assert.strictEqual(manager2.getState("s2"), "cancelled", "markConsumed on a cancelled packet must not resurrect it");
  });

  test("getInjectablePacket returns undefined for a completely unknown/mismatched session (active session must match packet.sessionId)", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    manager.approve("s1");
    assert.strictEqual(manager.getInjectablePacket("s1-typo", a1), undefined);
    assert.strictEqual(manager.getInjectablePacket("completely-unrelated-session", undefined), undefined);
  });

  test("stale: a newer, different analysis for the SAME session invalidates an approved packet", () => {
    const manager = new RedirectLifecycleManager();
    const originalAnalysis = analysis("s1");
    manager.prepare(packet("s1"), originalAnalysis);
    manager.approve("s1");

    const newerAnalysis = analysis("s1"); // a genuinely different object, same session
    assert.notStrictEqual(newerAnalysis, originalAnalysis);
    const result = manager.getInjectablePacket("s1", newerAnalysis);
    assert.strictEqual(result, undefined, "a newer incompatible analysis for the same session must invalidate the packet");
    assert.strictEqual(manager.getState("s1"), "approved", "staleness is a lookup-time rejection, not a state mutation");
  });

  test("a current analysis for a DIFFERENT session never invalidates this session's approved packet", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    manager.approve("s1");

    const unrelatedSessionAnalysis = analysis("some-other-session");
    const result = manager.getInjectablePacket("s1", unrelatedSessionAnalysis);
    assert.ok(result, "an unrelated session's analysis must not invalidate this session's own packet");
  });

  test("passing the SAME analysis reference back, or undefined, never counts as stale", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    manager.approve("s1");
    assert.ok(manager.getInjectablePacket("s1", a1), "the exact same analysis reference must never be treated as stale");
    assert.ok(manager.getInjectablePacket("s1", undefined), "no global current analysis at all must never be treated as stale");
  });

  test("preparing a new packet for the same session always replaces whatever was tracked before, regardless of its prior state", () => {
    const manager = new RedirectLifecycleManager();
    const a1 = analysis("s1");
    manager.prepare(packet("s1"), a1);
    manager.approve("s1");
    manager.markConsumed("s1");
    assert.strictEqual(manager.getState("s1"), "consumed");

    const a2 = analysis("s1");
    manager.prepare(packet("s1"), a2);
    assert.strictEqual(manager.getState("s1"), "prepared", "a fresh redirect cycle must always be allowed to start over");
    assert.strictEqual(manager.getInjectablePacket("s1", a2), undefined, "freshly prepared, not yet approved");
  });

  test("getState returns undefined for a session that was never tracked at all", () => {
    const manager = new RedirectLifecycleManager();
    assert.strictEqual(manager.getState("never-seen"), undefined);
  });

  test("sessions are fully isolated from one another", () => {
    const manager = new RedirectLifecycleManager();
    const aX = analysis("session-x");
    const aY = analysis("session-y");
    manager.prepare(packet("session-x"), aX);
    manager.prepare(packet("session-y"), aY);
    manager.approve("session-x");
    // session-y stays merely "prepared".

    assert.ok(manager.getInjectablePacket("session-x", aX));
    assert.strictEqual(manager.getInjectablePacket("session-y", aY), undefined);
    assert.strictEqual(manager.getState("session-x"), "approved");
    assert.strictEqual(manager.getState("session-y"), "prepared");
  });
});
