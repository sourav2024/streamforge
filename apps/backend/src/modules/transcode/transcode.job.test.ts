import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UnrecoverableError } from "bullmq";
import { processTranscodeJob, contentTypeFor } from "./transcode.job.js";
import type { TranscodeJobDeps } from "./transcode.job.js";
import type { Storage } from "../../platform/storage.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import type { Video, VideoStatus } from "@streamforge/contracts";

const VIDEO: Video = {
  id: "vid-1", title: "T", storageKey: "vid-1/original.mp4", sizeBytes: 10,
  contentType: "video/mp4", durationSeconds: 10, width: 1920, height: 1080,
  videoCodec: "h264", status: "uploaded", createdAt: "2026-07-22T00:00:00.000Z",
};

/** Fakes wired for the happy path; tests override the failure they want. */
function makeDeps(overrides: Partial<TranscodeJobDeps> = {}): TranscodeJobDeps & {
  statuses: VideoStatus[];
  uploaded: Array<{ key: string; contentType: string }>;
} {
  const statuses: VideoStatus[] = [];
  const uploaded: Array<{ key: string; contentType: string }> = [];
  const catalog: CatalogService = {
    createVideo: async () => VIDEO,
    listVideos: async () => [],
    getVideo: async () => VIDEO,
    updateStatus: async (_id, status) => { statuses.push(status); return VIDEO; },
  };
  const rawStorage = {
    getObjectToFile: async (_key: string, dest: string) => { await writeFile(dest, "raw"); },
  } as Storage;
  const hlsStorage = {
    putObjectFromFile: async (key: string, _path: string, contentType: string) => {
      uploaded.push({ key, contentType });
    },
  } as Storage;
  const runHls = async (_input: string, outDir: string): Promise<void> => {
    await writeFile(join(outDir, "index.m3u8"), "#EXTM3U");
    await writeFile(join(outDir, "init.mp4"), "init");
    await writeFile(join(outDir, "seg_00000.m4s"), "seg");
  };
  return { catalog, rawStorage, hlsStorage, runHls, statuses, uploaded, ...overrides };
}

test("happy path: transcoding → uploads all artifacts with correct content-types → ready", async () => {
  const deps = makeDeps();
  await processTranscodeJob({ videoId: "vid-1" }, deps);

  assert.deepEqual(deps.statuses, ["transcoding", "ready"]);
  assert.deepEqual(deps.uploaded, [
    { key: "vid-1/index.m3u8", contentType: "application/vnd.apple.mpegurl" },
    { key: "vid-1/init.mp4", contentType: "video/mp4" },
    { key: "vid-1/seg_00000.m4s", contentType: "video/iso.segment" },
  ]);
});

test("unknown video: UnrecoverableError (retries are pointless), no status written", async () => {
  const deps = makeDeps();
  deps.catalog.getVideo = async () => null;

  await assert.rejects(
    () => processTranscodeJob({ videoId: "ghost" }, deps),
    UnrecoverableError,
  );
  assert.deepEqual(deps.statuses, []);
});

test("ffmpeg failure: rethrows for BullMQ retry; status stays 'transcoding', nothing uploaded, never 'ready'", async () => {
  const deps = makeDeps({
    runHls: async () => { throw new Error("encoder exploded"); },
  });

  await assert.rejects(
    () => processTranscodeJob({ videoId: "vid-1" }, deps),
    /encoder exploded/,
  );
  assert.deepEqual(deps.statuses, ["transcoding"], "no 'ready' after a failed encode");
  assert.equal(deps.uploaded.length, 0);
});

test("contentTypeFor maps the three artifact kinds", () => {
  assert.equal(contentTypeFor("index.m3u8"), "application/vnd.apple.mpegurl");
  assert.equal(contentTypeFor("seg_00042.m4s"), "video/iso.segment");
  assert.equal(contentTypeFor("init.mp4"), "video/mp4");
});
