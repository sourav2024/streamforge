/**
 * WORKER process entry point — the second composition root (Phase 1 #3 spec §4).
 *
 * Same codebase, separate process: FFmpeg is CPU-bound and must not compete with the API's
 * event loop. That this file can wire the same platform/ + modules/ for a different host is
 * the modular monolith's extraction path made concrete (docs/concepts/02 §4) — scaling out
 * later means running MORE of these processes, zero code changes (doc 09 §6).
 *
 * Logging is plain console for now (no Fastify here); pino unification is deferred.
 */
import { Worker, UnrecoverableError } from "bullmq";
import { loadConfig } from "./platform/config.js";
import { createPool } from "./platform/db.js";
import { createStorage } from "./platform/storage.js";
import { redisConnectionOptions } from "./platform/redis.js";
import { createCatalogRepository, createCatalogService } from "./modules/catalog/index.js";
import {
  TRANSCODE_QUEUE,
  processTranscodeJob,
  runFfmpegHls,
} from "./modules/transcode/index.js";
import type { TranscodeJobData } from "./modules/transcode/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const rawStorage = createStorage(config, config.s3.bucketRaw);
  const hlsStorage = createStorage(config, config.s3.bucketHls);
  await hlsStorage.ensureBucket();
  const catalog = createCatalogService(createCatalogRepository(pool));

  const worker = new Worker<TranscodeJobData>(
    TRANSCODE_QUEUE,
    (job) => processTranscodeJob(job.data, { catalog, rawStorage, hlsStorage, runHls: runFfmpegHls }),
    {
      connection: redisConnectionOptions(config),
      // FFmpeg already saturates all cores for a single encode; parallel jobs would only
      // thrash each other (doc 09 §6). Scale = more worker processes, not more concurrency.
      concurrency: 1,
    },
  );

  worker.on("active", (job) => {
    console.log(`[worker] job ${job.id} attempt ${job.attemptsMade + 1} started`);
  });
  worker.on("completed", (job) => {
    console.log(`[worker] job ${job.id} completed`);
  });
  worker.on("failed", (job, err) => {
    const attempts = job?.opts.attempts ?? 1;
    console.error(
      `[worker] job ${job?.id} attempt ${job?.attemptsMade}/${attempts} failed: ${err.message}`,
    );
    // Mark the row 'failed' ONLY when no retry will follow (spec §6): the final attempt,
    // or an UnrecoverableError (which BullMQ fails immediately regardless of attempts).
    if (job && (job.attemptsMade >= attempts || err instanceof UnrecoverableError)) {
      catalog
        .updateStatus(job.data.videoId, "failed")
        .catch((e: unknown) => console.error("[worker] could not mark video failed:", e));
    }
  });

  // Graceful shutdown: close() waits for the in-flight job — a deploy must not burn a
  // retry attempt (or, on the last attempt, falsely fail a video) by killing an encode.
  const shutdown = (): void => {
    console.log("[worker] shutting down (draining in-flight job)");
    worker
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error("[worker] error during shutdown:", err);
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`[worker] listening on queue "${TRANSCODE_QUEUE}" (concurrency 1)`);
}

void main();
