import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { createTranscodeProducer, TRANSCODE_QUEUE } from "./transcode.producer.js";
import { redisConnectionOptions } from "../../platform/redis.js";
import { loadConfig } from "../../platform/config.js";

// Integration test against real Redis: the jobId-based dedupe is a broker behavior, not
// ours — so we prove it against the real broker, not a fake (verify-don't-assert).
test("enqueue is deduped by videoId: enqueueing twice yields one job", async () => {
  const connection = redisConnectionOptions(loadConfig());
  const producer = createTranscodeProducer(connection);
  const inspect = new Queue(TRANSCODE_QUEUE, { connection });
  const videoId = randomUUID();

  try {
    await producer.enqueue(videoId);
    const countAfterFirst = await inspect.count();
    await producer.enqueue(videoId);
    const countAfterSecond = await inspect.count();

    assert.ok(await inspect.getJob(videoId), "job exists under its videoId");
    assert.equal(countAfterSecond, countAfterFirst, "second enqueue must be a no-op");
  } finally {
    await (await inspect.getJob(videoId))?.remove();
    await producer.close();
    await inspect.close();
  }
});
