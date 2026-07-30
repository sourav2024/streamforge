# Transcoding Pipeline Implementation Plan (Phase 1 #3)

> **⚠️ GIT IS DEFERRED for this project.** Do NOT run `git init`/`add`/`commit`. Where a
> normal plan would commit, each task ends with a **Checkpoint** (run verification + update
> `docs/PROGRESS.md`). Version control resumes only when the user explicitly asks.

**Goal:** An uploaded MP4 is transcoded in the background to one 720p HLS rendition
(fMP4/CMAF segments + media playlist) in a new `streamforge-hls` bucket, with the catalog
row advancing `uploaded → transcoding → ready` (or `failed`). Spec:
`docs/specs/2026-07-21-transcoding-pipeline-design.md`.

**Architecture:** BullMQ queue `transcode` over existing Redis. Producer half lives in a new
`transcode` module and is called by `upload.service` after ingest (via `transcode/index.ts`
only — boundary rule). Consumer half is a **separate worker process** (`src/worker.ts`, its
own composition root) running `processTranscodeJob` with concurrency 1. Catalog gains
`updateStatus`. `platform/storage.ts` becomes bucket-parameterized and gains
`getObjectToFile`. FFmpeg flags per spec §5 (fixed 2s GOP, capped-CRF, 4s fMP4 segments).

**Tech stack additions:** `bullmq@^5.80.10` (brings `ioredis`). Env: `REDIS_URL`,
`S3_BUCKET_HLS`. Everything else as established (Node 25, TS strict, `node:test` + `tsx`).

## Global constraints

- ESM + NodeNext: relative imports need `.js`. TS strict flags already enforced.
- Cross-module rule: `upload` imports transcode's producer ONLY via
  `modules/transcode/index.ts`; `transcode` calls catalog ONLY via its service (injected).
- Concept doc 09 BEFORE any queue code (Teaching Contract).
- Idempotency is a hard requirement: BullMQ is at-least-once; every job step must overwrite,
  not append (spec §6).
- Verify with real evidence at every checkpoint. No git commits.
- Infra must be up (`npm run infra:up`; Postgres host port **5433**).

## File structure

```
docs/concepts/09-job-queues-bullmq.md          Create (Task 1)
apps/backend/
  package.json                                 Modify (Task 2: bullmq; Task 8: dev:worker)
  .env.example / .env                          Modify (Task 2: REDIS_URL, S3_BUCKET_HLS)
  src/
    platform/
      config.ts                                Modify (Task 2: redisUrl, bucketHls)
      storage.ts                               Modify (Task 3: bucket param + getObjectToFile)
      storage.test.ts                          Modify (Task 3)
      redis.ts                                 Create (Task 5: BullMQ connection options)
    modules/
      catalog/{repository,service}(.test).ts   Modify (Task 4: updateStatus)
      test-helpers/make-fixture.ts             Modify (Task 6: size/seconds options)
      upload/upload.service(.test).ts          Modify (Task 5: enqueue after ingest)
      transcode/
        transcode.producer.ts                  Create (Task 5)
        transcode.producer.test.ts             Create (Task 5: real-Redis dedupe)
        ffmpeg.ts                              Create (Task 6)
        ffmpeg.test.ts                         Create (Task 6: real-FFmpeg integration)
        transcode.job.ts                       Create (Task 7)
        transcode.job.test.ts                  Create (Task 7: unit, fakes)
        index.ts                               Create (Task 5, extend Task 7)
    app.ts                                     Modify (Tasks 3, 5)
    worker.ts                                  Create (Task 8: worker composition root)
packages/contracts/src/index.ts                Modify (Task 4: VideoStatus + "failed")
package.json (root)                            Modify (Task 8: dev:worker convenience)
```

---

### Task 1: Concept doc 09 — job queues & BullMQ

- [ ] Write `docs/concepts/09-job-queues-bullmq.md` per spec §3, house structure (docs
  01–07): why background jobs (request/response vs CPU-bound work); producer/broker/worker
  anatomy; why Redis; BullMQ job lifecycle (waiting → active → completed/failed; delayed,
  stalled); **at-least-once ⇒ idempotent handlers**; retries + exponential backoff; `jobId`
  dedupe; worker concurrency (ours = 1, FFmpeg saturates cores); graceful shutdown;
  alternatives (in-process, pg-boss, RabbitMQ, SQS, Kafka) + why BullMQ; trade-offs; glossary.
- [ ] **Checkpoint:** file exists; PROGRESS.md notes Task 1 done.

### Task 2: Dependency, env vars, config

- [ ] `npm -w @streamforge/backend install bullmq@^5.80.10` (expect 0 vulns).
- [ ] Append to `.env.example` AND `.env`:
  `REDIS_URL=redis://localhost:6379` and `S3_BUCKET_HLS=streamforge-hls` (under the S3 block).
- [ ] `config.ts`: add `redisUrl: required("REDIS_URL")` to `Config`; add
  `bucketHls: process.env.S3_BUCKET_HLS ?? "streamforge-hls"` to `S3Config`.
