/**
 * Development-only inspector for M4C: dumps a captured session's raw events
 * from a Drift SQLite database and checks it against the M4C required event
 * types. Reads the database directly (not through src/storage.ts) so it
 * stays entirely separate from the production storage API.
 *
 * Usage: node ./out/dev/inspect-session.js <path-to-sqlite-db> [session_id]
 * If session_id is omitted, the most recently created session is used.
 */
import { DatabaseSync } from "node:sqlite";

const REQUIRED_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"];

interface SessionRow {
  id: string;
  created_at: number;
}

interface RawEventRow {
  id: number;
  timestamp: number;
  payload: string;
}

function main(): void {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error("Usage: node ./out/dev/inspect-session.js <path-to-sqlite-db> [session_id]");
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });

  const sessions = db.prepare("SELECT id, created_at FROM sessions ORDER BY created_at ASC").all() as unknown as SessionRow[];
  if (sessions.length === 0) {
    console.log("No sessions found in this database.");
    db.close();
    return;
  }

  const requestedId = process.argv[3];
  const targetId = requestedId ?? sessions[sessions.length - 1].id;

  const events = db
    .prepare("SELECT id, timestamp, payload FROM raw_events WHERE session_id = ? ORDER BY timestamp ASC, id ASC")
    .all(targetId) as unknown as RawEventRow[];

  console.log(`Session: ${targetId}`);
  console.log(`Events (${events.length}), in stored order:\n`);

  const seenEventNames: string[] = [];
  for (const event of events) {
    const parsed = JSON.parse(event.payload);
    seenEventNames.push(parsed.hook_event_name);
    console.log(`--- [${event.timestamp}] ${parsed.hook_event_name} ---`);
    console.log(JSON.stringify(parsed, null, 2));
    console.log("");
  }

  console.log("=== M4C required-event check ===");
  for (const required of REQUIRED_EVENTS) {
    console.log(`  [${seenEventNames.includes(required) ? "x" : " "}] ${required}`);
  }
  const allPresent = REQUIRED_EVENTS.every((r) => seenEventNames.includes(r));
  console.log(allPresent ? "\nAll required events captured for this session." : "\nMissing required events.");

  db.close();
}

main();
