/**
 * Upload orchestration (spec §4 + §6). Pure of HTTP/multipart concerns — the route hands us
 * a temp file path. Order: upload to MinIO -> probe -> record in catalog.
 *
 * This is a small ORCHESTRATION-STYLE SAGA: MinIO and Postgres have no shared transaction, so
 * on a catalog-write failure we run a COMPENSATING DELETE (undo the object PUT) and rethrow the
 * original error — never leave an orphaned object behind a failed DB write. Delete is best-effort
 * and safe to run blindly because S3 delete is idempotent (see docs/concepts/05-object-storage).
 * NOTE: this covers the case where step 3 *fails*; it does NOT cover a process *crash* between
 * PUT and INSERT — that orphan case is handled later by a background sweeper (spec §6).
 *
 * This module NEVER touches the videos table — it calls catalog.createVideo (boundary rule,
 * docs/concepts/02-why-modular-monolith.md §3).
 */
import { randomUUID } from "node:crypto";
import type { Storage } from "../../platform/storage.js";
import type { ProbeResult } from "../../platform/ffprobe.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import type { TranscodeProducer } from "../transcode/index.js";
import type { Video } from "@streamforge/contracts";

export interface IngestArgs {
  tempPath: string;
  title: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadService {
  ingest(args: IngestArgs): Promise<Video>;
}

export function createUploadService(deps: {
  storage: Storage;
  catalog: CatalogService;
  probe: (filePath: string) => Promise<ProbeResult>;
  transcode: Pick<TranscodeProducer, "enqueue">;
}): UploadService {
  const { storage, catalog, probe, transcode } = deps;
  return {
    async ingest({ tempPath, title, contentType, sizeBytes }) {
      const id = randomUUID();
      const storageKey = `${id}/original.mp4`;

      await storage.putObjectFromFile(storageKey, tempPath, contentType);

      // Probe is non-fatal (spec §6): probeVideo itself never throws, but guard anyway.
      const meta = await probe(tempPath);

      let video: Video;
      try {
        video = await catalog.createVideo({
          id, title, storageKey, sizeBytes, contentType,
          durationSeconds: meta.durationSeconds,
          width: meta.width,
          height: meta.height,
          videoCodec: meta.videoCodec,
        });
      } catch (err) {
        // Compensating delete: don't leave an orphaned object behind a failed DB write.
        await storage.deleteObject(storageKey).catch(() => { /* best effort; noted in doc 05 */ });
        throw err;
      }

      // Enqueue the transcode job. NON-FATAL (Phase 1 #3 spec §6): the upload is already
      // durable (object + row), and a broker blip must not fail it. The cost is a video
      // stuck at 'uploaded' until re-enqueued — the transactional-outbox gap, deferred to
      // hardening alongside the sweeper (docs/concepts/09-job-queues-bullmq.md §8).
      try {
        await transcode.enqueue(video.id);
      } catch {
        /* stuck-at-uploaded; recoverable by re-enqueue */
      }

      return video;
    },
  };
}
