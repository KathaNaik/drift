import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStorage } from "../../src/storage";

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-storage-test-"));
  return path.join(dir, "nested", "drift.sqlite3");
}

suite("storage (M3)", () => {
  test("initializes the database and its tables automatically", () => {
    const dbPath = tempDbPath();
    assert.strictEqual(fs.existsSync(dbPath), false);

    const storage = openStorage(dbPath);
    assert.strictEqual(fs.existsSync(dbPath), true);

    const session = storage.createSession(1000);
    assert.ok(session.id);
    storage.close();
  });

  test("creates a session and reads it back", () => {
    const storage = openStorage(tempDbPath());
    const created = storage.createSession(1234);

    const result = storage.getSession(created.id);
    assert.ok(result);
    assert.strictEqual(result!.session.id, created.id);
    assert.strictEqual(result!.session.createdAt, 1234);
    assert.deepStrictEqual(result!.events, []);

    storage.close();
  });

  test("persists multiple raw events for a session and returns them in timestamp order", () => {
    const storage = openStorage(tempDbPath());
    const session = storage.createSession();

    storage.insertRawEvent(session.id, { kind: "third" }, 300);
    storage.insertRawEvent(session.id, { kind: "first" }, 100);
    storage.insertRawEvent(session.id, { kind: "second" }, 200);

    const result = storage.getSession(session.id)!;
    assert.strictEqual(result.events.length, 3);
    assert.deepStrictEqual(
      result.events.map((e) => e.payload),
      [{ kind: "first" }, { kind: "second" }, { kind: "third" }]
    );
    assert.deepStrictEqual(
      result.events.map((e) => e.timestamp),
      [100, 200, 300]
    );

    storage.close();
  });

  test("breaks ties for equal timestamps by insertion order", () => {
    const storage = openStorage(tempDbPath());
    const session = storage.createSession();

    storage.insertRawEvent(session.id, { kind: "a" }, 500);
    storage.insertRawEvent(session.id, { kind: "b" }, 500);

    const result = storage.getSession(session.id)!;
    assert.deepStrictEqual(
      result.events.map((e) => e.payload),
      [{ kind: "a" }, { kind: "b" }]
    );

    storage.close();
  });

  test("data survives closing and reopening the database at the same path", () => {
    const dbPath = tempDbPath();

    const storage = openStorage(dbPath);
    const session = storage.createSession(42);
    storage.insertRawEvent(session.id, { hello: "world" }, 10);
    storage.close();

    const reopened = openStorage(dbPath);
    const result = reopened.getSession(session.id);
    assert.ok(result, "session should survive a restart of the storage layer");
    assert.strictEqual(result!.session.createdAt, 42);
    assert.strictEqual(result!.events.length, 1);
    assert.deepStrictEqual(result!.events[0].payload, { hello: "world" });

    reopened.close();
  });

  test("listSessions returns every known session, most recently created first (M11A)", () => {
    const storage = openStorage(tempDbPath());
    const a = storage.createSession(100);
    const b = storage.createSession(300);
    const c = storage.createSession(200);

    const sessions = storage.listSessions();
    assert.deepStrictEqual(
      sessions.map((s) => s.id),
      [b.id, c.id, a.id]
    );
    assert.deepStrictEqual(
      sessions.map((s) => s.createdAt),
      [300, 200, 100]
    );
    storage.close();
  });

  test("listSessions returns an empty array when no sessions exist", () => {
    const storage = openStorage(tempDbPath());
    assert.deepStrictEqual(storage.listSessions(), []);
    storage.close();
  });

  test("returns undefined for an unknown session id", () => {
    const storage = openStorage(tempDbPath());
    assert.strictEqual(storage.getSession("does-not-exist"), undefined);
    storage.close();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("storage export leases (M6B.2)", () => {
  test("claimExport succeeds when no lease exists for the session", () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("s1");

    assert.strictEqual(storage.claimExport("s1", "owner-A", 10000), true);

    storage.close();
  });

  test("claimExport fails while a non-expired lease is held by another owner", () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("s1");

    assert.strictEqual(storage.claimExport("s1", "owner-A", 10000), true);
    assert.strictEqual(storage.claimExport("s1", "owner-B", 10000), false, "a live lease blocks any other owner");
    assert.strictEqual(storage.claimExport("s1", "owner-A", 10000), false, "even the original owner cannot re-claim while its own lease is still live");

    storage.close();
  });

  test("claimExport reclaims an expired lease, replacing the previous owner", async () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("s1");

    assert.strictEqual(storage.claimExport("s1", "owner-A", 20), true);
    await sleep(50);

    assert.strictEqual(storage.claimExport("s1", "owner-B", 10000), true, "an expired lease must be reclaimable");
    assert.strictEqual(storage.claimExport("s1", "owner-C", 10000), false, "owner-B's fresh lease now blocks further claims");

    storage.close();
  });

  test("an expired lease remains reclaimable after closing and reopening storage", async () => {
    const dbPath = tempDbPath();
    let storage = openStorage(dbPath);
    storage.ensureSession("s1");
    storage.claimExport("s1", "dead-owner", 20);
    storage.close();

    await sleep(50);

    storage = openStorage(dbPath);
    assert.strictEqual(storage.claimExport("s1", "new-owner", 10000), true, "expiry is time-based and durable, not tied to an in-memory process");

    storage.close();
  });

  test("claimExport never succeeds for a session already marked exported, even with no active lease", () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("s1");
    storage.markTraceExported("s1");

    assert.strictEqual(storage.claimExport("s1", "owner-A", 10000), false);

    storage.close();
  });

  test("releaseExportClaim only releases the matching owner's lease (old owner cannot release a newer reclaimed lease)", async () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("s1");

    storage.claimExport("s1", "owner-A", 20);
    await sleep(50);
    assert.strictEqual(storage.claimExport("s1", "owner-B", 10000), true, "owner-B reclaims after owner-A's lease expires");

    // owner-A's stale release must not touch owner-B's active lease.
    storage.releaseExportClaim("s1", "owner-A");
    assert.strictEqual(storage.claimExport("s1", "owner-C", 10000), false, "owner-B's lease must still be active");

    // owner-B's own release does work.
    storage.releaseExportClaim("s1", "owner-B");
    assert.strictEqual(storage.claimExport("s1", "owner-D", 10000), true, "releasing the correct owner frees the session for a new claim");

    storage.close();
  });

  test("releaseExportClaim is a safe no-op when no lease exists", () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("s1");

    assert.doesNotThrow(() => storage.releaseExportClaim("s1", "nobody"));

    storage.close();
  });
});

