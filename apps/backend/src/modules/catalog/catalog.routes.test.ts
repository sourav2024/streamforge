import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerCatalog } from "./index.js";
import type { CatalogService } from "./catalog.service.js";
import type { Video } from "@streamforge/contracts";

const v: Video = {
  id: "abc", title: "T", storageKey: "abc/original.mp4", sizeBytes: 1,
  contentType: "video/mp4", durationSeconds: null, width: null, height: null,
  videoCodec: null, status: "uploaded", createdAt: "2026-07-08T00:00:00.000Z",
};
const service: CatalogService = {
  createVideo: async () => v,
  listVideos: async () => [v],
  getVideo: async (id) => (id === "abc" ? v : null),
  updateStatus: async () => null,
};

test("GET /catalog/videos returns list", async () => {
  const app = Fastify();
  registerCatalog(app, { service });
  const res = await app.inject({ method: "GET", url: "/catalog/videos" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { videos: [v] });
  await app.close();
});

test("GET /catalog/videos/:id returns 404 for a non-UUID id (guarded before DB)", async () => {
  const app = Fastify();
  registerCatalog(app, { service });
  const res = await app.inject({ method: "GET", url: "/catalog/videos/nope" });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("GET /catalog/videos/:id returns 404 for a well-formed but unknown UUID", async () => {
  const app = Fastify();
  registerCatalog(app, { service });
  const res = await app.inject({
    method: "GET",
    url: "/catalog/videos/00000000-0000-0000-0000-000000000000",
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});
