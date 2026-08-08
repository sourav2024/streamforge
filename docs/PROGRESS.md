# StreamForge — Progress Log

> **READ THIS FIRST when resuming.** This is the source of truth for where we are.
> Pair it with the design spec: `docs/specs/2026-07-08-streamforge-design.md`.

## Current status

- **Phase:** Phase 1 — VOD Core — **COMPLETE** ✅✅ (#5 Playback Service done & verified:
  ffprobe consumed the entire proxied HLS tree through the backend; all 403/404/409 drills
  pass). Phase 1 #4 done earlier the same day (see Session 8).
- **Module:** Phase 2 #6 — RN app skeleton (bare React Native, Android). Not started.
- **Next action:** Teach-backs are OWED (standing ritual; Sessions 8–9 ran autonomous):
  (a) Phase 1 #4 — ladder design, CODECS/BANDWIDTH anatomy, master-last rationale;
  (b) Phase 1 #5 — path-token-vs-query rationale, HMAC/timingSafeEqual, backpressure,
  immutable-vs-playlist caching; (c) the Session-5 media-fundamentals remainder (Q4–Q7).
  Then brainstorm Phase 2 #6.
- **Blocked on:** Nothing. Infra is up and healthy.
- **Dev note:** host Postgres port is **5433** (Homebrew pg holds 5432). Docker often stops
  between sessions — `npm run infra:up` + wait for (healthy) on resume.
- **Dev note 2:** do NOT run the test suite while the dev worker is running — the live
  worker consumes the producer test's real Redis jobs and the suite hangs (learned 2026-08-08).
