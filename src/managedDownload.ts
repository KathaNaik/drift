/**
 * A small, generic download-and-verify primitive shared by Drift's managed
 * local-model and llama.cpp-runtime setup (see modelSetup.ts). Neither
 * asset is bundled inside the extension package -- both are fetched into
 * Drift's own global storage on explicit user request, never automatically
 * on activation.
 *
 * Every download lands in a `.part` file first and is renamed into place
 * only once its SHA-256 matches the caller's expected digest: an
 * interrupted, failed, or corrupted download can never leave a bad or
 * partial file at the real destination path, and the `.part` file itself
 * is always cleaned up on any failure path -- there is nothing left behind
 * to accidentally be mistaken for a completed install.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as https from "https";
import * as http from "http";
import { IncomingMessage } from "http";

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | undefined;
}

export type DownloadProgressCallback = (progress: DownloadProgress) => void;

export interface DownloadResult {
  success: boolean;
  path: string | undefined;
  error: string | undefined;
}

/** Every real asset URL this module is configured with is https; http support exists only so tests can use a plain local HTTP fixture server instead of standing up TLS. */
function transportFor(url: string): typeof https | typeof http {
  return new URL(url).protocol === "http:" ? http : https;
}

function requestWithRedirects(url: string, maxRedirects: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = transportFor(url).get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // discard the (empty) redirect body so the socket can be reused/closed cleanly
        if (maxRedirects <= 0) {
          reject(new Error("too many redirects"));
          return;
        }
        // The Location header may be relative (per HTTP spec) -- resolve it
        // against the URL that produced it, exactly as a browser would.
        const nextUrl = new URL(res.headers.location, url).toString();
        requestWithRedirects(nextUrl, maxRedirects - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`unexpected HTTP status ${status}`));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
  });
}

/**
 * Downloads `url` to `destinationPath`, verifying its SHA-256 against
 * `expectedSha256` (case-insensitive hex) before it ever appears at that
 * path. Never throws: a network error, a non-200 status, or a checksum
 * mismatch all resolve to `{success: false, error}`, with the `.part` file
 * removed first in every case.
 */
export async function downloadAndVerifyFile(url: string, destinationPath: string, expectedSha256: string, onProgress?: DownloadProgressCallback): Promise<DownloadResult> {
  const partialPath = `${destinationPath}.part`;
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  try {
    const response = await requestWithRedirects(url, 5);
    const contentLength = response.headers["content-length"];
    const totalBytes = typeof contentLength === "string" ? Number(contentLength) : undefined;

    const hash = crypto.createHash("sha256");
    let receivedBytes = 0;

    await new Promise<void>((resolve, reject) => {
      const fileStream = fs.createWriteStream(partialPath);
      response.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        receivedBytes += chunk.length;
        onProgress?.({ receivedBytes, totalBytes });
      });
      response.on("error", reject);
      fileStream.on("error", reject);
      fileStream.on("finish", resolve);
      response.pipe(fileStream);
    });

    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      fs.rmSync(partialPath, { force: true });
      return { success: false, path: undefined, error: `checksum mismatch: expected ${expectedSha256}, got ${actualSha256}` };
    }

    fs.renameSync(partialPath, destinationPath);
    return { success: true, path: destinationPath, error: undefined };
  } catch (error) {
    fs.rmSync(partialPath, { force: true });
    return { success: false, path: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Computes a file's own SHA-256 -- used to detect an already-installed, still-valid asset without re-downloading it. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
