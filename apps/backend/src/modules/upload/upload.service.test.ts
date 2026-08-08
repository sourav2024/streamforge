import { test } from "node:test";
import assert from "node:assert/strict";
import { createUploadService } from "./upload.service.js";
import type { Storage } from "../../platform/storage.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import type { Video, CreateVideoInput } from "@streamforge/contracts";

function fakeStorage(overrides: Partial<Storage> = {}): Storage & { put: string[]; deleted: string[] } {
  const put: string[] = [];
  const deleted: string[] = [];
  return {
    ensureBucket: async () => {},
    putObjectFromFile: async (key) => { put.push(key); },
    deleteObject: async (key) => { deleted.push(key); },
    put, deleted, ...overrides,
  } as Storage & { put: string[]; deleted: string[] };
}

const okProbe = async () => ({ durationSeconds: 1, width: 320, height: 240, videoCodec: "h264", audioCodec: "aac" });

function fakeTranscode(): { enqueue(videoId: string): Promise<void>; enqueued: string[] } {
  const enqueued: string[] = [];
  return { enqueue: async (videoId) => { enqueued.push(videoId); }, enqueued };
}

test("happy path: uploads, probes, records, enqueues transcode; key is <id>/original.mp4", async () => {
  const storage = fakeStorage();
  const transcode = fakeTranscode();
  let recorded: CreateVideoInput | null = null;
  const catalog: CatalogService = {
    createVideo: async (i) => { recorded = i; return { ...i, status: "uploaded", createdAt: "t" } as Video; },
    listVideos: async () => [], getVideo: async () => null, updateStatus: async () => null,
  };
  const svc = createUploadService({ storage, catalog, probe: okProbe, transcode });
  const out = await svc.ingest({ tempPath: "/tmp/x.mp4", title: "T", contentType: "video/mp4", sizeBytes: 10 });
  assert.equal(storage.put.length, 1);
  assert.equal(storage.put[0], `${out.id}/original.mp4`);
  assert.equal(recorded!.width, 320);
  assert.equal(out.status, "uploaded");
  assert.deepEqual(transcode.enqueued, [out.id], "transcode job enqueued for the created video");
});

test("compensating delete: if catalog.createVideo throws, the stored object is deleted and error rethrown", async () => {
  const storage = fakeStorage();
  const transcode = fakeTranscode();
  const catalog: CatalogService = {
    createVideo: async () => { throw new Error("db down"); },
    listVideos: async () => [], getVideo: async () => null, updateStatus: async () => null,
  };
  const svc = createUploadService({ storage, catalog, probe: okProbe, transcode });
  await assert.rejects(
    () => svc.ingest({ tempPath: "/tmp/x.mp4", title: "T", contentType: "video/mp4", sizeBytes: 10 }),
    /db down/,
  );
  assert.equal(storage.deleted.length, 1, "object must be compensating-deleted");
  assert.equal(storage.deleted[0], storage.put[0]);
  assert.equal(transcode.enqueued.length, 0, "no transcode job for a failed ingest");
});

test("probe failure is non-fatal: records nulls, still succeeds", async () => {
  const storage = fakeStorage();
  let recorded: CreateVideoInput | null = null;
  const catalog: CatalogService = {
    createVideo: async (i) => { recorded = i; return { ...i, status: "uploaded", createdAt: "t" } as Video; },
    listVideos: async () => [], getVideo: async () => null, updateStatus: async () => null,
  };
  const nullProbe = async () => ({ durationSeconds: null, width: null, height: null, videoCodec: null, audioCodec: null });
  const svc = createUploadService({ storage, catalog, probe: nullProbe, transcode: fakeTranscode() });
  await svc.ingest({ tempPath: "/tmp/x.mp4", title: "T", contentType: "video/mp4", sizeBytes: 10 });
  assert.equal(recorded!.width, null);
  assert.equal(recorded!.videoCodec, null);
});

test("enqueue failure is NON-FATAL: upload still succeeds (stuck-at-uploaded gap, spec §6)", async () => {
  const storage = fakeStorage();
  const catalog: CatalogService = {
    createVideo: async (i) => ({ ...i, status: "uploaded", createdAt: "t" }) as Video,
    listVideos: async () => [], getVideo: async () => null, updateStatus: async () => null,
  };
  const svc = createUploadService({
    storage, catalog, probe: okProbe,
    transcode: { enqueue: async () => { throw new Error("redis down"); } },
  });
  const out = await svc.ingest({ tempPath: "/tmp/x.mp4", title: "T", contentType: "video/mp4", sizeBytes: 10 });
  assert.equal(out.status, "uploaded");
  assert.equal(storage.deleted.length, 0, "durable upload must NOT be rolled back");
});
