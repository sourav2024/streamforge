import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UnrecoverableError } from "bullmq";
import { processTranscodeJob, contentTypeFor, MASTER_PLAYLIST } from "./transcode.job.js";
import type { TranscodeJobDeps } from "./transcode.job.js";
import { LADDER } from "./ladder.js";
import type { Storage } from "../../platform/storage.js";
import type { ProbeResult } from "../../platform/ffprobe.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import type { Video, VideoStatus } from "@streamforge/contracts";

const VIDEO: Video = {
  id: "vid-1", title: "T", storageKey: "vid-1/original.mp4", sizeBytes: 10,
  contentType: "video/mp4", durationSeconds: 10, width: 1920, height: 1080,
  videoCodec: "h264", status: "uploaded", createdAt: "2026-07-22T00:00:00.000Z",
};

const SOURCE_PROBE: ProbeResult = {
  durationSeconds: 10, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac",
};

/**
 * Path-aware probe fake: the job probes the downloaded source AND each rung playlist.
 * Rung playlists report the rung's own height (parsed from the ".../<label>/index.m3u8"
 * path) so the master reflects per-rung measurements, like real ffprobe would.
 */
const fakeProbe = async (p: string): Promise<ProbeResult> => {
  if (p.endsWith("original.mp4")) return SOURCE_PROBE;
  const height = Number(/(\d+)p\/index\.m3u8$/.exec(p)?.[1] ?? 0);
  return { durationSeconds: 10, width: Math.round((height * 16) / 9), height, videoCodec: "h264", audioCodec: "aac" };
};

/** Fakes wired for the happy path; tests override the failure they want. */
function makeDeps(overrides: Partial<TranscodeJobDeps> = {}): TranscodeJobDeps & {
  statuses: VideoStatus[];
  uploaded: Array<{ key: string; contentType: string }>;
  masterBody: { text: string | null };
} {
  const statuses: VideoStatus[] = [];
  const uploaded: Array<{ key: string; contentType: string }> = [];
  const masterBody: { text: string | null } = { text: null };
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
    putObjectFromFile: async (key: string, path: string, contentType: string) => {
      uploaded.push({ key, contentType });
      // Capture the master body before the job's finally-cleanup deletes the temp dir.
      if (key.endsWith(MASTER_PLAYLIST)) masterBody.text = await readFile(path, "utf8");
    },
  } as Storage;
  const runHls = async (_input: string, outDir: string): Promise<void> => {
    await writeFile(join(outDir, "index.m3u8"), "#EXTM3U");
    await writeFile(join(outDir, "init.mp4"), "init");
    await writeFile(join(outDir, "seg_00000.m4s"), "seg");
  };
  return { catalog, rawStorage, hlsStorage, runHls, probe: fakeProbe, statuses, uploaded, masterBody, ...overrides };
}

test("happy path: 1080p source → all 4 rungs uploaded under <id>/<label>/, master LAST, then ready", async () => {
  const deps = makeDeps();
  await processTranscodeJob({ videoId: "vid-1" }, deps);

  assert.deepEqual(deps.statuses, ["transcoding", "ready"]);

  const expected = LADDER.flatMap((r) => [
    { key: `vid-1/${r.label}/index.m3u8`, contentType: "application/vnd.apple.mpegurl" },
    { key: `vid-1/${r.label}/init.mp4`, contentType: "video/mp4" },
    { key: `vid-1/${r.label}/seg_00000.m4s`, contentType: "video/iso.segment" },
  ]);
  expected.push({ key: `vid-1/${MASTER_PLAYLIST}`, contentType: "application/vnd.apple.mpegurl" });
  assert.deepEqual(deps.uploaded, expected, "4 rungs × 3 artifacts, master strictly last");

  // Master reflects the MEASURED rung outputs (fake probe: height from path, 16:9 width).
  const master = deps.masterBody.text!;
  assert.ok(master.includes('RESOLUTION=1920x1080,CODECS="avc1.4d4028,mp4a.40.2"'));
  assert.ok(master.includes("360p/index.m3u8"));
  assert.equal([...master.matchAll(/#EXT-X-STREAM-INF/g)].length, 4);
});

test("small source: 640x360 → exactly one rung (never upscale)", async () => {
  const deps = makeDeps({
    probe: async (p) =>
      p.endsWith("original.mp4")
        ? { ...SOURCE_PROBE, width: 640, height: 360 }
        : { ...SOURCE_PROBE, width: 640, height: 360 },
  });
  await processTranscodeJob({ videoId: "vid-1" }, deps);

  const rungKeys = deps.uploaded.filter((u) => !u.key.endsWith(MASTER_PLAYLIST));
  assert.ok(rungKeys.every((u) => u.key.startsWith("vid-1/360p/")), "only the 360p rung encoded");
  assert.equal([...deps.masterBody.text!.matchAll(/#EXT-X-STREAM-INF/g)].length, 1);
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

test("unprobeable source: NORMAL Error (gets its retries), status stays 'transcoding', nothing uploaded", async () => {
  const deps = makeDeps({
    probe: async () => ({ durationSeconds: null, width: null, height: null, videoCodec: null, audioCodec: null }),
  });

  await assert.rejects(
    () => processTranscodeJob({ videoId: "vid-1" }, deps),
    (err: unknown) => err instanceof Error && !(err instanceof UnrecoverableError) && /cannot select/.test(err.message),
  );
  assert.deepEqual(deps.statuses, ["transcoding"]);
  assert.equal(deps.uploaded.length, 0);
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
