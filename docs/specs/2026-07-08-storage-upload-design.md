# Storage & Upload — Design Spec (Phase 1 #1)

> The first real vertical slice of StreamForge: accept an MP4, store it, record it,
> read it back. See the master design at
> `docs/specs/2026-07-08-streamforge-design.md` and the progress log at `docs/PROGRESS.md`.

**Status:** Design approved — pre-implementation
**Created:** 2026-07-08
**Phase / Module:** Phase 1 #1 — Storage & Upload
**Owner:** Sourav

---

## 1. Goal & scope

Deliver a working end-to-end ingest slice: a client uploads an MP4; the backend stores the
raw file in MinIO (S3-compatible object storage), extracts real media metadata with
`ffprobe`, records a catalog row in Postgres, and can list/get uploaded videos.

**In scope**
- `POST /upload/videos` — multipart upload (file + title), proxied through the backend.
- Content-type + size validation.
- Store raw MP4 in MinIO under an app-controlled key.
- `ffprobe` the stored file for duration/resolution/codec.
- Record metadata in Postgres (`videos` table) via the `catalog` module.
- `GET /catalog/videos` and `GET /catalog/videos/:id` — read the catalog back.
- First real use of: raw-SQL data access + migrations, an S3 client, and a cross-module
  interface call (`upload` → `catalog`).

**Out of scope (later phases)**
- Transcoding / BullMQ / FFmpeg worker — Phase 1 #3. (We add the `status` seam now.)
- Presigned direct-to-MinIO upload — documented as the later upgrade to the proxied path.
- Auth / signed playback URLs — Phase 4.
- Pagination, search, deletion endpoints — not needed for the slice (YAGNI).

## 2. Decisions locked in brainstorming

| Decision | Choice | Why |
|---|---|---|
| DB access | **Raw SQL (`pg`) + migration tool** | Maximum transparency; "nothing is a black box." ORM deferred. |
| Upload path | **Proxied through the backend** | Simplest working slice; backend sees bytes to validate. Presigned = later upgrade. |
| Validation | **Basic guards + `ffprobe` metadata** | Content-type + size cap; real media inspection pulled forward (useful for transcoding). |
| Module split | **Two modules: `upload` + `catalog`** | Faithful to target architecture; exercises the modular-monolith cross-module interface for real. |

## 3. Concept docs (write BEFORE code — Teaching Contract)

Three new topics are introduced by this slice; each gets a doc first:

1. **`docs/concepts/05-object-storage-and-s3.md`** — object storage vs. filesystem/DB; the
   S3 API model (buckets, keys, objects, `PutObject`/`GetObject`); why media blobs belong
   in object storage; MinIO ↔ S3 portability; streaming vs. buffering an upload; presigned
   URLs (conceptual, flagged as our later upgrade).
2. **`docs/concepts/06-postgres-data-access.md`** — the `pg` driver; connection pooling
   (why a pool); parameterized queries (`$1` and SQL-injection safety); migrations
   (what/why, forward-only, up/down files); why raw SQL over an ORM for now.
3. **`docs/concepts/07-media-metadata-ffprobe.md`** — containers vs. codecs (preview of the
   fuller Media Fundamentals doc, Phase 1 #2); what `ffprobe` reads; which fields matter
   for the catalog and later transcoding.

## 4. Architecture & data flow

```
Client
  │  POST /upload/videos   (multipart/form-data: file=<mp4>, title=<string>)
  ▼
┌─────────────────── apps/backend (Fastify modular monolith) ────────────────────┐
│                                                                                 │
│  modules/upload/                          modules/catalog/                      │
│    upload.routes.ts   ── validates ──▶      index.ts  (public interface)        │
│    upload.service.ts                          catalogService.createVideo(meta)  │
│      1. guard content-type + size             catalogService.listVideos()       │
│      2. stream file ─────────────┐            catalogService.getVideo(id)       │
│      3. ffprobe the stored file  │              │                               │
│      4. call catalog to record ──┼──────────────┘ owns the `videos` table       │
│                                  │                catalog.repository.ts (SQL)   │
│  platform/                       │                                              │
│    storage.ts (S3 client) ◀──────┘                platform/db.ts (pg Pool)      │
└────────┼────────────────────────────────────────────────────┼──────────────────┘
         ▼                                                      ▼
   MinIO bucket:                                         Postgres:
   streamforge-raw/<videoId>/original.mp4                videos (see §5)
```

**Sequence:**
1. Client `POST`s multipart (`file` + `title`) to `/upload/videos`.
2. `upload` module validates content-type (`video/mp4`) and enforces a max size.
3. It streams the bytes into MinIO under key `<videoId>/original.mp4` in the
   `streamforge-raw` bucket (`videoId` = fresh `crypto.randomUUID()`).
4. It runs `ffprobe` to extract duration, width, height, video codec. Mechanism: the
   upload is streamed to a temporary local file first; that temp file is both the source
   uploaded to MinIO and the target `ffprobe` reads, then it is deleted. (Probing a local
   temp file is simpler and more reliable than re-streaming from MinIO; the temp-file
   trade-off vs. pure streaming is noted in concept doc 05.)
5. It calls `catalogService.createVideo({...})` — **only** through `catalog`'s `index.ts`.
6. `catalog` inserts one `videos` row and returns the created record.
7. Response: `201` with the created video record (shape from `@streamforge/contracts`).

**Boundary rule in action (the lesson):** `upload` never imports or queries the `videos`
table; it calls `catalogService`. `platform/storage.ts` (S3 client) and `platform/db.ts`
(pg `Pool`) are shared infrastructure, constructed once and injected at the composition
root (`app.ts`) into each module's `register(app, deps)`. This is DI by hand (master spec
§4) and matches `docs/concepts/02-why-modular-monolith.md`.

