import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import * as crypto from "crypto";
import { downloadAndVerifyFile, sha256File } from "../../src/managedDownload";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256Of(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

suite("managedDownload (M15B)", () => {
  test("downloads a file and verifies it against the correct checksum", async () => {
    const content = Buffer.from("hello drift managed download " + "x".repeat(1000));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": content.length });
      res.end(content);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-download-test-");
      const dest = path.join(dir, "asset.bin");
      const result = await downloadAndVerifyFile(`http://127.0.0.1:${port}/asset`, dest, sha256Of(content));

      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.path, dest);
      assert.ok(fs.existsSync(dest));
      assert.ok(!fs.existsSync(`${dest}.part`), "the .part file must not remain after a successful download");
      assert.deepStrictEqual(fs.readFileSync(dest), content);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a checksum mismatch is reported as a failure, and no file is left at the destination or as a stray .part file", async () => {
    const content = Buffer.from("this content will not match the expected checksum");
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(content);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-download-test-");
      const dest = path.join(dir, "asset.bin");
      const wrongChecksum = "0".repeat(64);
      const result = await downloadAndVerifyFile(`http://127.0.0.1:${port}/asset`, dest, wrongChecksum);

      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("checksum mismatch"));
      assert.strictEqual(fs.existsSync(dest), false, "a checksum-mismatched download must never be left at the real destination path");
      assert.strictEqual(fs.existsSync(`${dest}.part`), false, "the partial file must be cleaned up, not left behind");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("checksum comparison is case-insensitive", async () => {
    const content = Buffer.from("case insensitive checksum test");
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(content);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-download-test-");
      const dest = path.join(dir, "asset.bin");
      const result = await downloadAndVerifyFile(`http://127.0.0.1:${port}/asset`, dest, sha256Of(content).toUpperCase());
      assert.strictEqual(result.success, true, result.error);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("an interrupted download (server closes the connection mid-stream) is contained safely -- no file at the destination, no stray .part file, no throw", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Length": "10000000" }); // announce far more than we'll actually send
      res.write(Buffer.alloc(1024, "a"));
      // Destroy the connection abruptly instead of ending it normally -- a genuine interruption, not a clean EOF.
      setTimeout(() => res.destroy(), 20);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-download-test-");
      const dest = path.join(dir, "asset.bin");
      let result: Awaited<ReturnType<typeof downloadAndVerifyFile>> | undefined;
      await assert.doesNotReject(async () => {
        result = await downloadAndVerifyFile(`http://127.0.0.1:${port}/asset`, dest, "irrelevant-since-it-must-fail-before-checksum");
      });
      assert.strictEqual(result!.success, false);
      assert.strictEqual(fs.existsSync(dest), false);
      assert.strictEqual(fs.existsSync(`${dest}.part`), false, "an interrupted download must never leave a stray partial file behind");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a connection failure (nothing listening) is reported as a failure, never thrown", async () => {
    const dir = tempDir("drift-download-test-");
    const dest = path.join(dir, "asset.bin");
    const result = await downloadAndVerifyFile("http://127.0.0.1:1/asset", dest, "0".repeat(64));
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.strictEqual(fs.existsSync(dest), false);
  });

  test("a non-200 HTTP status is reported as a failure, never treated as a valid download", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-download-test-");
      const dest = path.join(dir, "asset.bin");
      const result = await downloadAndVerifyFile(`http://127.0.0.1:${port}/asset`, dest, "0".repeat(64));
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes("404"));
      assert.strictEqual(fs.existsSync(dest), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("follows an HTTP redirect to the final content", async () => {
    const content = Buffer.from("redirected content");
    const server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end(content);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const dir = tempDir("drift-download-test-");
      const dest = path.join(dir, "asset.bin");
      const result = await downloadAndVerifyFile(`http://127.0.0.1:${port}/redirect`, dest, sha256Of(content));
      assert.strictEqual(result.success, true, result.error);
      assert.deepStrictEqual(fs.readFileSync(dest), content);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("sha256File computes the correct digest of a real file", async () => {
    const dir = tempDir("drift-sha256-test-");
    const filePath = path.join(dir, "f.txt");
    const content = Buffer.from("known content for hashing");
    fs.writeFileSync(filePath, content);
    const digest = await sha256File(filePath);
    assert.strictEqual(digest, sha256Of(content));
  });

  test("leaves no file at a nested destination path when the request fails immediately (the containing directory may be prepared, but never the file itself)", async () => {
    const dir = tempDir("drift-download-test-");
    const dest = path.join(dir, "nested", "deep", "asset.bin");
    const result = await downloadAndVerifyFile("http://127.0.0.1:1/asset", dest, "0".repeat(64));
    assert.strictEqual(result.success, false);
    assert.strictEqual(fs.existsSync(dest), false);
    assert.strictEqual(fs.existsSync(`${dest}.part`), false);
  });
});
