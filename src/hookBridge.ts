/**
 * Standalone bridge invoked as a Claude Code command hook for events that
 * don't support the "http" hook transport (currently SessionStart). Reads
 * the complete hook JSON from stdin and forwards it unchanged to Drift's
 * existing /hooks/claude endpoint.
 *
 * Runs as a plain Node process outside any VS Code host, so it must not
 * import "vscode" or anything else unavailable there. Never blocks or
 * disrupts the Claude Code session it's attached to: it always exits 0,
 * whether or not Drift's runtime was reachable.
 *
 * Usage: node hookBridge.js <port>
 */
import * as http from "http";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function postToDrift(port: number, body: string): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/hooks/claude",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", () => resolve());
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

async function main(): Promise<void> {
  const port = Number(process.argv[2]);
  const body = await readStdin();

  if (Number.isFinite(port) && body.length > 0) {
    await postToDrift(port, body);
  }

  process.exit(0);
}

main();