## 5. Data model — `videos` table

```sql
CREATE TABLE videos (
  id            UUID PRIMARY KEY,                     -- app-generated (crypto.randomUUID)
  title         TEXT NOT NULL,
  storage_key   TEXT NOT NULL UNIQUE,                 -- MinIO object key: <id>/original.mp4
  size_bytes    BIGINT NOT NULL,
  content_type  TEXT NOT NULL,                        -- e.g. video/mp4
  duration_s    DOUBLE PRECISION,                     -- ffprobe (nullable if probe fails)
  width         INTEGER,                              -- ffprobe
  height        INTEGER,                              -- ffprobe
  video_codec   TEXT,                                 -- ffprobe, e.g. h264
  status        TEXT NOT NULL DEFAULT 'uploaded',     -- uploaded -> transcoding -> ready (later)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Deliberate choices:
- **`status` now** though the only value today is `'uploaded'` — it is the seam the
  transcoding phase (#3) plugs into (`uploaded → transcoding → ready`). Cheap now, awkward
  to retrofit.
- **ffprobe fields nullable** — if probe fails the upload still succeeds (file stored + row
  written) with null metadata. Storage integrity does not depend on probe success.

The contract type (`packages/contracts`) mirrors these columns as a `Video` interface plus
a `CreateVideoResponse`, so backend and future client agree on shape.

## 6. Error handling

Core principle: **never leave a half-committed upload** — the MinIO object and the Postgres
row must not drift apart.

| Failure point | Behavior |
|---|---|
| Wrong content-type / over size cap | **400** early (multipart limits) — nothing stored. |
| MinIO write fails | **502/500**; no Postgres row written — nothing to clean up. |
| `ffprobe` fails | **Non-fatal** — log; store row with null metadata; upload succeeds. |
| Postgres write fails *after* MinIO succeeded | **Compensating delete**: remove the just-written MinIO object, then **500**. Prevents orphaned blobs. |
| Duplicate `storage_key` | Practically impossible (fresh UUID); `UNIQUE` constraint is the backstop. |

Ordering: **validate → write temp file → upload to MinIO → probe temp file → DB write →
(on DB failure) delete MinIO object → always delete temp file.** MinIO write precedes the
DB write because the compensating action (delete an object) is simpler/safer than the
reverse. The local temp file is removed in a `finally` regardless of outcome.
Residual risk: if the compensating delete *itself* fails, a rare orphan object remains; a
production system reconciles this with a background sweeper (deferred, noted in the concept
doc).

## 7. Testing & verification

- **Unit** (`upload.service`, `catalog` service/repo with storage + repo faked): validation
  rejects bad input; compensating-delete fires on simulated DB failure; ffprobe-failure
  path stores nulls; `createVideo` builds the correct row.
- **Integration** (against the running Docker infra): upload a small real MP4 → assert it
  exists in MinIO **and** as a Postgres row with correct probed metadata → `GET` it back.
  The true end-to-end proof of the slice.
- **Runner:** Node built-in `node:test` + `tsx` — no extra framework (consistent with "no
  black box"). A tiny sample MP4 fixture generated once via ffmpeg lives under the test dir.
- **Manual evidence** (same bar as Phase 0): boot backend, `curl -F` a real upload, confirm
  the object in the MinIO console (`:9001`) and the row via `psql`.

## 8. New dependencies (introduced this slice)

- `pg` — Postgres driver (raw SQL + pooling).
- A migration runner — **node-pg-migrate** (plain SQL/JS migrations, no ORM).
- `@aws-sdk/client-s3` — S3 client (talks to MinIO now, real S3 later unchanged).
- `@fastify/multipart` — streaming multipart upload parsing + size limits.
- `ffprobe` — already installed (FFmpeg 8.1.2, master spec §8); invoked as a subprocess.

Each is introduced/justified in its concept doc or inline when first used.

## 9. Success criteria

- `POST /upload/videos` with a real MP4 returns `201` and a video record with correct
  `size_bytes`, `content_type`, and (when probe succeeds) `duration_s`/`width`/`height`/
  `video_codec`.
- The object exists in MinIO under `streamforge-raw/<id>/original.mp4`.
- A matching `videos` row exists in Postgres with `status = 'uploaded'`.
- `GET /catalog/videos` lists it; `GET /catalog/videos/:id` returns it.
- Failure paths behave per §6 (verified by tests, including the compensating delete).
- Concept docs 05–07 written before their code.