- **Git:** LIVE as of 2026-08-08 — repo pushed to GitHub as `sourav2024/streamforge`
  ("chore: initial commit" = everything through Session 7 + partial #4). Repo-local identity:
  `sourav2024 <souravkashyap7869@gmail.com>`. Sessions 8–9 committed & pushed (`dec5c64`).

## The rhythm (every module)

**📖 Concept doc → 💻 Implementation → update this log.**
Understanding precedes implementation, always. (See spec §1 — The Teaching Contract.)

## Key decisions (quick reference — full rationale in spec §4)

- VOD video first → audio → hardening → live/iOS.
- Backend: Node.js + TypeScript, modular monolith, Express/Fastify (no NestJS, on purpose).
- Queue: BullMQ + Redis. Transcode: self-hosted FFmpeg. DB: Postgres. Storage: MinIO.
- Protocol: HLS first. Infra: Docker Compose.
- Mobile: bare React Native, Android first, react-native-video/ExoPlayer. DRM: Widevine later.

## Session log

### Session 1 — 2026-07-08
- Brainstormed and locked the full design.
- Confirmed toolchain (all present except Docker — user installing).
- Created `streamforge/` project dir, git init, `docs/` structure.
- Wrote design spec `docs/specs/2026-07-08-streamforge-design.md`.
- **Next up:** Phase 0 concept docs (monorepo, modular monolith) + repo scaffold + docker-compose.

### Session 2 — 2026-07-08 — Phase 0 COMPLETE

Concept docs written (Teaching Contract satisfied before any code):

- `docs/concepts/01-monorepo-structure.md` — npm workspaces + Turborepo, and why.
- `docs/concepts/02-why-modular-monolith.md` — architecture + the future extraction path.
- `docs/concepts/03-fastify.md` — plugins/encapsulation (maps to module boundaries), schema
  validation, why Fastify over Express/NestJS/Koa.
- `docs/concepts/04-local-infra-docker-compose.md` — containers/Compose, Postgres/Redis/MinIO.

Implemented + **verified**:

- Monorepo scaffold: root `package.json` (npm workspaces), `turbo.json`, `tsconfig.base.json`,
  `.gitignore`, `.nvmrc`, `README.md`.
- `packages/contracts` (shared types; `HealthResponse`) — confirmed symlinked into the backend.
- `apps/backend`: Fastify modular-monolith skeleton — `platform/config.ts`, composition root
  `app.ts` (DI by hand), `main.ts` (graceful shutdown), `src/modules/` placeholder.
- `infra/docker-compose.yml`: postgres:17-alpine, redis:7-alpine, minio:latest — with
  healthchecks and named volumes. `npm run infra:up|down|logs` scripts.

Verification evidence (not just "it should work"):

- `npm install` clean (0 vulns). `npm run build` passes; contracts builds before backend
  (`^build`); 2nd build = `FULL TURBO` cache hit in 12ms.
- Backend boots; `GET /health` → correct `HealthResponse`; Fastify Pino logs + JSON 404 seen;
  graceful shutdown works.
- `docker compose up -d` → all 3 containers **(healthy)**. Functional probes: Postgres 17.10
  real query OK, Redis PING/set/get OK, MinIO S3 liveness HTTP 200, all host ports open.

Decisions made this session:

- Monorepo tooling: **npm workspaces + Turborepo** (deliberate early exception to "defer tools").
- Backend framework: **Fastify** (encapsulation mirrors module boundaries — the decider).

Corrections to the record:

- Session-1 note said git was initialized — it was NOT. User has chosen to **defer git**;
  do not commit until explicitly asked. (A stray `apps/backend/.git` from a mistaken init
  was removed.)

**Next up:** Phase 1 #1 — Storage & Upload. Start with the object-storage/S3 concept doc.

### Session 3 — 2026-07-08 — Phase 1 #1 (Storage & Upload) in progress

- Brainstormed + approved slice design: `docs/specs/2026-07-08-storage-upload-design.md`.
  Decisions: raw SQL + node-pg-migrate; proxied upload; basic guards + ffprobe; two modules
  (`upload` + `catalog`).
- Wrote implementation plan: `docs/plans/2026-07-08-storage-upload.md` (10 tasks, TDD,
  git-deferred so "checkpoints" replace commits). Executing inline, pausing per task.
- **Task 1 DONE:** concept docs written — `05-object-storage-and-s3.md`,
  `06-postgres-data-access.md`, `07-media-metadata-ffprobe.md` (Teaching Contract satisfied
  before any code).
- **Next:** Task 2 — install deps (pg, @aws-sdk/client-s3, @fastify/multipart, node-pg-migrate)
  + migrate/test scripts + env vars.

### Session 4 — 2026-07-09 — Phase 1 #1 Tasks 2–3 done

- **Data-access decision reconfirmed:** user asked to switch to Prisma ("industry norm");
  after weighing raw SQL / query-builders (Drizzle) / ORM (Prisma), user chose to **keep raw
  SQL** for learning transparency. No plan change.
- **Task 2 DONE (verified):** installed pg@8.22, @aws-sdk/client-s3@3.1083,
  @fastify/multipart@10.1, @types/pg@8.20, node-pg-migrate@8.0.4 — 0 vulns. Added
  `migrate`/`migrate:down`/`test` scripts + DB/S3/upload env vars to `.env.example`; created
  working `.env`. Typecheck PASS. Docker started; infra (pg/redis/minio) all (healthy).
- **Task 3 DONE (verified):** TDD — `db.test.ts` red→green. Extended `config.ts` (S3Config,
  `databaseUrl`, `uploadMaxBytes`, `required()` fail-fast helper); created `platform/db.ts`
  (`createPool`); added contract types `Video`/`CreateVideoInput`/`CreateVideoResponse`/
  `VideoListResponse`. `npm run build` + typecheck PASS; db test green.
- **Deviations from plan (intentional, both verified):**
  1. `required()` for S3 vars means any `loadConfig()` test needs env → changed the `test`
     script to `tsx --env-file=.env --test src/**/*.test.ts` (plan omitted `--env-file` there).
  2. Added a fail-fast doc-comment on `required()` (teaching-doc style; no behavior change).
- **Task 4 DONE (verified):** wrote `migrations/1730000000000_create-videos.js`; migrated UP
  (11 cols, id PK, storage_key UNIQUE — `\d videos` confirms); tested DOWN (table dropped,
  regclass empty) then re-UP; `pgmigrations` bookkeeping row present.
- **Env fixes this task (important for future sessions):**
  1. **Port clash:** a native Homebrew `postgresql@16` occupies host `localhost:5432` and
     shadowed our container (error: `role "streamforge" does not exist` from host, but role
     works *inside* the container). Fix: moved container host port to **5433**
     (`docker-compose.yml` default `${POSTGRES_PORT:-5433}`; `DATABASE_URL` → `:5433` in
     `.env` + `.env.example`). Both Postgres servers now coexist.
  2. **dotenv:** `node-pg-migrate` v8 dropped bundled dotenv, so `--envPath .env` silently
     loaded nothing. Fix: added `dotenv` devDep (standard practice); migrate scripts unchanged.
- **Task 5 DONE (verified):** `platform/storage.ts` — `createStorage()` +
  `ensureBucket`/`putObjectFromFile`/`deleteObject` over `@aws-sdk/client-s3` (forcePathStyle
  for MinIO; streams file body + explicit ContentLength from `stat` to avoid buffering).
  Round-trip integration test green against real MinIO; `mc ls` confirms `streamforge-raw/`
  bucket created. Typecheck PASS.
- **Pacing refinement:** for thin infra wrappers (storage, ffprobe) we now implement-first
  then verify with a real exercise, instead of the hollow "watch the import fail" TDD step.
  Test-first TDD is kept for logic-bearing code (catalog service/repo, upload orchestration).
- **Task 6 DONE (verified):** `platform/ffprobe.ts` — `probeVideo()` runs `ffprobe -v quiet
  -print_format json -show_format -show_streams`, extracts width/height/videoCodec/duration
  from the video stream; **non-fatal by contract** (any error → all-nulls, never throws).
  `test-helpers/make-fixture.ts` generates a real 320x240 h264 mp4 via ffmpeg. Back on
  **test-first TDD** (user preference): red (module-not-found) → green (2 tests, incl. nulls
  on a non-media file). ffmpeg/ffprobe 8.1.2 confirmed on PATH. Typecheck PASS.
- **Task 7 DONE (verified):** catalog module built TDD.
  - `catalog.repository.ts` — raw parameterized SQL over `videos`; `toVideo()` is the single
    snake→camel + bigint→Number + Date→ISO mapping boundary. Repo integration test (3 cases)
    green vs real Postgres: insert→getById mapping, list, getById null.
  - `catalog.service.ts` — thin delegator (the seam for future status transitions); unit test
    with a fake repo (1 case) green.
  - `index.ts` — module PUBLIC surface (boundary rule); exports construct fns + types only.
  - Checkpoint: `npm run build` + typecheck PASS; all 4 catalog tests green.
- **Session note:** new session started here — Docker was down; relaunched, `infra:up`, all
  (healthy). Port 5433 + `videos` table survived (named volume). Then ran Task 7.
- **Task 7 teach-back DONE:** deep layered-architecture explanation + 7-question quiz. User
  solid on architecture (layers, service-as-seam, boundary); patched mechanics (bigint→string
  precision, SQL-injection at protocol level = parse-before-bind, DI enabling fake-repo tests).
  Teach-back+quiz is now the standing ritual after every task ([[streamforge-pacing]]).
- **Task 8 DONE (verified):** `catalog.routes.ts` (GET list + GET :id), `registerCatalog` in
  index.ts, and the FIRST composition-root wiring in `app.ts` (pool→repo→service→routes;
  storage constructed for Task 10; `onClose` ends the pool). Route unit tests (Fastify
  `inject` + fake service) green. **Live boot proof** vs real Postgres: `/catalog/videos`→200
  `{"videos":[]}`, both bad ids→404, zero 500s.
- **Real bug caught by the boot proof (mock hid it):** `GET /catalog/videos/nope` first gave
  **500**, not 404 — a non-UUID string makes Postgres throw at uuid parse (err 22P02), so
  `getById` threw instead of returning null. Fix: UUID-format guard in the route (non-UUID →
  treated as not-found 404, never reaches DB); added a regression test for non-UUID + a
  well-formed-unknown-UUID case. Lesson logged: fakes can diverge from real DB behavior →
  the live proof is essential (verify-don't-assert).
- **Task 8 teach-back DONE:** 5-question quiz. User solid on architecture (null→404 translation,
  composition root, guard placement + the service-level alternative). Patched two runtime-mechanics
  gaps: (a) composition root must build bottom-up or you get a use-before-declare `ReferenceError`;
  (b) a mock tests your *beliefs* about a dependency, so a green test can sit on a broken system —
  hence the live boot proof (the 500-vs-404 was the vivid example).
- **Task 9 DONE (verified):** `upload.service.ts` — `createUploadService({storage, catalog,
  probe})` with `ingest()`: UUID → PUT to MinIO (`<id>/original.mp4`) → probe → catalog.createVideo.
  **Orchestration-style saga:** on catalog failure, compensating-delete the object (best-effort,
  idempotent) and rethrow the ORIGINAL error; probe is non-fatal (nulls, still succeeds). Doc-comment
  states scope honestly (covers step-failure, NOT process-crash → sweeper deferred, spec §6). Pure of
  HTTP/multipart (route hands it a temp path); never touches videos table (calls catalog). TDD: red →
  green (3 tests incl. compensating-delete + non-fatal probe). Typecheck PASS.
- **Task 9 teach-back DONE:** 6-question quiz, 5/6 first pass. User solid on: no cross-system
  txn → saga → compensating delete → swallow-cleanup/rethrow-original → crash gap. Patched Q4
  (blind delete is safe *because* S3 delete is idempotent — links back to Task 5; no check-then-act
  race). Taught the background sweeper in depth (reconciliation loop + age threshold + why
  layered saga-now/sweeper-later beats heavier crash-proofing) per user request.
- **Task 10 DONE (verified) — SLICE COMPLETE:** `upload.routes.ts` (POST /upload/videos,
  multipart → temp file → guards 400/413 → service → 201, temp cleaned in finally),
  `upload/index.ts` (registerUpload). Wired multipart plugin + upload module into `app.ts`;
  `buildApp` now async (`await` in main.ts); `ensureBucket()` at startup.
  - **Two silent-failure bugs caught & fixed:** (1) multipart `fields.title` is
    `Multipart | Multipart[]` — narrowed via `type === "field"` guard (typecheck was failing).
    (2) `test` script glob `src/**/*.test.ts` ran only 4 tests under `sh` (no `**`); quoted the
    glob so Node's runner expands it → now **14 tests** all green.
  - **END-TO-END proof (real evidence):** booted fully-wired server; uploaded a real 640x360
    h264 mp4 via curl → **201** with correct probe metadata (w=640,h=360,codec=h264,dur=2).
    Confirmed in BOTH stores: Postgres row present + MinIO object `<id>/original.mp4` (14KiB).
    `GET /catalog/videos` reads it back (write+read paths connect). Non-mp4 upload → 400.
- **Phase 1 #1 retro:** full VOD ingest vertical slice works end to end — HTTP upload → object
  storage + probed metadata in Postgres → catalog read-back. platform/ (config, db pool,
  storage, ffprobe) + catalog + upload modules, composition-root DI, 14 tests. Git still deferred.
- **Task 10 teach-back DONE:** 5-question quiz. User strong on streaming rationale + full-slice
  trace (capstone). Patched: `finally` = always-runs (vs `catch` = on-error), so early-return/throw
  don't leak the temp file; async changes return type to Promise → callers must await (contagion).
  Q4 = the session's theme: green ≠ correct (silent test-glob skip mirrors Task 8 mock-vs-reality).

### Session 5 — 2026-07-12 — Phase 1 #2 (Media Fundamentals doc)

- Brainstormed scope: doc-first (spec's Phase 1 #2 = pure concept), then quiz, THEN build
  transcoding (Phase 1 #3) as a separate step. Depth = staff-SDE working model. Structure =
  concept-chapter (not the tool-decision house template, since there's no single tool to justify).
- **Wrote `docs/concepts/08-media-fundamentals.md`** (329 lines, 8 sections): raw-video-is-huge →
  container vs codec (+ muxing/remuxing/transcoding) → H.264 internals (I/P/B, GOP, chroma
  subsampling, quantization, entropy) → keyframes as the streaming hinge (segment/seek/ABR
  alignment) → bitrate×resolution×framerate + rate control (CRF/CBR/capped) → why segment + HLS
  (media/master playlist) + HLS/DASH/CMAF → how it maps to StreamForge → glossary. Self-review OK.
- **Teach-back STARTED, not finished** (user tired — paused mid-quiz, honest stopping point).
  Graded Q1–Q3: user solid on I/P/B frame types + container-vs-codec idea. **Gaps to re-open
  next session, fresh, FIRST:** (1) the ~1.5 Gbit/s raw-1080p number & why compression is
  mandatory; (2) remux (change container, keep bytes = cheap) vs transcode (re-encode = expensive)
  — user thought it was "one part vs all parts"; (3) **Q4 the keyframe hinge** — why a segment
  must START on a keyframe & why keyframes must be IDR-aligned across ABR renditions (NOT yet
  answered; most important for Phase 1 #3/#4).
- **RESUME HERE next session:** finish the media-fundamentals quiz (Q4–Q7, re-ask Q1/Q2 gaps),
  THEN brainstorm & build Phase 1 #3 (BullMQ + FFmpeg → single-rendition HLS; flip `status`
  uploaded→transcoding→ready).

### Session 6 — 2026-07-21 — Phase 1 #3 (Transcoding Pipeline) started

- **Media-fundamentals quiz SKIPPED at user's request** (Q4–Q7 + Q1/Q2 re-asks never run).
  Unverified gaps carried forward: raw-bitrate founding number, remux-vs-transcode, and the
  **keyframe hinge / IDR alignment (Q4)** — weave these into the Phase 1 #3 build narrative
  instead (GOP/segment flags are the natural moment).
- **Brainstormed + locked 4 decisions** (user chose all recommendations): separate worker
  process; 720p capped-bitrate (CRF 23 + maxrate 3M/bufsize 6M); new `streamforge-hls`
  bucket; fMP4/CMAF segments. Wrote design spec
  `docs/specs/2026-07-21-transcoding-pipeline-design.md` + plan
  `docs/plans/2026-07-21-transcoding-pipeline.md` (9 tasks).
- **Tasks 1–3 DONE (verified):**
  - Task 1: concept doc `09-job-queues-bullmq.md` (queue anatomy, lifecycle, at-least-once ⇒
    idempotency, retries/backoff, jobId dedupe, concurrency=1 rationale, alternatives).
  - Task 2: bullmq@5.80.10 installed (0 vulns); `REDIS_URL` + `S3_BUCKET_HLS` env; config
    gains `redisUrl` + `s3.bucketHls`. Typecheck PASS.
  - Task 3: `createStorage(config, bucket)` (per-bucket instances) + `getObjectToFile`
    (streamed GET). Round-trip test now put→download→compare→delete; GREEN vs real MinIO.

### Session 7 — 2026-07-22 — Phase 1 #3 Tasks 4–9: SLICE COMPLETE ✅

- **Task 4 DONE (verified):** contracts gain `VideoStatus` (+ `"failed"`); catalog
  repo/service gain `updateStatus(id, status) → Video | null` (raw SQL `update … returning`).
  No migration needed (`status` is unconstrained TEXT — the Phase 1 #1 seam paying off).
  10 catalog tests green vs real Postgres.
- **Task 5 DONE (verified):** `platform/redis.ts` (URL → BullMQ options,
  `maxRetriesPerRequest: null`); `transcode.producer.ts` (queue `transcode`, `jobId=videoId`
  dedupe, attempts 3, exp backoff 5s, removeOnComplete). **Dedupe proven vs real Redis**
  (enqueue twice → count unchanged). `upload.service` now enqueues after ingest —
  **non-fatal by design** (Redis down ⇒ upload still 201, video stuck at `uploaded`;
  transactional-outbox gap documented, deferred to hardening). 5 tests green.
- **Task 6 DONE (verified):** `transcode/ffmpeg.ts` — every flag traced to doc 08: fixed 2s
  GOP (`-g 60 -keyint_min 60 -sc_threshold 0` @ normalized 30fps — the keyframe hinge),
  capped-CRF (23 + 3M/6M), 4s fMP4 segments + init.mp4, never-upscale
  (`scale=w=-2:h='min(720,ih)'`). Real-encode integration tests: 1080p/10s → playlist with
  `#EXT-X-MAP` + ~4s `#EXTINF`s, probed 1280x720 h264; 640x360 source stays 360p.
- **Task 7 DONE (verified, strict TDD red→green):** `transcode.job.ts` —
  `processTranscodeJob`: getVideo (miss → `UnrecoverableError`) → `transcoding` → download →
  ffmpeg → upload all artifacts (correct content-types) → **only then** `ready`; temp dir
  removed in `finally`; idempotent throughout (at-least-once). 4 unit tests w/ fakes.
- **Task 8 DONE (verified):** `src/worker.ts` — second composition root, BullMQ Worker
  concurrency 1; `failed` handler marks row `failed` ONLY on final attempt **or**
  `UnrecoverableError`; graceful shutdown drains the in-flight job. Scripts: `dev:worker`
  (backend + root). Boot proof: worker listens, creates `streamforge-hls` bucket.
- **Task 9 E2E DONE (real evidence):**
  - Uploaded real 1920x1080/10s mp4 → 201 → worker picked job → `status: ready` in seconds;
    `/health` stayed 200 throughout (separate-process payoff).
  - MinIO `streamforge-hls/<id>/`: `index.m3u8` (VOD, `#EXT-X-MAP:URI="init.mp4"`,
    EXTINF 4+4+2s, ENDLIST) + `init.mp4` + 3 `.m4s`. `ffprobe` on the playlist: h264,
    **1280x720**. Postgres row `ready`.
  - **Failure drill:** worker stopped → upload → `mc rm` raw object → worker started →
    3 attempts w/ backoff (~16s) → row `failed`. Worker log shows attempt 1/2/3 cleanly.
- **Final checkpoint:** build PASS; **25 tests, 0 fail** (was 14 pre-slice).
- **Minor observation (not this slice):** in the E2E curl, the `title` form field fell back
  to the filename (`part.fields` timing in @fastify/multipart?) — worked in Session 4's E2E.
  Investigate during hardening; does not affect the pipeline.
- Git still deferred.

### Session 8 — 2026-08-08 — Phase 1 #4 (ABR ladder + master playlist): SLICE COMPLETE ✅

- **Context:** work resumed on a NEW machine path: repo pushed to GitHub
  (`sourav2024/streamforge`, "chore: initial commit" carried Sessions 1–7 + #4 Tasks 1–2),
  fresh clone, `npm install`, `.env` recreated from example, Docker relaunched — named
  volumes survived, no migrations needed. Somewhere between sessions, plan Tasks 1–2 had
  already landed (concept doc 10, `ladder.ts` + tests, ffprobe `audioCodec`) but left the
  tree broken: `upload.service.test.ts` probe fakes lacked `audioCodec` → typecheck failed.
  Fixed the fakes first; baseline 33 tests green.
- **Task 3 DONE (verified, TDD red→green):** `master.ts` — `buildMasterPlaylist(entries)`
  builds `#EXTM3U`/`#EXT-X-VERSION:7` + one `#EXT-X-STREAM-INF` per rung from MEASURED
  outputs; builder owns highest-first ordering; `BANDWIDTH = round((maxrateK+128)·1000·1.1)`;
  CODECS drops `mp4a.40.2` when the rung is silent (truthful master). Exact-text tests
  (with/without audio).
- **Task 4 DONE (verified):** `buildHlsArgs`/`runFfmpegHls` take a `Rung` — scale
  `min(rung.height,ih)`, per-rung caps, explicit `-level:v` so CODECS is exact. GOP trio
  stays hardcoded ON PURPOSE (parameterizing it would hand callers the IDR-alignment gun).
  New integration test = **alignment evidence:** 480p + 360p from one 1080p/10s source →
  identical segment counts AND identical `#EXTINF` sequences; probed heights 480/360.
- **Task 5 DONE (verified):** `transcode.job.ts` — deps gain `probe`; flow: download →
  probe LOCAL file → `selectRungs` (null height → NORMAL Error: retries, then `failed`) →
  per rung encode → upload under `<id>/<label>/` → ffprobe the rung playlist (measured
  RESOLUTION, not intended) → master uploaded **LAST** (the "ladder complete" artifact) →
  `ready`. Worker injects `probeVideo`. 6 job unit tests incl. master-last ordering,
  master body content, small-source single-rung, probe-null-vs-unknown-video error split.
- **Task 6 E2E DONE (real evidence):**
  - 1080p/10s upload → `ready` in seconds; `streamforge-hls/<id>/`: **21 objects** = 4 rung
    dirs (playlist + init.mp4 + 3 `.m4s` each) + `master.m3u8` (correct content-type).
  - Master exactly per spec: 4 STREAM-INFs highest-first, BANDWIDTH 6740800/3440800/
    1680800/1020800, RESOLUTION 1920x1080/1280x720/854x480/640x360, CODECS
    `avc1.4d4028|4d401f|4d401f|4d401e` + `mp4a.40.2`.
  - **Cross-rung alignment in production output:** all 4 rung playlists show
    `#EXTINF: 4.0, 4.0, 2.0` — identical. ffprobe reads the downloaded master fine
    (4 h264 video streams at the 4 resolutions + aac audio).
  - **Never-upscale:** 640x360/4s upload → exactly 4 objects: ONE `360p/` rung + master
    with a single STREAM-INF.
- **Final checkpoint:** build PASS; **38 tests, 0 fail** (was 33 at session start, 25 in S7).
- **Gotcha logged:** running the suite while the dev worker is up HANGS it — the live
  worker eats the producer test's real Redis jobs (dedupe-count assertions race a consumer).
  Kill dev processes before `npm test`. Recorded as Dev note 2 in Current status.
- **Teach-back:** NOT run (autonomous session) — owed for #4, plus the Session-5
  media-fundamentals quiz remainder. Queued as the next session's first action.

### Session 9 — 2026-08-08 — Phase 1 #5 (Playback Service): SLICE COMPLETE ✅ → PHASE 1 DONE

- **Brainstormed + locked 2 decisions (user chose):** serving model = **proxy through
  backend** (relative URIs untouched; becomes the CDN origin in Phase 4; presigned-rewrite
  documented as the alternative); Phase 1 #4 work stays **uncommitted** for now.
- Docs first (Teaching Contract): concept doc
  `11-playback-serving-and-signed-tokens.md` (HTTP delivery of HLS, proxy-vs-presign,
  backpressure, immutable-vs-playlist caching, WHY the token must live in the URL path —
  relative resolution drops query strings — and HMAC anatomy incl. timingSafeEqual);
  spec `2026-08-08-playback-service-design.md`; plan `2026-08-08-playback-service.md`.
- **Config:** `PLAYBACK_TOKEN_SECRET` (required, fail-fast) + `PLAYBACK_TOKEN_TTL_SECONDS`
  (default 21600) — **add to `.env` when resuming on a fresh clone.**
- **Platform:** `storage.getObjectStream(key)` → `{ body, contentType, contentLength } | null`
  (null on NoSuchKey — missing object is a serving outcome, not an error); body handed to
  Fastify UNCONSUMED so backpressure runs client ← Node ← MinIO. Integration test vs MinIO.
- **Playback module (all TDD red→green):**
  - `playback.tokens.ts` — `<expMs>.<base64url(HMAC-SHA256(secret, videoId:exp))>`;
    videoId inside the MAC but not the token (cross-video replay fails); injectable clock;
    timingSafeEqual. 5 unit tests (round-trip, replay, tamper, expiry, malformed).
  - `playback.routes.ts` — `GET /playback/videos/:id` issues `{ playbackUrl, expiresAt }`
    (404 unknown/non-UUID, **409 not-ready** — ready ⇒ all artifacts exist, the #4
    master-last invariant paying off); serve routes stream master + `:rung/:file` with
    strict shape whitelists (`^\d{3,4}p$`, exactly index.m3u8|init.mp4|seg_\d{5}.m4s),
    403 before any storage read, Cache-Control immutable-for-segments / 60s-for-playlists.
    6 route tests with real Fastify + real tokens, fake catalog/storage.
  - Contracts gain `PlaybackResponse`. `app.ts` wires hlsStorage (API process reads the
    HLS bucket for the first time) + tokens + registerPlayback.
- **E2E (real evidence):** issued URL for the Session-8 1080p video → master through the
  proxy with correct content-type/cache headers → **ffprobe consumed the PROXIED master
  URL end-to-end** (the same GET cascade a player makes: master → rung playlists → init +
  segments; all 4 rungs + aac visible). Drills: tampered token → 403, `evil.txt` → 404,
  bad rung shape → 404, fresh upload with worker off → issue → **409 "video is uploaded,
  not ready"**.
- **Final checkpoint:** typecheck clean; **50 tests, 0 fail** (was 38 after #4).
- **Teach-back:** owed (see Current status). Phase 1 (VOD core) is now COMPLETE:
  upload → probe → queue → ABR ladder → master → signed playback URL → HLS over HTTP.