- [ ] **Checkpoint:** `npm -w @streamforge/backend run typecheck` PASS; infra up & healthy.

### Task 3: Storage — bucket-parameterized + `getObjectToFile`

- [ ] TDD: update `storage.test.ts` first — construct with explicit bucket
  `createStorage(loadConfig(), loadConfig().s3.bucketRaw)`; extend round-trip: put file →
  `getObjectToFile` to a second temp path → contents equal → delete. Run: RED (compile error:
  wrong arity / missing method).
- [ ] `storage.ts`: `createStorage(config: Config, bucket: string)`; add to interface and
  impl:

```ts
async getObjectToFile(key, destPath) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`empty body for s3://${bucket}/${key}`);
  await pipeline(res.Body as Readable, createWriteStream(destPath));
}
```

  (new imports: `GetObjectCommand`, `createWriteStream`, `pipeline` from
  `node:stream/promises`, `type Readable`.)
- [ ] Update the one call site: `app.ts` → `createStorage(config, config.s3.bucketRaw)`.
- [ ] **Checkpoint:** storage test GREEN vs real MinIO; typecheck + build PASS.

### Task 4: Contracts `"failed"` + catalog `updateStatus`

- [ ] `packages/contracts/src/index.ts`: add
  `export type VideoStatus = "uploaded" | "transcoding" | "ready" | "failed";` and use it for
  `Video["status"]`.
- [ ] TDD repo: add tests — `updateStatus` persists + returns the updated `Video`;
  returns `null` for unknown id. RED, then implement in `catalog.repository.ts`:
  `update videos set status = $2 where id = $1 returning ${COLS}` → `Video | null`.
- [ ] Service: add `updateStatus(id: string, status: VideoStatus): Promise<Video | null>`
  (thin delegate — this is the status-transition seam named in Task 7 of the last plan);
  fake-repo unit test. Status-transition *validation* deliberately deferred (spec §6).
- [ ] **Checkpoint:** build + typecheck PASS; catalog tests GREEN (now 6+).

### Task 5: Redis options, producer, enqueue-on-ingest

- [ ] `platform/redis.ts`: parse `config.redisUrl` → `{ host, port, maxRetriesPerRequest:
  null }` (the ioredis setting BullMQ requires for blocking connections — doc 09).
- [ ] `transcode.producer.ts`:

```ts
export const TRANSCODE_QUEUE = "transcode";
export interface TranscodeJobData { videoId: string; }
export interface TranscodeProducer {
  enqueue(videoId: string): Promise<void>;
  close(): Promise<void>;
}
// createTranscodeProducer(connection): Queue.add("transcode-video", { videoId },
//   { jobId: videoId /* dedupe */, attempts: 3,
//     backoff: { type: "exponential", delay: 5_000 },
//     removeOnComplete: true, removeOnFail: false /* keep for inspection */ })
```

- [ ] `transcode/index.ts` (public surface): export producer constructor + types + queue name.
- [ ] Integration test (real Redis): enqueue same id twice → `queue.count()` unchanged after
  the second call (jobId dedupe); clean up the job; close connections.
- [ ] `upload.service.ts`: new dep `transcode: Pick<TranscodeProducer, "enqueue">`. After
  `createVideo` succeeds: `try { await transcode.enqueue(video.id); } catch { /* non-fatal:
  upload is durable; stuck-at-uploaded gap = transactional outbox, spec §6 */ }`. Update the
  3 existing unit tests (add fake) + 2 new: enqueue called with created id; enqueue-throws →
  ingest still resolves.
- [ ] `app.ts`: construct producer (redis options from config), inject into upload service,
  `onClose` → `producer.close()`.
- [ ] **Checkpoint:** all tests GREEN; build PASS; live boot: API starts with Redis up.

### Task 6: FFmpeg HLS runner (real-encode integration test)

- [ ] Extend `make-fixture.ts`: `makeSampleMp4(destPath, opts?: { size?: string; seconds?:
  number })` (defaults preserve current 320x240/1s behavior; existing probe test untouched).
- [ ] `transcode/ffmpeg.ts` — `HLS_PLAYLIST = "index.m3u8"`, `buildHlsArgs(inputPath,
  outDir): string[]` exactly per spec §5 (scale `min(720,ih)` never-upscale, `-r 30`,
  `-g 60 -keyint_min 60 -sc_threshold 0`, CRF 23 + maxrate 3M/bufsize 6M, `-hls_time 4`,
  fMP4 + `init.mp4`), and `runFfmpegHls(inputPath, outDir)` via `execFile`.
- [ ] Integration tests (real ffmpeg): (a) 1920x1080/10s fixture → out dir has `index.m3u8` +
  `init.mp4` + ≥2 `.m4s`; playlist has `#EXTM3U` and references `init.mp4`; `probeVideo` on
  the playlist reports h264 and height **720**. (b) 640x360/2s fixture → height stays **360**
  (never upscale).
- [ ] **Checkpoint:** ffmpeg tests GREEN; typecheck PASS.