suite("storage model usage telemetry (M7A)", () => {
  test("persists a model usage event associated with a session", () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("s1");

    const event = storage.insertModelUsageEvent("s1", { model: "claude-sonnet-5" }, 100);
    assert.strictEqual(event.sessionId, "s1");

    const events = storage.getModelUsageEvents("s1");
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(events[0].payload, { model: "claude-sonnet-5" });

    storage.close();
  });

  test("persists a model usage event with no session association", () => {
    const storage = openStorage(tempDbPath());

    const event = storage.insertModelUsageEvent(null, { model: "claude-sonnet-5" }, 100);
    assert.strictEqual(event.sessionId, null);

    storage.close();
  });

  test("multiple model usage events for one session remain ordered", () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("s1");

    storage.insertModelUsageEvent("s1", { call: "third" }, 300);
    storage.insertModelUsageEvent("s1", { call: "first" }, 100);
    storage.insertModelUsageEvent("s1", { call: "second" }, 200);

    const events = storage.getModelUsageEvents("s1");
    assert.deepStrictEqual(
      events.map((e) => (e.payload as { call: string }).call),
      ["first", "second", "third"]
    );

    storage.close();
  });

  test("breaks ties for equal timestamps by insertion order", () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("s1");

    storage.insertModelUsageEvent("s1", { call: "a" }, 500);
    storage.insertModelUsageEvent("s1", { call: "b" }, 500);

    const events = storage.getModelUsageEvents("s1");
    assert.deepStrictEqual(
      events.map((e) => (e.payload as { call: string }).call),
      ["a", "b"]
    );

    storage.close();
  });

  test("different sessions' model usage events remain isolated", () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("session-A");
    storage.ensureSession("session-B");

    storage.insertModelUsageEvent("session-A", { call: "A1" }, 100);
    storage.insertModelUsageEvent("session-B", { call: "B1" }, 100);
    storage.insertModelUsageEvent("session-A", { call: "A2" }, 200);

    const eventsA = storage.getModelUsageEvents("session-A");
    const eventsB = storage.getModelUsageEvents("session-B");

    assert.deepStrictEqual(
      eventsA.map((e) => (e.payload as { call: string }).call),
      ["A1", "A2"]
    );
    assert.deepStrictEqual(
      eventsB.map((e) => (e.payload as { call: string }).call),
      ["B1"]
    );

    storage.close();
  });

  test("returns an empty array for a session with no model usage events", () => {
    const storage = openStorage(tempDbPath());
    storage.ensureSession("s1");
    assert.deepStrictEqual(storage.getModelUsageEvents("s1"), []);
    storage.close();
  });
});
