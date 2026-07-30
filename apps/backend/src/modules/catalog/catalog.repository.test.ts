import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../../platform/db.js";
import { loadConfig } from "../../platform/config.js";
import { createCatalogRepository } from "./catalog.repository.js";
import type { CreateVideoInput } from "@streamforge/contracts";

const pool = createPool(loadConfig());
const repo = createCatalogRepository(pool);
const ids: string[] = [];

after(async () => {
  for (const id of ids) await pool.query("delete from videos where id = $1", [id]);
  await pool.end();
});

function sample(): CreateVideoInput {
  const id = randomUUID();
  ids.push(id);
  return {
    id, title: "Test", storageKey: `${id}/original.mp4`, sizeBytes: 123,
    contentType: "video/mp4", durationSeconds: 1.0, width: 320, height: 240, videoCodec: "h264",
  };
}

test("insert then getById returns the row with mapped fields", async () => {
  const input = sample();
  const created = await repo.insert(input);
  assert.equal(created.id, input.id);
  assert.equal(created.status, "uploaded");
  assert.equal(created.width, 320);
  const fetched = await repo.getById(input.id);
  assert.equal(fetched?.title, "Test");
});

test("list includes an inserted row", async () => {
  const input = sample();
  await repo.insert(input);
  const all = await repo.list();
  assert.ok(all.some((v) => v.id === input.id));
});

test("getById returns null for unknown id", async () => {
  assert.equal(await repo.getById(randomUUID()), null);
});

test("updateStatus persists the new status and returns the updated row", async () => {
  const input = sample();
  await repo.insert(input);
  const updated = await repo.updateStatus(input.id, "transcoding");
  assert.equal(updated?.status, "transcoding");
  const fetched = await repo.getById(input.id);
  assert.equal(fetched?.status, "transcoding");
});

test("updateStatus returns null for unknown id", async () => {
  assert.equal(await repo.updateStatus(randomUUID(), "failed"), null);
});
