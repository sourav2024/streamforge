import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage } from "./storage.js";
import { loadConfig } from "./config.js";

test("storage round-trip: ensureBucket, put from file, get to file, delete", async () => {
  const config = loadConfig();
  const storage = createStorage(config, config.s3.bucketRaw);
  await storage.ensureBucket();

  const tmp = join(tmpdir(), `sf-storage-test-${process.pid}.txt`);
  await writeFile(tmp, "hello streamforge");
  const key = `__test__/${process.pid}/hello.txt`;

  await storage.putObjectFromFile(key, tmp, "text/plain");

  // Download it back and compare contents — proves put AND get, not just "didn't throw".
  const dest = join(tmpdir(), `sf-storage-test-${process.pid}-down.txt`);
  await storage.getObjectToFile(key, dest);
  assert.equal(await readFile(dest, "utf8"), "hello streamforge");

  await storage.deleteObject(key); // delete of missing key still resolves (idempotent)
  await rm(tmp, { force: true });
  await rm(dest, { force: true });
});

test("getObjectStream: streams an object with metadata; missing key → null", async () => {
  const config = loadConfig();
  const storage = createStorage(config, config.s3.bucketRaw);
  await storage.ensureBucket();

  const tmp = join(tmpdir(), `sf-storage-stream-${process.pid}.txt`);
  await writeFile(tmp, "stream me");
  const key = `__test__/${process.pid}/stream.txt`;
  await storage.putObjectFromFile(key, tmp, "text/plain");

  const obj = await storage.getObjectStream(key);
  assert.ok(obj, "existing key returns a stream");
  const chunks: Buffer[] = [];
  for await (const c of obj.body) chunks.push(c as Buffer);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "stream me");
  assert.equal(obj.contentType, "text/plain");
  assert.equal(obj.contentLength, 9);

  assert.equal(await storage.getObjectStream(`__test__/${process.pid}/nope.txt`), null);

  await storage.deleteObject(key);
  await rm(tmp, { force: true });
});
