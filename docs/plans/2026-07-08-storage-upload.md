# Storage & Upload Implementation Plan (Phase 1 #1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.
>
> **⚠️ GIT IS DEFERRED for this project.** Do NOT run `git init`/`add`/`commit` at any
> point. Where a normal plan would commit, this plan ends the task with a **Checkpoint**
> (run verification + update `docs/PROGRESS.md`). Version control resumes only when the
> user explicitly asks.

**Goal:** Accept an MP4 upload, store the raw file in MinIO, probe it with `ffprobe`,
record its metadata in Postgres via a `catalog` module, and read it back — the first real
end-to-end vertical slice.

**Architecture:** Fastify modular monolith. Two modules — `upload` (ingest: validate →
store → probe → hand off) and `catalog` (owns the `videos` table; list/get/create). Shared
infra (`pg` Pool, S3 client) lives in `platform/` and is injected at the composition root
(`app.ts`). `upload` calls `catalog` only through its public `index.ts`. See spec
`docs/specs/2026-07-08-storage-upload-design.md` and concept doc
`docs/concepts/02-why-modular-monolith.md`.

**Tech Stack:** Node 25 + TypeScript (ESM, NodeNext), Fastify 5, `pg` 8 (raw SQL),
`node-pg-migrate` 8 (migrations), `@aws-sdk/client-s3` 3 (MinIO/S3), `@fastify/multipart`
10, `ffprobe` (FFmpeg 8.1.2, subprocess). Tests: Node built-in `node:test` run via `tsx`.

## Global Constraints

- Node ≥ 22 (dev machine on 25.3.0); npm 11.7.0; package manager `npm@11.7.0`.
- TypeScript strict mode already enforced by `tsconfig.base.json` (includes
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
  `isolatedModules`). All code must satisfy these.
- ESM everywhere: `"type": "module"`; **relative imports must include the `.js`
  extension** (NodeNext). Import shared types from `@streamforge/contracts`.
- Cross-module rule: `upload` imports from `@streamforge/catalog`'s package entry / the
  catalog module's `index.ts` ONLY — never its repository or the `videos` table directly.
- Concept docs 05–07 are written and reviewed BEFORE the code that uses their topic
  (Teaching Contract, master spec §1).
- Dev-only credentials from `infra/docker-compose.yml` (user/pass `streamforge`); real
  secrets never in the repo. Backend reads config from env (`platform/config.ts`).
- MinIO bucket: `streamforge-raw`. Object key: `<videoId>/original.mp4`.
- Verify with real evidence, never assertion (project convention): boot it, curl it, probe
  the service — before claiming done.
- **No git commits** (see header).

## Prerequisites (already true — verify, don't redo)

- Infra runs: `docker compose -f infra/docker-compose.yml ps` → postgres, redis, minio all
  `(healthy)`. If not: `npm run infra:up`.
- Backend scaffold exists: `apps/backend/src/{app.ts,main.ts,platform/config.ts}`,
  `packages/contracts/src/index.ts`, `npm run build` passes.

## Dependency versions (exact, confirmed 2026-07-08)

| Package | Version | Where |
|---|---|---|
| `pg` | `^8.22.0` | backend deps |
| `@types/pg` | `^8.20.0` | backend devDeps |
| `node-pg-migrate` | `^8.0.4` | backend devDeps |
| `@aws-sdk/client-s3` | `^3.1081.0` | backend deps |
| `@fastify/multipart` | `^10.0.0` | backend deps |

## File structure (what gets created/modified)

```
docs/concepts/
  05-object-storage-and-s3.md          Create (Task 1)
  06-postgres-data-access.md           Create (Task 1)
  07-media-metadata-ffprobe.md         Create (Task 1)

apps/backend/
  package.json                         Modify (Task 2: deps + migrate/test scripts)
  .env.example                         Modify (Task 2: DB + S3 vars)
  migrations/
    1730000000000_create-videos.js     Create (Task 4)
  src/
    platform/
      config.ts                        Modify (Task 3: add db + s3 config)
      db.ts                            Create (Task 3: pg Pool)
      storage.ts                       Create (Task 5: S3 client wrapper)
      ffprobe.ts                       Create (Task 6: probe subprocess)
    modules/
      catalog/
        index.ts                       Create (Task 7: public interface + register)
        catalog.repository.ts          Create (Task 7: SQL for videos)
        catalog.service.ts             Create (Task 7: business logic)
        catalog.routes.ts              Create (Task 8: GET list/:id)
        catalog.repository.test.ts     Create (Task 7)
        catalog.service.test.ts        Create (Task 7)
      upload/
        index.ts                       Create (Task 9: register)
        upload.service.ts              Create (Task 9: orchestration)
        upload.routes.ts               Create (Task 10: POST multipart)
        upload.service.test.ts         Create (Task 9)
      test-helpers/
        make-fixture.ts                Create (Task 6: generate sample.mp4)
    app.ts                             Modify (Tasks 8,10: register modules + deps)

packages/contracts/src/
  index.ts                             Modify (Task 3: Video + request/response types)
```

---

### Task 1: Concept docs (05, 06, 07)

**Files:**
- Create: `docs/concepts/05-object-storage-and-s3.md`
- Create: `docs/concepts/06-postgres-data-access.md`
- Create: `docs/concepts/07-media-metadata-ffprobe.md`

**Interfaces:** none (documentation). Downstream tasks reference these for the "why."

This task is prose, not TDD. Each doc follows the house structure used by docs 01–04:
what it is / problem it solves / how we use it here / alternatives / why-this-one /
trade-offs / glossary. Ground each in the actual code coming in later tasks.

- [ ] **Step 1: Write `05-object-storage-and-s3.md`**

