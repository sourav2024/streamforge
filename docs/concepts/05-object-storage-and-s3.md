# Concept: Object Storage & the S3 API (MinIO now, S3 later)

> **📖 Concept doc — read before `platform/storage.ts` and the upload path.**
> Part of the Teaching Contract (spec §1). Grounds the Storage & Upload slice
> (`docs/specs/2026-07-08-storage-upload-design.md`).

**Status:** Approved
**Phase:** 1 #1 — Storage & Upload
**Decision:** Store raw media in **object storage** via the **S3 API**, using **MinIO**
locally (spec §4). Client library: `@aws-sdk/client-s3`.

---

## 1. Three ways to store bytes — and why media wants object storage

When an app needs to persist data, there are three broad homes, and picking the wrong one
for large media is a classic mistake:

| Store | Good at | Bad at (for media) |
|-------|---------|--------------------|
| **Relational DB (Postgres)** | structured, queryable, transactional *metadata* | multi-GB blobs bloat the DB, wreck backups/replication, and you can't stream a range out of a row efficiently |
| **Local filesystem** | simple, fast for one box | doesn't scale past one machine, no built-in redundancy/HTTP access, lost if the box dies — *unrealistic for production* (spec §4) |
| **Object storage (S3/MinIO)** | huge immutable blobs, HTTP access, effectively infinite scale, durability, range requests | not for relational queries or transactions |

**The split we adopt:** *metadata* (title, size, codec, status) lives in Postgres;
the *bytes* (the MP4, later the HLS segments) live in object storage. The Postgres row
holds a `storage_key` pointing at the object. This separation is how every real streaming
platform is built — you never stream video *out of a database*.

## 2. What object storage actually is

Object storage is not a filesystem and not a database. It's a flat **key → object** map,
grouped into **buckets**:

- **Bucket** — a top-level namespace/container (ours: `streamforge-raw`). Think "a
  drive," but globally addressable over HTTP.
- **Key** — the object's full string name *within* the bucket, e.g.
  `3f9a.../original.mp4`. Keys can contain `/`, which *looks* like folders, but there are
  **no real directories** — it's a flat keyspace and `/` is just a convention (tools
  render it as a tree). Ours: `<videoId>/original.mp4`.
- **Object** — the bytes plus metadata (content-type, size, ETag, user metadata). Objects
  are **immutable**: you replace them wholesale, you don't edit in place.

There is no "open file, seek, write." You `PutObject` (upload a whole object), `GetObject`
(download, optionally a **byte range** — crucial later for streaming segments),
`DeleteObject`, `HeadObject` (metadata only), and `ListObjectsV2`.

## 3. The S3 API, and why MinIO gives us production parity for free

**S3** (Amazon Simple Storage Service) is the object store that defined the category; its
HTTP API became the **de-facto industry standard**. So many stores implement "the S3 API"
that it's effectively a protocol: AWS S3, Cloudflare R2, Google Cloud Storage (compat
mode), Backblaze B2 — and **MinIO**, an open-source S3-compatible server we run in Docker.

Why this matters for a learning project (spec §4): we write our code against the S3 API
using `@aws-sdk/client-s3`, pointed at MinIO on `localhost:9000`. To move to real S3 in
production, we change **configuration, not code** — swap the `endpoint` and credentials.
We learn the exact production API, with zero cloud cost or credentials while learning.

### The one MinIO-specific knob: path-style addressing

S3 has two URL styles for reaching an object:
- **Virtual-hosted style:** `https://<bucket>.s3.amazonaws.com/<key>` (bucket in the
  hostname). This is AWS's default.
- **Path style:** `http://<host>/<bucket>/<key>` (bucket in the path).

