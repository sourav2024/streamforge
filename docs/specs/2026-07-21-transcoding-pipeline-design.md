# Transcoding Pipeline — Design Spec (Phase 1 #3)

> The second vertical slice: turn an uploaded MP4 into playable single-rendition HLS in the
> background. See the master design at `docs/specs/2026-07-08-streamforge-design.md`, the
> media theory in `docs/concepts/08-media-fundamentals.md`, and the progress log at
> `docs/PROGRESS.md`.

**Status:** Design approved — pre-implementation
**Created:** 2026-07-21
**Phase / Module:** Phase 1 #3 — Transcoding Pipeline
**Owner:** Sourav

---

## 1. Goal & scope

When an upload lands (`status: uploaded`), enqueue a background job. A worker downloads the
original from MinIO, runs FFmpeg to produce **one 720p HLS rendition** (media playlist +
fMP4 segments), uploads the outputs to a dedicated bucket, and advances the catalog row
`uploaded → transcoding → ready` (or `failed`). Clients observe progress by polling the
existing catalog endpoints.

**In scope**
- BullMQ queue (`transcode`) over the existing Redis; jobs enqueued by the upload module.
- A **separate worker process** (`worker.ts`, second entrypoint in the same backend app).
- FFmpeg invocation producing 720p capped-bitrate HLS with a **fixed 2s GOP** and 4s
  fMP4 (CMAF) segments — every flag justified by concept doc 08 §§3–6.
- New `streamforge-hls` bucket; outputs under `<videoId>/`.
- Catalog gains `updateStatus`; contract `status` union gains `"failed"`.
- Retries with backoff; `failed` status only after the final attempt.

