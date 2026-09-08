import { DatabaseSync } from "node:sqlite";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface DriftSession {
  id: string;
  createdAt: number;
}

export interface DriftRawEvent {
  id: number;
  sessionId: string;
  timestamp: number;
  payload: unknown;
}

export interface DriftSessionWithEvents {
  session: DriftSession;
  events: DriftRawEvent[];
}

export interface DriftStorage {
  createSession(createdAt?: number): DriftSession;
  ensureSession(sessionId: string, createdAt?: number): DriftSession;
  insertRawEvent(sessionId: string, payload: unknown, timestamp?: number): DriftRawEvent;
  getSession(sessionId: string): DriftSessionWithEvents | undefined;
  /** Whether a trace for this session has already been exported successfully. */
  hasExportedTrace(sessionId: string): boolean;
  /** Records that a trace for this session was exported successfully. */
  markTraceExported(sessionId: string, exportedAt?: number): void;
  /**
   * Atomically attempts to claim (or reclaim) a time-bounded lease on the
   * exclusive right to export this session's trace, identified by
   * `ownerId`. Succeeds if no lease currently exists, or if the existing
   * one has expired (its holder is presumed dead, e.g. crashed mid-export)
   * — in that case `ownerId` replaces the previous holder. Fails if a
   * still-valid lease is held by anyone (including a retry by the same
   * caller with a new ownerId) or if the trace is already durably exported.
   *
   * A lease is a fixed expiry timestamp persisted in SQLite, not an
   * in-memory timer, so "has this lease expired" is answered the same way
   * regardless of process restarts: by comparing `expires_at` to the
   * current time. This is what lets an abandoned lease (from a process
   * that claimed one and then crashed before releasing it) become
   * reclaimable on its own, without requiring anyone to explicitly clean
   * it up.
   */
  claimExport(sessionId: string, ownerId: string, leaseDurationMs: number): boolean;
  /** Releases the lease on this session, but only if it's still held by `ownerId` — a caller whose lease already expired and was reclaimed by someone else cannot release the new holder's lease. */
  releaseExportClaim(sessionId: string, ownerId: string): void;
  close(): void;
}

interface SessionRow {
  id: string;
  created_at: number;
}

interface RawEventRow {
  id: number;
  session_id: string;
  timestamp: number;
  payload: string;
}

export function openStorage(dbFilePath: string): DriftStorage {
  fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
  const db = new DatabaseSync(dbFilePath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      payload TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS exported_traces (
      session_id TEXT PRIMARY KEY,
      exported_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS export_leases (
      session_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  const insertSessionStmt = db.prepare("INSERT INTO sessions (id, created_at) VALUES (?, ?)");
  const ensureSessionStmt = db.prepare("INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)");
  const insertEventStmt = db.prepare(
    "INSERT INTO raw_events (session_id, timestamp, payload) VALUES (?, ?, ?)"
  );
  const getSessionStmt = db.prepare("SELECT id, created_at FROM sessions WHERE id = ?");
  const getEventsStmt = db.prepare(
    "SELECT id, session_id, timestamp, payload FROM raw_events WHERE session_id = ? ORDER BY timestamp ASC, id ASC"
  );
  const getExportedTraceStmt = db.prepare("SELECT session_id FROM exported_traces WHERE session_id = ?");
  const markTraceExportedStmt = db.prepare(
    "INSERT OR REPLACE INTO exported_traces (session_id, exported_at) VALUES (?, ?)"
  );
  const getLeaseStmt = db.prepare("SELECT owner_id, expires_at FROM export_leases WHERE session_id = ?");
  const upsertLeaseStmt = db.prepare(`
    INSERT INTO export_leases (session_id, owner_id, claimed_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      owner_id = excluded.owner_id,
      claimed_at = excluded.claimed_at,
      expires_at = excluded.expires_at
  `);
  const releaseLeaseStmt = db.prepare("DELETE FROM export_leases WHERE session_id = ? AND owner_id = ?");

  return {
    createSession(createdAt: number = Date.now()): DriftSession {
      const id = crypto.randomUUID();
      insertSessionStmt.run(id, createdAt);
      return { id, createdAt };
    },

    ensureSession(sessionId: string, createdAt: number = Date.now()): DriftSession {
      ensureSessionStmt.run(sessionId, createdAt);
      const row = getSessionStmt.get(sessionId) as unknown as SessionRow;
      return { id: row.id, createdAt: row.created_at };
    },

    insertRawEvent(sessionId: string, payload: unknown, timestamp: number = Date.now()): DriftRawEvent {
      const result = insertEventStmt.run(sessionId, timestamp, JSON.stringify(payload));
      return { id: Number(result.lastInsertRowid), sessionId, timestamp, payload };
    },

    getSession(sessionId: string): DriftSessionWithEvents | undefined {
      const row = getSessionStmt.get(sessionId) as SessionRow | undefined;
      if (!row) {
        return undefined;
      }

      const eventRows = getEventsStmt.all(sessionId) as unknown as RawEventRow[];
      return {
        session: { id: row.id, createdAt: row.created_at },
        events: eventRows.map((e) => ({
          id: e.id,
          sessionId: e.session_id,
          timestamp: e.timestamp,
          payload: JSON.parse(e.payload),
        })),
      };
    },

    hasExportedTrace(sessionId: string): boolean {
      return getExportedTraceStmt.get(sessionId) !== undefined;
    },

    markTraceExported(sessionId: string, exportedAt: number = Date.now()): void {
      markTraceExportedStmt.run(sessionId, exportedAt);
    },

    claimExport(sessionId: string, ownerId: string, leaseDurationMs: number): boolean {
      if (getExportedTraceStmt.get(sessionId) !== undefined) {
        return false;
      }

      const now = Date.now();
      const existing = getLeaseStmt.get(sessionId) as { owner_id: string; expires_at: number } | undefined;
      if (existing !== undefined && existing.expires_at > now) {
        return false;
      }

      upsertLeaseStmt.run(sessionId, ownerId, now, now + leaseDurationMs);
      return true;
    },

    releaseExportClaim(sessionId: string, ownerId: string): void {
      releaseLeaseStmt.run(sessionId, ownerId);
    },

    close(): void {
      db.close();
    },
  };
}