### Task 7: Job handler `processTranscodeJob` (unit, TDD)

- [ ] TDD with fakes (catalog records status calls; fake `rawStorage.getObjectToFile` writes
  a dummy file; fake `runHls` writes `index.m3u8`/`init.mp4`/`seg_00000.m4s` into outDir;
  fake `hlsStorage` records key+contentType):
  1. happy path → statuses `["transcoding","ready"]`; uploads all 3 artifacts under
     `<id>/` with content-types `application/vnd.apple.mpegurl` / `video/mp4` /
     `video/iso.segment`;
  2. unknown video → rejects `UnrecoverableError`, no status written;
  3. `runHls` throws → rejects, statuses `["transcoding"]` only, nothing uploaded, temp
     cleaned (`finally`).
- [ ] Implement `transcode.job.ts`: `contentTypeFor(filename)`; `processTranscodeJob(data,
  deps)` = getVideo (miss → `UnrecoverableError`) → `updateStatus("transcoding")` →
  mkdtemp → download original → `runHls` → upload every out file sorted → **only then**
  `updateStatus("ready")` → `finally` rm temp dir. All effects injected via
  `TranscodeJobDeps { catalog, rawStorage, hlsStorage, runHls }`.
- [ ] Extend `transcode/index.ts` exports (job handler, deps type, ffmpeg runner).
- [ ] **Checkpoint:** unit tests GREEN; full suite GREEN; build PASS.

### Task 8: Worker entrypoint + scripts

- [ ] `src/worker.ts` — second composition root: config → pool → rawStorage/hlsStorage
  (ensure hls bucket) → catalog → `new Worker(TRANSCODE_QUEUE, job =>
  processTranscodeJob(job.data, deps), { connection, concurrency: 1 })`. `failed` handler:
  when `job.attemptsMade >= (job.opts.attempts ?? 1)` **or** `err instanceof
  UnrecoverableError` → `catalog.updateStatus(videoId, "failed")` (spec §6: only the FINAL
  failure marks the row). Graceful shutdown: SIGINT/SIGTERM → `worker.close()` (drains
  in-flight job) → `pool.end()`. Plain `console` logging for now (pino unification deferred —
  worker has no Fastify).
- [ ] Scripts: backend `"dev:worker": "tsx watch src/worker.ts"`; root convenience
  `"dev:worker": "npm -w @streamforge/backend run dev:worker"`.
- [ ] **Checkpoint:** typecheck + build PASS; worker boots
  (`node --env-file=.env --import tsx ./src/worker.ts`) and logs it is listening.

### Task 9: END-TO-END proof + failure drill

- [ ] Boot API + worker (both via `node --env-file=.env --import tsx …`).
- [ ] Generate a real 1080p/10s mp4; upload via curl → 201, capture `id`.
- [ ] Poll `GET /catalog/videos/:id` until `status:"ready"` (expect seconds). During the
  encode, `curl /health` → API responsive (separate-process payoff).
- [ ] Verify artifacts: `mc ls local/streamforge-hls/<id>/` shows `index.m3u8`, `init.mp4`,
  ≥2 `.m4s`. Copy them out (`mc cp` + `docker cp`) and `ffprobe` the local playlist →
  h264, height 720. Postgres row `status='ready'`.
- [ ] Failure drill (deterministic): stop the worker → upload → `mc rm` the raw object →
  start worker → job fails 3 attempts (backoff ≈5/10s) → row reaches `status='failed'`
  (~40s). Restart evidence in worker logs.
- [ ] **Checkpoint:** update PROGRESS.md — Phase 1 #3 COMPLETE with evidence; next = teach
  retro / Phase 1 #4 (ABR ladder).

---

## Self-review

- Spec §1 scope → Tasks 1–9 cover queue, worker process, FFmpeg 720p HLS, hls bucket,
  status lifecycle incl. `failed`. ✓
- Spec §2 decisions: separate process (T8), 720p capped (T6), hls bucket (T2/T3/T8),
  fMP4 (T6). ✓  §3 concept doc first (T1). ✓
- §4 flow: enqueue-after-ingest (T5), jobId dedupe (T5 test), idempotent handler (T7),
  worker composition root (T8). ✓
- §5 flags: exact args in T6 with never-upscale + GOP/segment alignment asserted by probe. ✓
- §6 errors: non-fatal enqueue (T5), UnrecoverableError on missing row (T7), final-attempt
  `failed` incl. UnrecoverableError case (T8), partial-upload overwrite via idempotency
  (T7 ordering: `ready` only after all uploads). ✓
- §7 tests: unit (T7), real-FFmpeg (T6), real-Redis dedupe (T5), E2E + failure drill (T9). ✓
- §8 deps/env (T2), storage changes (T3), redis.ts (T5). ✓  §9 criteria all land in T9. ✓
- Type consistency: `VideoStatus` (T4) used by service/repo/worker; `TranscodeJobData`
  shared producer↔worker via module index; `Storage` arity change has exactly two
  construction sites (app.ts, worker.ts) + tests. ✓
