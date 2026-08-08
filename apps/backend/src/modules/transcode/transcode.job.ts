/**
 * The transcode job handler — pure orchestration, every effect injected (same testability
 * discipline as upload.service). Runs in the WORKER process (src/worker.ts).
 *
 * Phase 1 #4: one job = the WHOLE ladder (spec §2 — `ready` stays one atomic decision).
 * Probe the DOWNLOADED file, never trust possibly-null catalog metadata when we have the
 * bytes; encode every rung the source can honestly fill; master playlist uploads LAST —
 * it is the "ladder complete" artifact, so a crash mid-ladder can never advertise rungs
 * that don't exist yet.
 *
 * IDEMPOTENT BY DESIGN: BullMQ delivers at-least-once (docs/concepts/09-job-queues-bullmq.md
 * §5), so any step may run twice — every step OVERWRITES (fresh temp dir, S3 PUT replaces,
 * status re-set is a no-op), never appends. `ready` is written only after ALL artifacts are
 * uploaded (spec §6).
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnrecoverableError } from "bullmq";
import type { Storage } from "../../platform/storage.js";
import type { ProbeResult } from "../../platform/ffprobe.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import type { TranscodeJobData } from "./transcode.producer.js";
import type { Rung } from "./ladder.js";
import { selectRungs } from "./ladder.js";
import { buildMasterPlaylist } from "./master.js";
import type { MasterEntry } from "./master.js";
import { HLS_PLAYLIST } from "./ffmpeg.js";

export const MASTER_PLAYLIST = "master.m3u8";

export interface TranscodeJobDeps {
  catalog: CatalogService;
  rawStorage: Storage;
  hlsStorage: Storage;
  runHls: (inputPath: string, outDir: string, rung: Rung) => Promise<void>;
  probe: (filePath: string) => Promise<ProbeResult>;
}

/** Content types for the HLS artifacts (spec §5 table). */
export function contentTypeFor(filename: string): string {
  if (filename.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (filename.endsWith(".m4s")) return "video/iso.segment";
  return "video/mp4"; // init.mp4
}

export async function processTranscodeJob(
  data: TranscodeJobData,
  deps: TranscodeJobDeps,
): Promise<void> {
  const { videoId } = data;
  const { catalog, rawStorage, hlsStorage, runHls, probe } = deps;

  const video = await catalog.getVideo(videoId);
  if (!video) {
    // Nothing to transcode and retrying cannot change that — straight to failed (doc 09 §4).
    throw new UnrecoverableError(`video ${videoId} not found in catalog`);
  }

  await catalog.updateStatus(videoId, "transcoding");

  const tmp = await mkdtemp(join(tmpdir(), "sf-transcode-"));
  try {
    const inputPath = join(tmp, "original.mp4");
    await rawStorage.getObjectToFile(video.storageKey, inputPath);

    // Probe-null height → selectRungs throws a NORMAL Error: retry, then 'failed'.
    // (If ffprobe can't read it, ffmpeg can't transcode it — but a transient fs/probe
    // hiccup deserves its retries, unlike the missing-video case above.)
    const source = await probe(inputPath);
    const rungs = selectRungs(source.height);

    const entries: MasterEntry[] = [];
    for (const rung of rungs) {
      const outDir = join(tmp, rung.label);
      await mkdir(outDir);
      await runHls(inputPath, outDir, rung);

      for (const file of (await readdir(outDir)).sort()) {
        await hlsStorage.putObjectFromFile(
          `${videoId}/${rung.label}/${file}`,
          join(outDir, file),
          contentTypeFor(file),
        );
      }

      // Measure what we actually produced — master states facts, not intentions (spec §4).
      const measured = await probe(join(outDir, HLS_PLAYLIST));
      if (measured.width === null || measured.height === null) {
        throw new Error(`rung ${rung.label}: encoded playlist unprobeable — refusing to guess master RESOLUTION`);
      }
      entries.push({ rung, width: measured.width, height: measured.height, audioCodec: measured.audioCodec });
    }

    // Master LAST — the "ladder complete" artifact (see module doc-comment).
    const masterPath = join(tmp, MASTER_PLAYLIST);
    await writeFile(masterPath, buildMasterPlaylist(entries), "utf8");
    await hlsStorage.putObjectFromFile(
      `${videoId}/${MASTER_PLAYLIST}`,
      masterPath,
      contentTypeFor(MASTER_PLAYLIST),
    );

    // Only after EVERY artifact is uploaded (see module doc-comment).
    await catalog.updateStatus(videoId, "ready");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
