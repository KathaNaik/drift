/**
 * Standalone bridge invoked as a Claude Code command hook for events that
 * don't reliably work over the "http" hook transport -- SessionStart (never
 * supported the transport at all) and UserPromptSubmit (M12B.1: real Claude
 * Code CLI does not fold an HTTP hook's `hookSpecificOutput.additionalContext`
 * into its context, despite matching Claude Code's own documented response
 * schema -- see M12B-LIVE). Reads the complete hook JSON from stdin and
 * forwards it unchanged to Drift's existing /hooks/claude endpoint, exactly
 * as before.
 *
 * What's new for M12B.1: the bridge now also reads Drift's response body.
 * When it contains `hookSpecificOutput.additionalContext` (which the runtime
 * only ever populates for an approved, still-current UserPromptSubmit
 * redirect -- see runtime.ts's buildUserPromptSubmitResponse), that text is
 * written to the bridge's own stdout UNCHANGED and unwrapped: Claude Code's
 * command-hook contract treats a command hook's stdout as additional
 * context, the same way it already treats UserPromptSubmit's stdout for any
 * other command hook. For SessionStart, Drift's response never contains that
 * field, so this bridge's behavior for SessionStart is completely unchanged
 * (still prints nothing).
 *
 * Runs as a plain Node process outside any VS Code host, so it must not
 * import "vscode" or anything else unavailable there. Never blocks or
 * disrupts the Claude Code session it's attached to: it always exits 0,
 * whether or not Drift's runtime was reachable, and never writes anything
 * to stdout unless it has the complete, real redirect text to emit -- a
 * failure at any point (unreachable runtime, malformed response, a response
 * with no eligible redirect) simply results in no stdout output at all,
 * never partial or garbled text.
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

/** Forwards `body` unchanged to Drift's hook endpoint and returns its response body, or undefined on any failure (unreachable, timed out, connection error) -- never throws or rejects. */
function postToDrift(port: number, body: string): Promise<string | undefined> {
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
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", () => resolve(undefined));
      }
    );
    req.on("error", () => resolve(undefined));
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
    req.end(body);
  });
}

/**
 * Extracts the exact redirect text from Drift's raw response body, or
 * undefined when there's nothing eligible to inject -- an absent field, an
 * empty array, a non-string entry, or a body that isn't valid JSON at all
 * (an unreachable/misbehaving runtime) all resolve to undefined rather than
 * throwing, so a malformed response can never produce garbled stdout.
 */
function extractInjectedContext(responseBody: string | undefined): string | undefined {
  if (!responseBody) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const hookSpecificOutput = (parsed as Record<string, unknown>).hookSpecificOutput;
  if (typeof hookSpecificOutput !== "object" || hookSpecificOutput === null) return undefined;
  const additionalContext = (hookSpecificOutput as Record<string, unknown>).additionalContext;
  if (!Array.isArray(additionalContext) || additionalContext.length === 0) return undefined;
  if (typeof additionalContext[0] !== "string") return undefined;
  return additionalContext[0];
}

async function main(): Promise<void> {
  const port = Number(process.argv[2]);
  const body = await readStdin();

  if (Number.isFinite(port) && body.length > 0) {
    const responseBody = await postToDrift(port, body);
    const injectedContext = extractInjectedContext(responseBody);
    if (injectedContext !== undefined) {
      process.stdout.write(injectedContext);
    }
  }

  process.exit(0);
}

main();