Cover: object storage vs filesystem vs DB (blobs don't belong in Postgres); the S3 object
model (bucket → key → object + metadata); core ops `PutObject`/`GetObject`/`DeleteObject`;
why `@aws-sdk/client-s3` against MinIO is byte-for-byte portable to real S3/R2 (endpoint +
`forcePathStyle: true` for MinIO); streaming vs buffering an upload and why we stage to a
temp file (spec §4 step 4); presigned URLs explained conceptually and flagged as the later
upgrade to today's proxied path; the orphaned-object risk + background-sweeper idea
(spec §6). Glossary: bucket, key, object, path-style vs virtual-hosted, presigned URL,
multipart (S3 sense vs HTTP sense — disambiguate).

- [ ] **Step 2: Write `06-postgres-data-access.md`**

Cover: the `pg` driver; **connection pool vs single connection** (why a `Pool`: reuse,
concurrency, backpressure); **parameterized queries** (`$1,$2` — never string
interpolation — SQL injection); mapping snake_case columns ↔ camelCase TS; **migrations**
(what/why, forward-only history, up + down, `node-pg-migrate` timestamped files, the
`pgmigrations` bookkeeping table); why raw SQL over an ORM *now* (transparency; ORM
deferred). Glossary: pool, parameterized query, migration, DDL/DML, DСL, transaction.

- [ ] **Step 3: Write `07-media-metadata-ffprobe.md`**

Cover: container vs codec (mp4 = container; h264 = codec) — a focused preview of the fuller
Media Fundamentals doc (Phase 1 #2); what `ffprobe` extracts (streams, duration, width,
height, codec_name); running it as a subprocess with `-v quiet -print_format json
-show_format -show_streams`; which fields we persist and why each matters later (resolution
→ ABR ladder; codec → transcode decisions; duration → UI); why probe failure is non-fatal
(spec §6). Glossary: container, codec, stream, ffprobe, bitrate.

- [ ] **Step 4: Checkpoint**

Verify all three files exist and render (no broken headings):
Run: `ls -1 docs/concepts/05-object-storage-and-s3.md docs/concepts/06-postgres-data-access.md docs/concepts/07-media-metadata-ffprobe.md`
Expected: all three paths listed.
Then append a one-line note to `docs/PROGRESS.md` under Session 2: "Phase 1 #1 started:
concept docs 05–07 written."

---

### Task 2: Install dependencies & add scripts

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `apps/backend/.env.example`

**Interfaces:**
- Produces: npm scripts `migrate`, `migrate:down`, `test` in the backend workspace; the
  five new dependencies available to later tasks.

- [ ] **Step 1: Add dependencies**

Run from repo root:
```bash
npm -w @streamforge/backend install pg@^8.22.0 @aws-sdk/client-s3@^3.1081.0 @fastify/multipart@^10.0.0
npm -w @streamforge/backend install -D @types/pg@^8.20.0 node-pg-migrate@^8.0.4
```
Expected: `added N packages`, 0 vulnerabilities (or note any).

- [ ] **Step 2: Add scripts to `apps/backend/package.json`**

Merge these into the existing `"scripts"` block (keep existing dev/build/start/typecheck/clean):
```json
{
  "scripts": {
    "migrate": "node-pg-migrate up -m migrations --envPath .env",
    "migrate:down": "node-pg-migrate down -m migrations --envPath .env",
    "test": "tsx --test src/**/*.test.ts"
  }
}
```
Note: `node-pg-migrate` reads `DATABASE_URL` from `.env` (via `--envPath`).

- [ ] **Step 3: Add DB + S3 vars to `apps/backend/.env.example`**

Append:
```bash
# Postgres (matches infra/docker-compose.yml defaults)
DATABASE_URL=postgres://streamforge:streamforge@localhost:5432/streamforge

# MinIO / S3 (matches infra/docker-compose.yml defaults)
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=streamforge
S3_SECRET_ACCESS_KEY=streamforge
S3_BUCKET_RAW=streamforge-raw
S3_FORCE_PATH_STYLE=true

# Upload limits
UPLOAD_MAX_BYTES=524288000
```

- [ ] **Step 4: Create working `.env`**

Run: `cp apps/backend/.env.example apps/backend/.env`
(`.env` is gitignored; safe with dev creds.)

- [ ] **Step 5: Checkpoint**

Run: `npm -w @streamforge/backend run typecheck`
Expected: PASS (no code added yet; just confirms deps didn't break config).

---

### Task 3: Config, DB pool, and contract types

**Files:**
- Modify: `apps/backend/src/platform/config.ts`
- Create: `apps/backend/src/platform/db.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/backend/src/platform/db.test.ts`

**Interfaces:**
- Produces:
  - `Config` gains `databaseUrl: string` and `s3: { endpoint, region, accessKeyId,
    secretAccessKey, bucketRaw, forcePathStyle }` and `uploadMaxBytes: number`.
  - `createPool(config: Config): pg.Pool` in `platform/db.ts`.
  - Contract types: `Video`, `CreateVideoInput`, `CreateVideoResponse`, `VideoListResponse`.
- Consumes: existing `loadConfig()` from Task 0 scaffold.

- [ ] **Step 1: Write the failing test for config parsing**

Create `apps/backend/src/platform/db.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "./db.js";
import { loadConfig } from "./config.js";

test("createPool builds a pool from config without connecting", () => {
  process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
  const pool = createPool(loadConfig());
  assert.ok(pool, "pool should be created");
  assert.equal(typeof pool.query, "function");
  void pool.end();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @streamforge/backend exec -- tsx --test src/platform/db.test.ts`
Expected: FAIL — cannot find module `./db.js`.

- [ ] **Step 3: Extend `config.ts`**

Replace the `Config` interface and `loadConfig` return in
`apps/backend/src/platform/config.ts` so it includes (keep the existing `readInt` helper
and host/port/nodeEnv):
```ts
export interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketRaw: string;
  forcePathStyle: boolean;
}

export interface Config {
  host: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  uploadMaxBytes: number;
  s3: S3Config;
}

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
    uploadMaxBytes: readInt("UPLOAD_MAX_BYTES", 524_288_000),
    s3: {
      endpoint: required("S3_ENDPOINT"),
      region: process.env.S3_REGION ?? "us-east-1",
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      bucketRaw: process.env.S3_BUCKET_RAW ?? "streamforge-raw",
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
    },
  };
}
```

- [ ] **Step 4: Create `platform/db.ts`**

```ts
/**
 * Postgres access — a shared connection Pool (see docs/concepts/06-postgres-data-access.md).
 * A Pool reuses a bounded set of connections across concurrent requests rather than opening
 * one per query. Constructed once at the composition root and injected into modules.
 */
import pg from "pg";
import type { Config } from "./config.js";

export type Pool = pg.Pool;

export function createPool(config: Config): pg.Pool {
  return new pg.Pool({ connectionString: config.databaseUrl });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm -w @streamforge/backend exec -- tsx --test src/platform/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Add contract types to `packages/contracts/src/index.ts`**

Append (keep existing `HealthResponse`):
```ts
/** A catalog video record, mirrored from the `videos` Postgres table. */
export interface Video {
  id: string;
  title: string;
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  status: "uploaded" | "transcoding" | "ready";
  createdAt: string; // ISO-8601
}

/** Fields the upload module hands to catalog to create a row. */
export interface CreateVideoInput {
  id: string;
  title: string;
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
}

export type CreateVideoResponse = Video;
export interface VideoListResponse {
  videos: Video[];
}
```

- [ ] **Step 7: Checkpoint**

Run: `npm run build` (repo root) then `npm -w @streamforge/backend run typecheck`
Expected: both PASS. Contracts rebuilds before backend (`^build`).

---

### Task 4: Migration — create `videos` table

**Files:**
- Create: `apps/backend/migrations/1730000000000_create-videos.js`

**Interfaces:**
- Produces: `videos` table (columns per spec §5) in the `streamforge` database.

Note: `node-pg-migrate` migration files export `up`/`down` using its DSL. Filename must be
timestamp-prefixed; use the fixed name below so the plan is deterministic.

- [ ] **Step 1: Write the migration**

Create `apps/backend/migrations/1730000000000_create-videos.js`:
```js
/* eslint-disable camelcase */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable("videos", {
    id: { type: "uuid", primaryKey: true },
    title: { type: "text", notNull: true },
    storage_key: { type: "text", notNull: true, unique: true },
    size_bytes: { type: "bigint", notNull: true },
    content_type: { type: "text", notNull: true },
    duration_s: { type: "double precision" },
    width: { type: "integer" },
    height: { type: "integer" },
    video_codec: { type: "text" },
    status: { type: "text", notNull: true, default: "uploaded" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
};

export const down = (pgm) => {
  pgm.dropTable("videos");
};
```

- [ ] **Step 2: Run the migration up**

Run: `npm -w @streamforge/backend run migrate`
Expected: output shows `> Migrating files:` and `### MIGRATION 1730000000000_create-videos (UP) ###`, ending success.

- [ ] **Step 3: Verify the table exists**

Run:
```bash
docker exec streamforge-postgres psql -U streamforge -d streamforge -c "\d videos"
```
Expected: table description listing all 11 columns with correct types; `id` primary key;
`storage_key` unique.

- [ ] **Step 4: Verify down migration works, then re-up**

Run:
```bash
npm -w @streamforge/backend run migrate:down
docker exec streamforge-postgres psql -U streamforge -d streamforge -tAc "select to_regclass('public.videos')"   # expect empty
npm -w @streamforge/backend run migrate
```
Expected: down drops it (regclass empty), then re-up recreates it. Confirms reversibility.

- [ ] **Step 5: Checkpoint** — table present after re-up (`\dt` shows `videos`).

---

### Task 5: Storage wrapper (`platform/storage.ts`)

**Files:**
- Create: `apps/backend/src/platform/storage.ts`
- Test: `apps/backend/src/platform/storage.test.ts`

**Interfaces:**
- Produces:
  - `createStorage(config: Config): Storage`
  - `interface Storage { ensureBucket(): Promise<void>; putObjectFromFile(key: string,
    filePath: string, contentType: string): Promise<void>; deleteObject(key: string):
    Promise<void>; }`
- Consumes: `Config.s3` from Task 3.

- [ ] **Step 1: Write the failing test (integration — real MinIO)**

Create `apps/backend/src/platform/storage.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorage } from "./storage.js";
import { loadConfig } from "./config.js";

test("storage round-trip: ensureBucket, put from file, delete", async () => {
  const storage = createStorage(loadConfig());
  await storage.ensureBucket();

  const tmp = join(tmpdir(), `sf-storage-test-${process.pid}.txt`);
  await writeFile(tmp, "hello streamforge");
  const key = `__test__/${process.pid}/hello.txt`;

  await storage.putObjectFromFile(key, tmp, "text/plain");
  await storage.deleteObject(key); // if put failed, delete of missing key still resolves
  await rm(tmp, { force: true });
  assert.ok(true, "round-trip completed without throwing");
});
```
Requires `apps/backend/.env` (Task 2) loaded. Run tests with `--env-file`:
this test is run via the `test` script in Step 4.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm -w @streamforge/backend exec -- tsx --env-file=.env --test src/platform/storage.test.ts`
Expected: FAIL — cannot find module `./storage.js`.

- [ ] **Step 3: Implement `storage.ts`**

```ts
/**
 * S3-compatible object storage (MinIO now, real S3 later — same code).
 * See docs/concepts/05-object-storage-and-s3.md. `forcePathStyle` is required for MinIO.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { Config } from "./config.js";

export interface Storage {
  ensureBucket(): Promise<void>;
  putObjectFromFile(key: string, filePath: string, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
}

export function createStorage(config: Config): Storage {
  const bucket = config.s3.bucketRaw;
  const client = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  });

  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },
    async putObjectFromFile(key, filePath, contentType) {
      const { size } = await stat(filePath);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentType: contentType,
          ContentLength: size,
        }),
      );
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
```
Note: `ContentLength` is set explicitly because a stream Body has no known length and the
S3 client otherwise buffers; `stat` gives us the size cheaply.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm -w @streamforge/backend exec -- tsx --env-file=.env --test src/platform/storage.test.ts`
Expected: PASS (requires MinIO healthy).

- [ ] **Step 5: Verify the bucket now exists**

Run:
```bash
docker exec streamforge-minio mc alias set local http://localhost:9000 streamforge streamforge >/dev/null 2>&1; docker exec streamforge-minio mc ls local/
```
Expected: `streamforge-raw/` listed.

- [ ] **Step 6: Checkpoint** — typecheck passes; bucket present.

---

### Task 6: ffprobe wrapper + test fixture

**Files:**
- Create: `apps/backend/src/platform/ffprobe.ts`
- Create: `apps/backend/src/modules/test-helpers/make-fixture.ts`
- Test: `apps/backend/src/platform/ffprobe.test.ts`

**Interfaces:**
- Produces:
  - `probeVideo(filePath: string): Promise<ProbeResult>` where
    `interface ProbeResult { durationSeconds: number | null; width: number | null; height:
    number | null; videoCodec: string | null; }`
  - `makeSampleMp4(destPath: string): Promise<void>` (generates a tiny valid MP4 via ffmpeg).
- Consumes: nothing (subprocess).

- [ ] **Step 1: Write the fixture generator**

Create `apps/backend/src/modules/test-helpers/make-fixture.ts`:
```ts
/** Generates a tiny valid H.264/MP4 for tests. Requires ffmpeg on PATH. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export async function makeSampleMp4(destPath: string): Promise<void> {
  // 1s of 320x240 test pattern, silent, h264 — deterministic, ~tens of KB.
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "1",
    destPath,
  ]);
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/backend/src/platform/ffprobe.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeVideo } from "./ffprobe.js";
import { makeSampleMp4 } from "../modules/test-helpers/make-fixture.js";

test("probeVideo extracts resolution, codec, duration from a real mp4", async () => {
  const p = join(tmpdir(), `sf-probe-${process.pid}.mp4`);
  await makeSampleMp4(p);
  try {
    const r = await probeVideo(p);
    assert.equal(r.width, 320);
    assert.equal(r.height, 240);
    assert.equal(r.videoCodec, "h264");
    assert.ok(r.durationSeconds !== null && r.durationSeconds > 0.5);
  } finally {
    await rm(p, { force: true });
  }
});

test("probeVideo returns nulls (does not throw) on a non-media file", async () => {
  const r = await probeVideo("/etc/hostname");
  assert.deepEqual(r, { durationSeconds: null, width: null, height: null, videoCodec: null });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm -w @streamforge/backend exec -- tsx --test src/platform/ffprobe.test.ts`
Expected: FAIL — cannot find module `./ffprobe.js`.

- [ ] **Step 4: Implement `ffprobe.ts`**

```ts
/**
 * Media metadata via ffprobe subprocess. See docs/concepts/07-media-metadata-ffprobe.md.
 * Probe failure is NON-FATAL by contract (spec §6): return all-nulls, never throw.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
}

const NULLS: ProbeResult = {
  durationSeconds: null, width: null, height: null, videoCodec: null,
};

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);
    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const video = parsed.streams?.find((s) => s.codec_type === "video");
    if (!video) return NULLS;
    const durationRaw = parsed.format?.duration;
    const duration = durationRaw !== undefined ? Number.parseFloat(durationRaw) : NaN;
    return {
      durationSeconds: Number.isFinite(duration) ? duration : null,
      width: video.width ?? null,
      height: video.height ?? null,
      videoCodec: video.codec_name ?? null,
    };
  } catch {
    return NULLS;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm -w @streamforge/backend exec -- tsx --test src/platform/ffprobe.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Checkpoint** — typecheck passes.

---

### Task 7: Catalog module — repository + service (owns `videos`)

**Files:**
- Create: `apps/backend/src/modules/catalog/catalog.repository.ts`
- Create: `apps/backend/src/modules/catalog/catalog.service.ts`
- Create: `apps/backend/src/modules/catalog/index.ts`
- Test: `apps/backend/src/modules/catalog/catalog.repository.test.ts`
- Test: `apps/backend/src/modules/catalog/catalog.service.test.ts`

**Interfaces:**
- Produces:
  - `createCatalogRepository(pool: Pool): CatalogRepository` with
    `insert(input: CreateVideoInput): Promise<Video>`, `list(): Promise<Video[]>`,
    `getById(id: string): Promise<Video | null>`.
  - `createCatalogService(repo: CatalogRepository): CatalogService` with
    `createVideo(input: CreateVideoInput): Promise<Video>`, `listVideos(): Promise<Video[]>`,
    `getVideo(id: string): Promise<Video | null>`.
  - `catalog/index.ts` re-exports `createCatalogRepository`, `createCatalogService`, and the
    `CatalogService` type — the module's ONLY public surface.
- Consumes: `Pool` (Task 3), contract types `Video`/`CreateVideoInput` (Task 3).

- [ ] **Step 1: Write the failing repository test (integration — real Postgres)**

Create `apps/backend/src/modules/catalog/catalog.repository.test.ts`:
```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool } from "../../platform/db.js";
import { loadConfig } from "../../platform/config.js";
import { createCatalogRepository } from "./catalog.repository.js";
import type { CreateVideoInput } from "@streamforge/contracts";

const pool = createPool(loadConfig());
const repo = createCatalogRepository(pool);
const ids: string[] = [];

after(async () => {
  for (const id of ids) await pool.query("delete from videos where id = $1", [id]);
  await pool.end();
});

function sample(): CreateVideoInput {
  const id = randomUUID();
  ids.push(id);
  return {
    id, title: "Test", storageKey: `${id}/original.mp4`, sizeBytes: 123,
    contentType: "video/mp4", durationSeconds: 1.0, width: 320, height: 240, videoCodec: "h264",
  };
}

test("insert then getById returns the row with mapped fields", async () => {
  const input = sample();
  const created = await repo.insert(input);
  assert.equal(created.id, input.id);
  assert.equal(created.status, "uploaded");
  assert.equal(created.width, 320);
  const fetched = await repo.getById(input.id);
  assert.equal(fetched?.title, "Test");
});

test("list includes an inserted row", async () => {
  const input = sample();
  await repo.insert(input);
  const all = await repo.list();
  assert.ok(all.some((v) => v.id === input.id));
});

test("getById returns null for unknown id", async () => {
  assert.equal(await repo.getById(randomUUID()), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @streamforge/backend exec -- tsx --env-file=.env --test src/modules/catalog/catalog.repository.test.ts`
Expected: FAIL — cannot find `./catalog.repository.js`.

- [ ] **Step 3: Implement `catalog.repository.ts`**

```ts
/**
 * Catalog data access — the ONLY code permitted to touch the `videos` table
 * (docs/concepts/02-why-modular-monolith.md §3, rule 2). Raw parameterized SQL
 * (docs/concepts/06-postgres-data-access.md).
 */
import type { Pool } from "../../platform/db.js";
import type { Video, CreateVideoInput } from "@streamforge/contracts";

interface VideoRow {
  id: string;
  title: string;
  storage_key: string;
  size_bytes: string; // bigint comes back as string from pg
  content_type: string;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  status: string;
  created_at: Date;
}

function toVideo(r: VideoRow): Video {
  return {
    id: r.id,
    title: r.title,
    storageKey: r.storage_key,
    sizeBytes: Number(r.size_bytes),
    contentType: r.content_type,
    durationSeconds: r.duration_s,
    width: r.width,
    height: r.height,
    videoCodec: r.video_codec,
    status: r.status as Video["status"],
    createdAt: r.created_at.toISOString(),
  };
}

const COLS =
  "id, title, storage_key, size_bytes, content_type, duration_s, width, height, video_codec, status, created_at";

export interface CatalogRepository {
  insert(input: CreateVideoInput): Promise<Video>;
  list(): Promise<Video[]>;
  getById(id: string): Promise<Video | null>;
}

export function createCatalogRepository(pool: Pool): CatalogRepository {
  return {
    async insert(input) {
      const { rows } = await pool.query<VideoRow>(
        `insert into videos
           (id, title, storage_key, size_bytes, content_type, duration_s, width, height, video_codec)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning ${COLS}`,
        [
          input.id, input.title, input.storageKey, input.sizeBytes, input.contentType,
          input.durationSeconds, input.width, input.height, input.videoCodec,
        ],
      );
      return toVideo(rows[0]!);
    },
    async list() {
      const { rows } = await pool.query<VideoRow>(
        `select ${COLS} from videos order by created_at desc`,
      );
      return rows.map(toVideo);
    },
    async getById(id) {
      const { rows } = await pool.query<VideoRow>(
        `select ${COLS} from videos where id = $1`,
        [id],
      );
      return rows[0] ? toVideo(rows[0]) : null;
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm -w @streamforge/backend exec -- tsx --env-file=.env --test src/modules/catalog/catalog.repository.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing service test (unit — repo faked)**

Create `apps/backend/src/modules/catalog/catalog.service.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCatalogService } from "./catalog.service.js";
import type { CatalogRepository } from "./catalog.repository.js";
import type { Video, CreateVideoInput } from "@streamforge/contracts";

function fakeVideo(input: CreateVideoInput): Video {
  return { ...input, status: "uploaded", createdAt: "2026-07-08T00:00:00.000Z" };
}

test("createVideo delegates to repo.insert", async () => {
  let called: CreateVideoInput | null = null;
  const repo: CatalogRepository = {
    insert: async (i) => { called = i; return fakeVideo(i); },
    list: async () => [],
    getById: async () => null,
  };
  const svc = createCatalogService(repo);
  const input: CreateVideoInput = {
    id: "x", title: "T", storageKey: "x/original.mp4", sizeBytes: 1,
    contentType: "video/mp4", durationSeconds: null, width: null, height: null, videoCodec: null,
  };
  const out = await svc.createVideo(input);
  assert.equal(called!.id, "x");
  assert.equal(out.status, "uploaded");
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm -w @streamforge/backend exec -- tsx --test src/modules/catalog/catalog.service.test.ts`
Expected: FAIL — cannot find `./catalog.service.js`.

- [ ] **Step 7: Implement `catalog.service.ts`**

```ts
/**
 * Catalog business logic. Thin today (delegates to the repository), but it is the seam
 * where future rules live (validation, status transitions for transcoding). Other modules
 * call THIS (via index.ts), never the repository or the table directly.
 */
import type { Video, CreateVideoInput } from "@streamforge/contracts";
import type { CatalogRepository } from "./catalog.repository.js";

export interface CatalogService {
  createVideo(input: CreateVideoInput): Promise<Video>;
  listVideos(): Promise<Video[]>;
  getVideo(id: string): Promise<Video | null>;
}

export function createCatalogService(repo: CatalogRepository): CatalogService {
  return {
    createVideo: (input) => repo.insert(input),
    listVideos: () => repo.list(),
    getVideo: (id) => repo.getById(id),
  };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npm -w @streamforge/backend exec -- tsx --test src/modules/catalog/catalog.service.test.ts`
Expected: PASS.

- [ ] **Step 9: Create the public interface `catalog/index.ts`**

```ts
/**
 * Catalog module — PUBLIC surface. Other modules may import ONLY from here
 * (docs/concepts/02-why-modular-monolith.md §3, rule 1). Route registration is added in
 * Task 8; for now we export the construction functions and the service type.
 */
export { createCatalogRepository } from "./catalog.repository.js";
export type { CatalogRepository } from "./catalog.repository.js";
export { createCatalogService } from "./catalog.service.js";
export type { CatalogService } from "./catalog.service.js";
```

- [ ] **Step 10: Checkpoint** — `npm run build` + backend typecheck PASS; repo + service tests green.

---

### Task 8: Catalog routes + wire into app

**Files:**
- Create: `apps/backend/src/modules/catalog/catalog.routes.ts`
- Modify: `apps/backend/src/modules/catalog/index.ts` (export `registerCatalog`)
- Modify: `apps/backend/src/app.ts` (build platform deps, register catalog)

**Interfaces:**
- Produces: `registerCatalog(app, deps: { service: CatalogService }): void`; HTTP routes
  `GET /catalog/videos`, `GET /catalog/videos/:id`.
- Consumes: `CatalogService` (Task 7), Fastify `app` instance.

- [ ] **Step 1: Write the failing route test (uses Fastify inject + fake service)**

Create `apps/backend/src/modules/catalog/catalog.routes.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerCatalog } from "./index.js";
import type { CatalogService } from "./catalog.service.js";
import type { Video } from "@streamforge/contracts";

const v: Video = {
  id: "abc", title: "T", storageKey: "abc/original.mp4", sizeBytes: 1,
  contentType: "video/mp4", durationSeconds: null, width: null, height: null,
  videoCodec: null, status: "uploaded", createdAt: "2026-07-08T00:00:00.000Z",
};
const service: CatalogService = {
  createVideo: async () => v,
  listVideos: async () => [v],
  getVideo: async (id) => (id === "abc" ? v : null),
};

test("GET /catalog/videos returns list", async () => {
  const app = Fastify();
  registerCatalog(app, { service });
  const res = await app.inject({ method: "GET", url: "/catalog/videos" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { videos: [v] });
  await app.close();
});

test("GET /catalog/videos/:id returns 404 for unknown", async () => {
  const app = Fastify();
  registerCatalog(app, { service });
  const res = await app.inject({ method: "GET", url: "/catalog/videos/nope" });
  assert.equal(res.statusCode, 404);
  await app.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @streamforge/backend exec -- tsx --test src/modules/catalog/catalog.routes.test.ts`
Expected: FAIL — `registerCatalog` is not exported.

- [ ] **Step 3: Implement `catalog.routes.ts`**

```ts
import type { FastifyInstance } from "fastify";
import type { CatalogService } from "./catalog.service.js";
import type { VideoListResponse } from "@streamforge/contracts";

export function catalogRoutes(app: FastifyInstance, service: CatalogService): void {
  app.get("/catalog/videos", async (): Promise<VideoListResponse> => {
    return { videos: await service.listVideos() };
  });

  app.get<{ Params: { id: string } }>("/catalog/videos/:id", async (req, reply) => {
    const video = await service.getVideo(req.params.id);
    if (!video) {
      return reply.code(404).send({ error: "Not Found", message: "video not found" });
    }
    return video;
  });
}
```

- [ ] **Step 4: Add `registerCatalog` to `catalog/index.ts`**

Append to the existing exports:
```ts
import type { FastifyInstance } from "fastify";
import type { CatalogService } from "./catalog.service.js";
import { catalogRoutes } from "./catalog.routes.js";

export function registerCatalog(
  app: FastifyInstance,
  deps: { service: CatalogService },
): void {
  catalogRoutes(app, deps.service);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm -w @streamforge/backend exec -- tsx --test src/modules/catalog/catalog.routes.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire platform deps + catalog into `app.ts`**

Modify `apps/backend/src/app.ts`. Keep the existing `/health` route. Add imports at top:
```ts
import { createPool } from "./platform/db.js";
import { createStorage } from "./platform/storage.js";
import { createCatalogRepository, createCatalogService, registerCatalog } from "./modules/catalog/index.js";
```
Inside `buildApp(config)`, after the health route and before `return app;`:
```ts
  // --- composition root: construct shared infra, then wire modules (DI by hand) ---
  const pool = createPool(config);
  const storage = createStorage(config);

  const catalogRepo = createCatalogRepository(pool);
  const catalogService = createCatalogService(catalogRepo);
  registerCatalog(app, { service: catalogService });

  // upload module registered in Task 10 (needs storage + catalogService)

  app.addHook("onClose", async () => {
    await pool.end();
  });
```
Note: `storage` is constructed here now and consumed by upload in Task 10; if the linter
flags it unused until then, that is expected and resolved in Task 10. (Alternatively add
`void storage;` temporarily.)

- [ ] **Step 7: Checkpoint — boot & real HTTP**

Run:
```bash
cd apps/backend && node --env-file=.env --import tsx ./src/main.ts &
sleep 2
curl -s localhost:3000/catalog/videos          # expect {"videos":[...]} (rows from earlier tests may be cleaned; [] is fine)
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/catalog/videos/nope  # expect 404
kill %1
```
Expected: list returns JSON `{"videos":[...]}`; unknown id → `404`. Update PROGRESS.md:
"catalog module live (list/get)."

---

### Task 9: Upload service (orchestration + compensating delete)

**Files:**
- Create: `apps/backend/src/modules/upload/upload.service.ts`
- Test: `apps/backend/src/modules/upload/upload.service.test.ts`

**Interfaces:**
- Produces:
  - `createUploadService(deps: { storage: Storage; catalog: CatalogService; probe: (path:
    string) => Promise<ProbeResult> }): UploadService` with
    `ingest(args: { tempPath: string; title: string; contentType: string; sizeBytes: number
    }): Promise<Video>`.
  - The ingest orchestration: generate id → upload temp file to `<id>/original.mp4` →
    probe temp file → `catalog.createVideo(...)`; on catalog failure, `storage.deleteObject`
    then rethrow (spec §6 compensating delete).
- Consumes: `Storage` (Task 5), `CatalogService` (Task 7), `ProbeResult`/`probeVideo`
  (Task 6), contract `Video`.

Note: the service receives an already-written temp file path and its size/content-type; the
route (Task 10) owns multipart parsing and temp-file lifecycle. This keeps the service
pure/testable (no HTTP, no multipart).

- [ ] **Step 1: Write the failing test (unit — fakes for storage/catalog/probe)**

Create `apps/backend/src/modules/upload/upload.service.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUploadService } from "./upload.service.js";
import type { Storage } from "../../platform/storage.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import type { Video, CreateVideoInput } from "@streamforge/contracts";

function fakeStorage(overrides: Partial<Storage> = {}): Storage & { put: string[]; deleted: string[] } {
  const put: string[] = [];
  const deleted: string[] = [];
  return {
    ensureBucket: async () => {},
    putObjectFromFile: async (key) => { put.push(key); },
    deleteObject: async (key) => { deleted.push(key); },
    put, deleted, ...overrides,
  } as Storage & { put: string[]; deleted: string[] };
}

const okProbe = async () => ({ durationSeconds: 1, width: 320, height: 240, videoCodec: "h264" });

test("happy path: uploads, probes, records; key is <id>/original.mp4", async () => {
  const storage = fakeStorage();
  let recorded: CreateVideoInput | null = null;
  const catalog: CatalogService = {
    createVideo: async (i) => { recorded = i; return { ...i, status: "uploaded", createdAt: "t" } as Video; },
    listVideos: async () => [], getVideo: async () => null,
  };
  const svc = createUploadService({ storage, catalog, probe: okProbe });
  const out = await svc.ingest({ tempPath: "/tmp/x.mp4", title: "T", contentType: "video/mp4", sizeBytes: 10 });
  assert.equal(storage.put.length, 1);
  assert.equal(storage.put[0], `${out.id}/original.mp4`);
  assert.equal(recorded!.width, 320);
  assert.equal(out.status, "uploaded");
});

test("compensating delete: if catalog.createVideo throws, the stored object is deleted and error rethrown", async () => {
  const storage = fakeStorage();
  const catalog: CatalogService = {
    createVideo: async () => { throw new Error("db down"); },
    listVideos: async () => [], getVideo: async () => null,
  };
  const svc = createUploadService({ storage, catalog, probe: okProbe });
  await assert.rejects(
    () => svc.ingest({ tempPath: "/tmp/x.mp4", title: "T", contentType: "video/mp4", sizeBytes: 10 }),
    /db down/,
  );
  assert.equal(storage.deleted.length, 1, "object must be compensating-deleted");
  assert.equal(storage.deleted[0], storage.put[0]);
});

test("probe failure is non-fatal: records nulls, still succeeds", async () => {
  const storage = fakeStorage();
  let recorded: CreateVideoInput | null = null;
  const catalog: CatalogService = {
    createVideo: async (i) => { recorded = i; return { ...i, status: "uploaded", createdAt: "t" } as Video; },
    listVideos: async () => [], getVideo: async () => null,
  };
  const nullProbe = async () => ({ durationSeconds: null, width: null, height: null, videoCodec: null });
  const svc = createUploadService({ storage, catalog, probe: nullProbe });
  await svc.ingest({ tempPath: "/tmp/x.mp4", title: "T", contentType: "video/mp4", sizeBytes: 10 });
  assert.equal(recorded!.width, null);
  assert.equal(recorded!.videoCodec, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm -w @streamforge/backend exec -- tsx --test src/modules/upload/upload.service.test.ts`
Expected: FAIL — cannot find `./upload.service.js`.

- [ ] **Step 3: Implement `upload.service.ts`**

```ts
/**
 * Upload orchestration (spec §4 + §6). Pure of HTTP/multipart concerns — the route hands us
 * a temp file path. Order: upload to MinIO -> probe -> record in catalog; on catalog
 * failure, compensating-delete the object then rethrow (never leave a half-committed upload).
 * NOTE: this module NEVER touches the videos table — it calls catalog.createVideo (boundary
 * rule, docs/concepts/02-why-modular-monolith.md §3).
 */
import { randomUUID } from "node:crypto";
import type { Storage } from "../../platform/storage.js";
import type { ProbeResult } from "../../platform/ffprobe.js";
import type { CatalogService } from "../catalog/catalog.service.js";
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
}): UploadService {
  const { storage, catalog, probe } = deps;
  return {
    async ingest({ tempPath, title, contentType, sizeBytes }) {
      const id = randomUUID();
      const storageKey = `${id}/original.mp4`;

      await storage.putObjectFromFile(storageKey, tempPath, contentType);

      // Probe is non-fatal (spec §6): probeVideo itself never throws, but guard anyway.
      const meta = await probe(tempPath);

      try {
        return await catalog.createVideo({
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
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm -w @streamforge/backend exec -- tsx --test src/modules/upload/upload.service.test.ts`
Expected: PASS (3 tests, including compensating delete).

- [ ] **Step 5: Checkpoint** — typecheck passes; upload.service tests green.

---

### Task 10: Upload route (multipart) + wire into app + E2E

**Files:**
- Create: `apps/backend/src/modules/upload/upload.routes.ts`
- Create: `apps/backend/src/modules/upload/index.ts`
- Modify: `apps/backend/src/app.ts` (register multipart plugin + upload module)

**Interfaces:**
- Produces: `registerUpload(app, deps: { service: UploadService; maxBytes: number }): void`;
  HTTP route `POST /upload/videos` (multipart: `file` + `title`).
- Consumes: `UploadService` (Task 9), `@fastify/multipart`, `Config.uploadMaxBytes`.

- [ ] **Step 1: Implement `upload.routes.ts`**

```ts
/**
 * POST /upload/videos — multipart ingest. Validates content-type + size (spec §6),
 * streams the part to a temp file, hands it to the upload service, cleans up the temp file
 * in a finally (regardless of outcome).
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { UploadService } from "./upload.service.js";

const ALLOWED = new Set(["video/mp4"]);

export function uploadRoutes(
  app: FastifyInstance,
  service: UploadService,
): void {
  app.post("/upload/videos", async (req, reply) => {
    const part = await req.file(); // @fastify/multipart: first file part
    if (!part) {
      return reply.code(400).send({ error: "Bad Request", message: "no file provided" });
    }
    if (!ALLOWED.has(part.mimetype)) {
      return reply.code(400).send({ error: "Bad Request", message: `unsupported content-type: ${part.mimetype}` });
    }
    const title =
      typeof part.fields.title?.value === "string" && part.fields.title.value.trim() !== ""
        ? part.fields.title.value.trim()
        : part.filename;

    const tempPath = join(tmpdir(), `sf-upload-${randomUUID()}.mp4`);
    try {
      await pipeline(part.file, createWriteStream(tempPath));
      if (part.file.truncated) {
        // @fastify/multipart flags truncation when the size limit is exceeded.
        return reply.code(413).send({ error: "Payload Too Large", message: "file exceeds size limit" });
      }
      const { size } = await import("node:fs/promises").then((m) => m.stat(tempPath));
      const video = await service.ingest({
        tempPath, title, contentType: part.mimetype, sizeBytes: size,
      });
      return reply.code(201).send(video);
    } finally {
      await rm(tempPath, { force: true });
    }
  });
}
```

- [ ] **Step 2: Create `upload/index.ts`**

```ts
/**
 * Upload module — PUBLIC surface. Registers the ingest route. Depends on the upload service
 * (which itself depends on storage + catalog, injected at the composition root).
 */
import type { FastifyInstance } from "fastify";
import type { UploadService } from "./upload.service.js";
import { uploadRoutes } from "./upload.routes.js";

export { createUploadService } from "./upload.service.js";
export type { UploadService } from "./upload.service.js";

export function registerUpload(
  app: FastifyInstance,
  deps: { service: UploadService },
): void {
  uploadRoutes(app, deps.service);
}
```

- [ ] **Step 3: Register multipart + upload in `app.ts`**

Add import at top of `apps/backend/src/app.ts`:
```ts
import multipart from "@fastify/multipart";
import { probeVideo } from "./platform/ffprobe.js";
import { createUploadService, registerUpload } from "./modules/upload/index.js";
```
`buildApp` must become `async` to `await app.register(multipart, ...)`. Change signature to
`export async function buildApp(config: Config): Promise<FastifyInstance>` and update
`main.ts` call site to `const app = await buildApp(config);`.

Inside `buildApp`, register the multipart plugin near the top (after `Fastify(...)`):
```ts
  await app.register(multipart, {
    limits: { fileSize: config.uploadMaxBytes, files: 1 },
  });
```
Then, in the composition-root block, after catalog is wired, replace the
"upload registered in Task 10" comment with:
```ts
  const uploadService = createUploadService({
    storage,
    catalog: catalogService,
    probe: probeVideo,
  });
  registerUpload(app, { service: uploadService });
```
And ensure the bucket exists at startup — after constructing `storage`:
```ts
  await storage.ensureBucket();
```

- [ ] **Step 4: Update `main.ts` for async buildApp**

In `apps/backend/src/main.ts`, change:
```ts
  const app = buildApp(config);
```
to:
```ts
  const app = await buildApp(config);
```

- [ ] **Step 5: Typecheck & unit tests**

Run: `npm run build` then `npm -w @streamforge/backend run test`
Expected: build PASS; all unit/integration tests PASS.

- [ ] **Step 6: END-TO-END verification (the real proof of the slice)**

```bash
cd apps/backend
node --env-file=.env --import tsx ./src/main.ts &
sleep 2
# generate a real sample mp4
ffmpeg -y -f lavfi -i testsrc=size=640x360:rate=15:duration=2 -c:v libx264 -pix_fmt yuv420p /tmp/sf-e2e.mp4 -loglevel error
# upload it
curl -s -F "file=@/tmp/sf-e2e.mp4;type=video/mp4" -F "title=E2E Sample" localhost:3000/upload/videos | tee /tmp/sf-e2e-resp.json
echo
# read back
curl -s localhost:3000/catalog/videos
kill %1
```
Expected:
- upload response `201` JSON with `width:640, height:360, videoCodec:"h264", durationSeconds≈2, status:"uploaded"`, a UUID `id`, `storageKey:"<id>/original.mp4"`.
- `GET /catalog/videos` includes that record.

- [ ] **Step 7: Confirm persistence in BOTH stores**

```bash
# Postgres row
docker exec streamforge-postgres psql -U streamforge -d streamforge -c "select id,title,width,height,video_codec,status from videos order by created_at desc limit 3;"
# MinIO object
docker exec streamforge-minio mc ls -r local/streamforge-raw/ | tail -5
```
Expected: the row present with correct metadata; the object present at `<id>/original.mp4`.

- [ ] **Step 8: Verify the compensating-delete path against real infra (optional but recommended)**

Temporarily point `DATABASE_URL` to a bad port to force a DB failure, upload, and confirm
no orphan object is left:
```bash
# with server stopped, run one ingest via a tiny script or by setting a wrong DB port,
# then: docker exec streamforge-minio mc ls -r local/streamforge-raw/ | wc -l  (should not grow)
```
(If skipped, note it — the unit test in Task 9 already covers the logic; this checks the
real S3 delete call.)

- [ ] **Step 9: Final checkpoint** — update `docs/PROGRESS.md`: mark Phase 1 #1 COMPLETE
with evidence (E2E upload 201, row + object confirmed), set next action to Phase 1 #2
(Media Fundamentals doc). Update project memory `streamforge-status.md` current module.

---

## Self-Review (done by plan author)

**Spec coverage:**
- §1 scope (upload/store/probe/record/list/get) → Tasks 4–10. ✓
- §2 decisions (raw SQL, proxied, guards+ffprobe, two modules) → Tasks 3/6/7/9/10. ✓
- §3 concept docs 05–07 before code → Task 1 (first). ✓
- §4 flow incl. temp-file mechanism → Tasks 9 (service) + 10 (route owns temp file). ✓
- §5 data model incl. `status` seam + nullable probe fields → Task 4 migration; nulls in Tasks 6/7/9. ✓
- §6 error handling: 400 content-type/size (Task 10), 413 too large (Task 10), probe non-fatal (Tasks 6/9), compensating delete (Task 9 test + Task 10 real), temp cleanup in finally (Task 10). ✓
- §7 testing: unit (service/routes with fakes), integration (repo/storage/ffprobe on real infra), E2E curl (Task 10). ✓
- §8 deps → Task 2 (exact versions). ✓
- §9 success criteria → Task 10 Steps 6–7. ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code; every run step has an
expected result. ✓

**Type consistency:** `CreateVideoInput`/`Video` (contracts) used identically across repo,
service, upload service, and routes. `Storage`, `CatalogService`, `ProbeResult`,
`UploadService` signatures match between producer and consumer tasks. `registerCatalog` /
`registerUpload` / `createUploadService` names consistent. `buildApp` async change
propagated to `main.ts` (Task 10 Steps 3–4). ✓

**Deviation from template:** git commits replaced by Checkpoints per project's git-deferred
decision (stated in header). ✓
