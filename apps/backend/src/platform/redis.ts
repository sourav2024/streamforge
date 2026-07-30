/**
 * Redis connection options for BullMQ (see docs/concepts/09-job-queues-bullmq.md).
 *
 * BullMQ manages its own ioredis clients from plain options; we parse REDIS_URL once here
 * so the queue name is the only Redis detail modules ever see. `maxRetriesPerRequest: null`
 * is a BullMQ requirement: its worker connections issue long-blocking commands, and
 * ioredis's default per-request retry logic would kill them.
 */
import type { Config } from "./config.js";

export interface RedisConnectionOptions {
  host: string;
  port: number;
  maxRetriesPerRequest: null;
}

export function redisConnectionOptions(config: Config): RedisConnectionOptions {
  const url = new URL(config.redisUrl);
  return {
    host: url.hostname,
    port: url.port === "" ? 6379 : Number(url.port),
    maxRetriesPerRequest: null,
  };
}
