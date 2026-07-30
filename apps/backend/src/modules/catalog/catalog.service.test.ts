import { test } from "node:test";
import assert from "node:assert/strict";
import { createCatalogService } from "./catalog.service.js";
import type { CatalogRepository } from "./catalog.repository.js";
import type { Video, CreateVideoInput } from "@streamforge/contracts";

function fakeVideo(input: CreateVideoInput): Video {
  return { ...input, status: "uploaded", createdAt: "2026-07-08T00:00:00.000Z" };
}

test("createVideo delegates to repo.insert", async () => {
  let called: CreateVideoInput | null = null;
  const repo: CatalogRepository = {
    insert: async (i) => { called = i; return fakeVideo(i); },
    list: async () => [],
    getById: async () => null,
    updateStatus: async () => null,
  };
  const svc = createCatalogService(repo);
  const input: CreateVideoInput = {
    id: "x", title: "T", storageKey: "x/original.mp4", sizeBytes: 1,
    contentType: "video/mp4", durationSeconds: null, width: null, height: null, videoCodec: null,
  };
  const out = await svc.createVideo(input);
  assert.equal(called!.id, "x");
  assert.equal(out.status, "uploaded");
});

test("updateStatus delegates to repo.updateStatus", async () => {
  let calledWith: [string, string] | null = null;
  const repo: CatalogRepository = {
    insert: async (i) => fakeVideo(i),
    list: async () => [],
    getById: async () => null,
    updateStatus: async (id, status) => {
      calledWith = [id, status];
      return null;
    },
  };
  const svc = createCatalogService(repo);
  await svc.updateStatus("x", "ready");
  assert.deepEqual(calledWith, ["x", "ready"]);
});
