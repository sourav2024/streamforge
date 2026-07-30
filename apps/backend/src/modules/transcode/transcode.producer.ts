/**
 * Producer half of the transcode module: turn "this video needs transcoding" into a durable
 * BullMQ job (docs/concepts/09-job-queues-bullmq.md §2). Called by the upload module via
 * this module's index.ts only (boundary rule). The consumer half lives in transcode.job.ts
 * and runs in the WORKER process (src/worker.ts).
 */
import { Queue } from "bullmq";
import type { RedisConnectionOptions } from "../../platform/redis.js";

export const TRANSCODE_QUEUE = "transcode";

export interface TranscodeJobData {
  videoId: string;
}

export interface TranscodeProducer {
  enqueue(videoId: string): Promise<void>;
  close(): Promise<void>;
}

export function createTranscodeProducer(
  connection: RedisConnectionOptions,
): TranscodeProducer {
  const queue = new Queue<TranscodeJobData>(TRANSCODE_QUEUE, { connection });
  return {
    async enqueue(videoId) {
      await queue.add(
        "transcode-video",
        { videoId },
        {
          // Our own jobId makes duplicate enqueues for the same video a no-op (doc 09 §4).
          jobId: videoId,
          // Retries paper over TRANSIENT faults; backoff stops a hot-failing job from
          // hammering the system (5s, 10s, 20s). Final failure marks the row 'failed'.
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          // Redis is memory: drop completed jobs, keep failed ones for inspection.
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    },
    close: () => queue.close(),
  };
}