MinIO on a plain `localhost` can't do per-bucket subdomains, so we set
**`forcePathStyle: true`** in the client. That's the single config difference between our
local MinIO and cloud S3. (Knowing *why* it exists saves an afternoon of "why can't it
find my bucket" later.)

## 4. How our code uses it (this slice)

`platform/storage.ts` wraps `@aws-sdk/client-s3` behind a tiny, intention-revealing
interface so the rest of the app never sees AWS SDK types:

```ts
interface Storage {
  ensureBucket(): Promise<void>;                       // create streamforge-raw if absent
  putObjectFromFile(key, filePath, contentType): Promise<void>;
  deleteObject(key): Promise<void>;
}
```

- **`ensureBucket`** runs at startup (`HeadBucket`, else `CreateBucket`) so the first
  upload doesn't 404 on a missing bucket.
- **`putObjectFromFile`** streams a local temp file into MinIO. We pass an explicit
  `ContentLength` (from `stat`) because a stream body has no inherent length and the SDK
  would otherwise buffer the whole file into memory to compute it — bad for large videos.
- **`deleteObject`** exists specifically for the **compensating delete** (see §6).

### Streaming vs. buffering, and why we stage to a temp file

Two independent decisions people conflate:

1. **Never buffer a whole video in memory.** A 500 MB upload buffered as a Node `Buffer`
   is 500 MB of RAM per concurrent upload — it doesn't scale. We **stream**: bytes flow
   from the HTTP request → disk → MinIO in chunks.
2. **Why a temp file at all** (spec §4)? We need the bytes in *two* places: uploaded to
   MinIO **and** read by `ffprobe`. `ffprobe` wants a seekable file path, and re-reading
   from MinIO just to probe would be a wasteful round-trip. So the route streams the
   upload to a temp file, uploads *that* file to MinIO, and probes *that* file, then
   deletes it in a `finally`. Trade-off: we touch local disk transiently (fine at our
   scale). A pure-streaming design that probes inline is possible but more complex; noted
   as a later refinement.

## 5. Presigned URLs — the production upload pattern (our later upgrade)

Today the upload is **proxied**: the client sends the file *to our backend*, which streams
it to MinIO. The backend is in the data path. That's simplest and lets us validate bytes,
and it's fine at our scale.

At real scale, platforms avoid funneling every gigabyte through their API servers using
**presigned URLs**: the backend generates a time-limited, signed S3 URL granting permission
to `PUT` one specific key, hands it to the client, and the client uploads **directly to
S3/MinIO**. The backend never touches the bytes — it only issues the permission and records
metadata afterward. Same signing mechanism secures *downloads* later (Phase 4 signed
playback URLs).

We deliberately build proxied first and add presigned as a documented comparison later
(spec decision, "build it then compare"). Flagging it here so the concept is in place when
we get there.

## 6. Consistency: never leave a half-committed upload

We write to two systems per upload — a MinIO object and a Postgres row — with **no
distributed transaction** between them. If the object is written but the DB insert fails,
we'd have an **orphaned object**: bytes in storage that nothing references. Our rule
(spec §6): after a successful `PutObject`, if the catalog insert throws, we issue a
**compensating `DeleteObject`** to remove the just-written object, then propagate the
error. Order matters — we write MinIO *before* Postgres precisely because "delete the
object we just made" is a simpler, safer undo than the reverse.

Residual risk: if the compensating delete *itself* fails, a rare orphan remains. Production
systems reconcile this with a **background sweeper** (periodically list objects with no
matching DB row and delete them) — deferred, but named here so the gap is understood, not
hidden.

## 7. Trade-offs we accept (this slice)

| We accept | Because |
|-----------|---------|
| Backend in the upload data path (proxied) | Simplest; lets us validate bytes. Presigned is the documented later upgrade. |
| Transient local temp file per upload | `ffprobe` needs a seekable path and we avoid a MinIO re-read. |
| Two-write consistency via compensating delete (not a real transaction) | No cross-system transactions exist; compensation + a future sweeper is the standard pattern. |
| `forcePathStyle` config for MinIO | The one difference from cloud S3; code stays portable. |

## 8. Glossary

- **Object storage** — a flat key→object blob store accessed over HTTP; not a filesystem/DB.
- **Bucket** — top-level container/namespace for objects.
- **Key** — an object's full name within a bucket; `/` is convention, not real folders.
- **Object** — immutable bytes + metadata (content-type, size, ETag).
- **S3 API** — the de-facto object-storage HTTP API; implemented by S3, R2, GCS, MinIO…
- **MinIO** — open-source, self-hostable S3-compatible server (our local store).
- **Path-style vs virtual-hosted** — `host/bucket/key` vs `bucket.host/key` addressing.
- **Presigned URL** — a time-limited signed URL letting a client PUT/GET one object directly.
- **Compensating delete** — undoing a completed storage write when a later step fails.
- **Multipart (disambiguation)** — *HTTP* multipart = the `multipart/form-data` upload
  encoding the client uses; *S3* multipart upload = splitting one huge object into parts.
  Different things; this slice uses HTTP multipart only.

---

**Next:** `06-postgres-data-access.md` — how the metadata half is stored and queried.
