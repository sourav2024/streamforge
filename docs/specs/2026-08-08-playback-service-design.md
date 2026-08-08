# Playback Service — Design (Phase 1 #5)

> The delivery slice: the HLS tree that #3/#4 put in MinIO becomes something a real
> player can stream over HTTP, gated by an expiring signed token. Concept doc:
> `docs/concepts/11-playback-serving-and-signed-tokens.md`.

**Status:** Design approved
**Created:** 2026-08-08
**Phase / Module:** Phase 1 #5 — Playback Service
**Owner:** Sourav

---

## 1. Goal & scope

A new `playback` module that (a) issues an expiring, HMAC-signed playback URL for a
`ready` video, and (b) serves `master.m3u8`, rung playlists, `init.mp4` and `.m4s`
segments by streaming them from MinIO through Fastify — correct content types, honest
cache headers, zero buffering.

**In scope:** `platform/storage.ts` gains `getObjectStream`; token mint/verify
(`playback.tokens.ts`); serve routes; catalog gate at issuance (`ready` only); E2E proof
with ffprobe consuming the proxied master end-to-end.

**Out of scope (per doc 11 §7):** CDN, presigned URLs, revocation, DRM (Phase 4);
Range/byte-serving (players fetch whole segments; ExoPlayer needs no ranges for fMP4 VOD);
the web/RN player itself (Phase 2).

## 2. Decisions locked (2026-08-08)

| Decision | Choice | Why |
|---|---|---|
| Serving model | **Proxy through backend** (user-picked) | Simplest honest thing; relative URIs untouched; becomes the CDN origin in Phase 4. Doc 11 §2. |
| Access control | **Path-embedded HMAC token** `<exp>.<sig>` | Survives relative URI resolution (query strings don't — doc 11 §5); stateless verify on the segment hot path. |
| Token scope | **videoId + exp**, TTL default 6h | MAC binds the token to one video; short-lived bounds leaks. TTL configurable (`PLAYBACK_TOKEN_TTL_SECONDS`). |
| Issuance gate | **Catalog check at issue-time only** | `ready` ⇒ master + all rungs exist (master-last invariant from #4). Serve routes verify only the token — no DB on the hot path. |
| Cache headers | Segments/init `max-age=31536000, immutable`; playlists `max-age=60` | Doc 11 §4 — segments never change; playlists are entry points. |

## 3. API

```
GET /playback/videos/:videoId          issue a playback URL
  200 { playbackUrl: "/playback/<id>/<exp>.<sig>/master.m3u8", expiresAt: ISO }
  404 unknown id (or non-UUID)         409 video not ready (uploaded/transcoding/failed)

GET /playback/:videoId/:token/master.m3u8         the entry point
GET /playback/:videoId/:token/:rung/:file         rung playlist / init / segment
  200 streamed body + Content-Type + Cache-Control
  403 bad signature / expired / token minted for another video
  404 non-UUID id, malformed rung/file, or object missing in MinIO
```

`:rung` must match `^\d{3,4}p$`, `:file` must match
`^(index\.m3u8|init\.mp4|seg_\d{5}\.m4s)$` — the routes can only ever address artifacts
the transcode job writes; no traversal, no surprise keys.

## 4. Module shape

```
modules/playback/
  playback.tokens.ts   mint/verify: HMAC-SHA256(secret, `${videoId}:${exp}`), base64url,
                       timingSafeEqual; clock injectable for tests
  playback.routes.ts   the three routes above; deps = { catalog, hlsStorage, tokens }
  index.ts             registerPlayback + public types
```

Config: `PLAYBACK_TOKEN_SECRET` (required — fail-fast), `PLAYBACK_TOKEN_TTL_SECONDS`
(default 21600). `app.ts` constructs hlsStorage (first time in the API process) + tokens
and wires the module.

## 5. Serving flow (per request)

verify token (403) → validate rung/file shape (404) → `hlsStorage.getObjectStream(
"<id>/[<rung>/]<file>")` → `null` ⇒ 404 → else stream body to reply with Content-Type
from storage (fallback `contentTypeFor`) + cache header by artifact kind. The body is a
`Readable` piped by Fastify — backpressure end-to-end, flat memory (doc 11 §3).

## 6. Testing & verification

- **Unit:** tokens (round-trip, tamper, expiry, cross-video replay, constant-time path);
  routes with fake catalog/storage/tokens (issue 200/404/409; serve 200 with right
  headers, 403 variants, 404 variants).
- **Integration:** `getObjectStream` round-trip vs real MinIO (+ missing key ⇒ null).
- **E2E:** issue URL for the Session-8 1080p video → `curl` master through the proxy →
  **`ffprobe` the proxied master URL** (walks rung playlist + segments through the proxy —
  the same request cascade a player makes); tampered token → 403; expired token → 403;
  not-ready video → 409.

## 7. Success criteria

ffprobe consumes the entire proxied tree (all 4 rungs visible); every 403/404/409 drill
returns the designed status; suite green; concept doc precedes code; PROGRESS updated.