**Out of scope (later phases)**
- ABR ladder + master playlist — Phase 1 #4 (this rendition is built as rung #1 of it).
- Serving/playback of the HLS artifacts (signed URLs) — Phase 1 #5.
- Transactional outbox for enqueue-vs-DB atomicity; stuck-job sweeper — hardening phase
  (gap documented in §6, same layered honesty as the upload saga's crash gap).
- Progress percentage, webhooks/SSE notifications, audio-only handling — later.

## 2. Decisions locked in brainstorming (2026-07-21)

| Decision | Choice | Why |
|---|---|---|
| Worker topology | **Separate worker process** (`worker.ts`, own npm script) | FFmpeg is CPU-bound; API stays responsive. Mirrors production and teaches the modular-monolith extraction path. |
| Rendition & rate control | **720p, capped bitrate** (CRF 23 + `maxrate 3M/bufsize 6M`) | Exactly one ABR rung built the ABR-correct way (doc 08 §5); Phase 1 #4 adds siblings without rework. Never upscale a smaller source. |
| Output location | **New `streamforge-hls` bucket** | Raw vs derived artifacts have different lifecycles/access policies (originals never served; HLS is, in Phase 1 #5). Physical boundary. |
| Segment format | **fMP4 / CMAF (`.m4s`)** | Modern production format (doc 08 §6); same segments can later serve DASH without re-encoding. ExoPlayer + Safari both play it. |

Locked earlier in the master spec (§4), not re-decided: **BullMQ + Redis**, **self-hosted
FFmpeg**, **HLS**, single rendition now.

## 3. Concept doc (write BEFORE code — Teaching Contract)

One new tool/pattern is introduced by this slice:

1. **`docs/concepts/09-job-queues-bullmq.md`** — why background jobs at all (request/response
   vs long-running CPU work); anatomy of a queue (producer / broker / worker); why Redis fits
   (fast, atomic ops, already in our infra); BullMQ job lifecycle (waiting → active →
   completed/failed, delayed, stalled); **at-least-once delivery ⇒ handlers must be
   idempotent**; retries + exponential backoff; `jobId` dedupe; worker concurrency (and why
   ours is 1: FFmpeg saturates cores on its own); graceful shutdown; alternatives
   (in-process queue, pg-boss, RabbitMQ, SQS, Kafka) and why BullMQ here; trade-offs
   (Redis persistence caveats, no exactly-once). Glossary.

The media theory (GOP, keyframe alignment, rate control, playlists, fMP4) is already covered
by doc 08 — the FFmpeg flags in §5 cite it rather than re-explaining.

## 4. Architecture & data flow

```
Client                                   ┌──────────── Redis ────────────┐
  │ POST /upload/videos                  │   BullMQ queue: "transcode"   │
  ▼                                      └───▲──────────────────────┬────┘
┌── apps/backend: API process (main.ts) ────┼──────┐   ┌── apps/backend: WORKER process (worker.ts) ──┐
│ modules/upload/                           │      │   │  BullMQ Worker (concurrency 1)               │
│   upload.service.ingest()                 │      │   │    modules/transcode/transcode.job.ts        │
│     ...existing saga (store+probe+row)    │      │   │      1. catalog.getVideo(videoId)            │
│     THEN transcode.enqueue(videoId) ──────┘      │   │      2. catalog.updateStatus → 'transcoding'  │
│         (producer, via transcode/index.ts)       │   │      3. rawStorage.getObjectToFile → temp    │
│ modules/catalog/  (owns videos table)            │   │      4. ffmpeg → temp outdir (HLS)           │
│   + updateStatus(id, status)  ◀──────────────────┼───│      5. hlsStorage.put playlist+init+segs    │
│ modules/transcode/ (producer surface only here)  │   │      6. catalog.updateStatus → 'ready'       │
└───────────────┬──────────────────────────────────┘   │  on final failed attempt → 'failed'          │
                ▼                                       └──────┬──────────────────┬────────────────────┘
        MinIO streamforge-raw/                                 ▼                  ▼
        <id>/original.mp4                     MinIO streamforge-hls/       Postgres videos.status
                                              <id>/index.m3u8, init.mp4,   uploaded→transcoding→
                                              seg_00000.m4s, ...           ready | failed
```

**Sequence:**
1. `upload.service.ingest()` completes its existing saga (object stored, row created),
   then calls `transcode.enqueue(videoId)` — the producer half of the transcode module,
   imported only via its `index.ts` (boundary rule, same as `upload → catalog`).
2. Job lands on BullMQ queue `transcode` with `jobId = videoId` (idempotent enqueue: a
   duplicate enqueue for the same video is a no-op), `attempts: 3`, exponential backoff (5s).
3. The **worker process** (own composition root in `worker.ts`: config → pool → storages →
   catalog → BullMQ Worker) picks the job up and runs `processTranscodeJob`:
   set `transcoding` → download original to a temp dir → run FFmpeg (§5) → upload every
   output file to `streamforge-hls/<videoId>/` → set `ready` → temp dir removed in `finally`.
4. If an attempt throws, BullMQ retries (job re-enters `waiting` after backoff; the handler
   re-runs from the top — safe because every step is idempotent: re-download overwrites,
   re-encode overwrites, S3 PUT overwrites, status re-set is a no-op).
5. Only when the **final** attempt fails does the worker's `failed` handler set
   `status = 'failed'` (checked via `attemptsMade >= attempts`).

**Why the worker is a second process but the same codebase:** it reuses `platform/` and
`modules/` through its own composition root — the modular monolith's promise that a module
can later be *extracted* starts by proving it can be *re-hosted*. Dev runs both:
`npm run dev` (API) and `npm run dev:worker`.

## 5. The FFmpeg invocation (every flag earns its place)

```bash
ffmpeg -y -i <tmp>/original.mp4 \
  -vf "scale=w=-2:h='min(720,ih)'" \        # 720p rung; never upscale a smaller source (doc 08 §7)
  -r 30 \                                    # normalize fps so GOP arithmetic is exact
  -c:v libx264 -profile:v main -pix_fmt yuv420p -preset veryfast \  # universal decode (doc 08 §3a)
  -crf 23 -maxrate 3000k -bufsize 6000k \    # capped-CRF: quality target with a hard ceiling — the ABR-rung discipline (doc 08 §5)
  -g 60 -keyint_min 60 -sc_threshold 0 \     # FIXED 2s GOP @30fps; no scene-cut keyframes → predictable, alignable keyframes (doc 08 §4)
  -c:a aac -b:a 128k -ac 2 \                 # AAC stereo (skipped gracefully if source has no audio)
  -f hls -hls_time 4 -hls_playlist_type vod \  # 4s segments = exactly 2 GOPs, each starting on a keyframe
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \  # CMAF segments (decision §2)
  -hls_segment_filename <tmp>/out/seg_%05d.m4s \
  <tmp>/out/index.m3u8
```

The keyframe story (doc 08 §4, the quiz question we skipped — now applied for real): a
segment must start on a keyframe or a player can't join mid-stream, so we force keyframes
every 2s (`-g 60` at 30fps) and *forbid* the encoder from adding extra ones on scene cuts
(`-sc_threshold 0`), which would desync GOP from segment boundaries. `-hls_time 4` then cuts
segments on those keyframes. In Phase 1 #4 the identical `-g/-r/-sc_threshold` trio across
every rung is what makes renditions **IDR-aligned** for seamless ABR switching.

**Output layout** (bucket `streamforge-hls`):

| Key | Content-Type |
|---|---|
| `<videoId>/index.m3u8` | `application/vnd.apple.mpegurl` |
| `<videoId>/init.mp4` | `video/mp4` |
| `<videoId>/seg_00000.m4s` … | `video/iso.segment` |

No new DB column: playlist location is derivable by convention (`<id>/index.m3u8` in the
HLS bucket). Revisit if playback (Phase 1 #5) needs more.

## 6. Error handling & delivery semantics

Core principle: **`status` must always tell the truth**, and a retryable failure must leave
the system re-runnable (idempotent handler).

| Failure point | Behavior |
|---|---|
| Enqueue fails after DB row written (Redis down) | **Non-fatal**: upload still returns 201 (`status: uploaded`); error logged. Video is *stuck* until re-enqueued. Honest gap — the real fix is a transactional outbox / reconciling sweeper, deferred to hardening (mirrors the upload saga's crash gap, spec §6 of Phase 1 #1). |
| Video row not found in job | Unrecoverable — fail the job immediately without retries (nothing to transcode). |
| Download / FFmpeg / upload throws | Attempt fails → BullMQ retries (3 attempts, exp. backoff 5s). Handler is idempotent, so re-running from the top is safe. Temp dir removed in `finally` every attempt. |
| Final attempt fails | Worker `failed` handler sets `status = 'failed'` (only then — intermediate failures leave `transcoding`). |
| Worker process crashes mid-job | BullMQ stalled-job detection re-queues the job for another worker/restart — at-least-once delivery, which is *why* idempotency is a hard requirement, not a nicety. |
| Partial HLS upload then crash | Orphaned partial objects under `<id>/` in the hls bucket; the retry overwrites them. `ready` is set only after **all** files uploaded, so no one is told to play a partial rendition. |

Status transitions are unguarded writes for now (`updateStatus(id, status)`); a real state
machine (reject `ready → transcoding` etc.) is noted as a future catalog-service rule —
that's exactly the seam the thin service exists for.

## 7. Testing & verification

- **Unit** (`transcode.job` with faked catalog/storages/ffmpeg-runner): happy path drives
  statuses `transcoding → ready` and uploads playlist+init+segments with correct
  content-types; ffmpeg failure rethrows *without* setting `ready`; missing video fails
  without retry; temp cleanup runs on failure.
- **Integration — real FFmpeg** (`ffmpeg.ts` test): run the real invocation on a generated
  fixture (reuse `make-fixture.ts`, extended to produce a ≥8s source so multiple segments
  exist); assert `index.m3u8` exists and references `init.mp4` + ≥2 `.m4s` segments; assert
  segment duration ≈ 4s from the playlist; assert output height ≤ 720 (probe an output).
- **Integration — real Redis**: enqueue with `jobId = videoId` twice → one job (dedupe).
- **E2E (the real proof):** boot API + worker; upload a real MP4; poll
  `GET /catalog/videos/:id` until `status: "ready"`; verify objects in
  `streamforge-hls/<id>/` via `mc ls`; **play the proof** — `ffprobe` the produced
  `index.m3u8` and confirm h264, ≤720 height. Then a failure drill: enqueue a video whose
  object was deleted → after retries, `status: "failed"`.
- **Runner:** Node `node:test` + `tsx`, as established.

## 8. New dependencies (introduced this slice)

- `bullmq` — the queue library (brings `ioredis` transitively). Justified in concept doc 09.
- FFmpeg (already installed, 8.1.2) — now invoked for transcoding, not just probing.

**New env vars:** `REDIS_URL=redis://localhost:6379`, `S3_BUCKET_HLS=streamforge-hls`.

**Platform changes:** `platform/storage.ts` becomes bucket-parameterized
(`createStorage(config, bucket)`) so the composition roots build `rawStorage` + `hlsStorage`
from one implementation; gains `getObjectToFile(key, destPath)`. `platform/redis.ts` (new)
owns the BullMQ-compatible Redis connection options.

## 9. Success criteria

- Uploading a real MP4 returns 201, and *without any further client action* the row reaches
  `status: "ready"` (observed by polling the catalog).
- `streamforge-hls/<id>/` contains `index.m3u8`, `init.mp4`, and ≥2 `.m4s` segments with
  correct content-types.
- The playlist is genuinely playable: `ffprobe` reads it and reports h264, height ≤ 720.
- Keyframe discipline is real: segments are ~4s and the encoder emitted a fixed 2s GOP
  (verified on one output segment/probe).
- A doomed job (missing source object) ends `status: "failed"` after 3 attempts, and the
  API process stayed responsive throughout a transcode (separate-process payoff).
- Concept doc 09 written before any queue code; PROGRESS.md updated with evidence.
