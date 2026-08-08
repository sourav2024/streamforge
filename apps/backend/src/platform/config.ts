/**
 * Configuration — read once, from the environment, at startup.
 *
 * `platform/` holds cross-cutting infrastructure concerns (config, db client, redis,
 * logger) that modules depend on but that belong to no single module. See
 * docs/concepts/02-why-modular-monolith.md §3.
 *
 * We read env vars here (not scattered through the code) so there is one place that
 * documents every knob the backend has. Phase 0 only needs HOST/PORT; Postgres/Redis/MinIO
 * connection config joins this file when those modules land in Phase 1.
 */

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Env var ${name} must be an integer, got: ${raw}`);
  }
  return n;
}

export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketRaw: string;
  bucketHls: string;
  forcePathStyle: boolean;
}

export interface PlaybackConfig {
  /** HMAC secret for playback tokens (doc 11 §6). Required — fail-fast, like S3 creds. */
  tokenSecret: string;
  /** Playback URL lifetime. Default 6h: long enough to watch, short enough to bound a leak. */
  tokenTtlSeconds: number;
}

export interface Config {
  host: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  redisUrl: string;
  uploadMaxBytes: number;
  s3: S3Config;
  playback: PlaybackConfig;
}

/**
 * Read a mandatory env var, or crash at startup. Fail-fast: config with no safe default
 * (secrets, connection endpoints) must be present before the process serves traffic —
 * a clear error at boot beats a mysterious failure inside a request handler later.
 */
function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Required env var ${name} is not set`);
  }
  return v;
}

export function loadConfig(): Config {
  return {
    host: process.env.HOST ?? "0.0.0.0",
    port: readInt("PORT", 3000),
    nodeEnv: process.env.NODE_ENV ?? "development",
    databaseUrl: required("DATABASE_URL"),
    redisUrl: required("REDIS_URL"),
    uploadMaxBytes: readInt("UPLOAD_MAX_BYTES", 524_288_000),
    s3: {
      endpoint: required("S3_ENDPOINT"),
      region: process.env.S3_REGION ?? "us-east-1",
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      bucketRaw: process.env.S3_BUCKET_RAW ?? "streamforge-raw",
      bucketHls: process.env.S3_BUCKET_HLS ?? "streamforge-hls",
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
    },
    playback: {
      tokenSecret: required("PLAYBACK_TOKEN_SECRET"),
      tokenTtlSeconds: readInt("PLAYBACK_TOKEN_TTL_SECONDS", 21_600),
    },
  };
}
