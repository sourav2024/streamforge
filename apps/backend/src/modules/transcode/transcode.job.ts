/**
 * The transcode job handler — pure orchestration, every effect injected (same testability
 * discipline as upload.service). Runs in the WORKER process (src/worker.ts).
 *
 * IDEMPOTENT BY DESIGN: BullMQ delivers at-least-once (docs/concepts/09-job-queues-bullmq.md
 * §5), so any step may run twice — every step OVERWRITES (fresh temp dir, S3 PUT replaces,
 * status re-set is a no-op), never appends. `ready` is written only after ALL artifacts are
 * uploaded, so a crash mid-upload can never advertise a partial rendition (spec §6).
 */
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnrecoverableError } from "bullmq";
import type { Storage } from "../../platform/storage.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import type { TranscodeJobData } from "./transcode.producer.js";

export interface TranscodeJobDeps {
  catalog: CatalogService;
  rawStorage: Storage;
  hlsStorage: Storage;
  runHls: (inputPath: string, outDir: string) => Promise<void>;
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
  const { catalog, rawStorage, hlsStorage, runHls } = deps;

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

    const outDir = join(tmp, "out");
    await mkdir(outDir);
    await runHls(inputPath, outDir);

    for (const file of (await readdir(outDir)).sort()) {
      await hlsStorage.putObjectFromFile(
        `${videoId}/${file}`,
        join(outDir, file),
        contentTypeFor(file),
      );
    }

    // Only after EVERY artifact is uploaded (see module doc-comment).
    await catalog.updateStatus(videoId, "ready");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
