# 11 — Playback serving: HTTP delivery of HLS + signed tokens

> Phase 1 #5. How the artifacts from #3/#4 actually reach a player, why we proxy them
> through the backend for now, and why the access token lives in the URL *path*.
> Builds on doc 08 §6 (playlists/segments) and doc 10 (master/rungs).

## 1. Streaming is just HTTP file serving

The revelation of HLS (doc 08 §6): there is no magic streaming protocol on the wire. A
player "streams" by issuing plain HTTP GETs:

```
GET master.m3u8          → pick a rung (BANDWIDTH/RESOLUTION/CODECS)
GET 720p/index.m3u8      → learn the segment list
GET 720p/init.mp4        → codec init data (fMP4)
GET 720p/seg_00000.m4s   → decode + render, measure download speed
GET 720p/seg_00001.m4s   → …repeat; switch rungs at any segment boundary
```

So "the playback service" is: given a videoId, deliver those files over HTTP with the
right `Content-Type`, only to clients allowed to watch. Everything else (ABR logic,
buffering, seeking) happens **in the player** — the server stays dumb. That asymmetry is
why HLS scales: dumb servers/CDNs, smart clients.

**Relative URIs are the load-bearing detail.** Our playlists reference `720p/index.m3u8`
and `seg_00000.m4s` relatively (doc 10 §3). The player resolves them against the URL it
fetched the playlist FROM. Serve the master from *any* base URL and the whole tree follows
— that is what makes the `<id>/` prefix relocatable across proxy, CDN, or bucket.

## 2. Three ways to serve a private bucket (why-this-not-that)

MinIO buckets are private — a player can't fetch `s3://streamforge-hls/...` directly.

| Approach | How | Trade-offs |
|---|---|---|
| **Proxy through backend** ← chosen | Fastify GETs the object from MinIO, streams it to the client | Simplest honest thing; relative URIs untouched; one auth point; we learn Node stream plumbing. Cost: every media byte transits Node — fine for dev/learning, a non-starter at scale. |
| Presigned URL rewrite | Fetch playlist, rewrite every URI into a presigned S3 URL, player hits storage directly | Offloads bytes from Node, but adds playlist-rewriting machinery, and presigned-per-segment is exactly what a CDN replaces in production (Phase 4 #10/#11). |
| Public bucket | Make the bucket world-readable | No access control at all — not even worth the demo. |

The production answer is **CDN in front + edge-validated tokens** (Phase 4). The proxy is
not a toy though: origin servers behind CDNs do exactly this job (the CDN just absorbs
~99% of the GETs), so what we build now becomes the *origin* later.

## 3. Streaming through Node: backpressure, not buffering

The proxy must NEVER buffer a segment into memory (`Buffer.concat` and friends): a 150 KB
segment seems harmless, but N concurrent viewers × any-size objects is how origin servers
fall over. The S3 SDK gives the object body as a `Readable`; Fastify accepts a `Readable`
as the reply payload and **pipes** it — when the client is slow, the pipe stalls, the TCP
window fills, and MinIO stops sending. That end-to-end stall is backpressure: memory use
stays flat at the pipe's high-water mark regardless of object size or client speed. Same
rule as storage.ts put/get (doc 05) — bytes flow through, never accumulate.

## 4. Caching semantics: immutable vs mutable

HTTP caching is the free lunch of VOD serving — but only if we say the right things:

- **Segments + init.mp4:** content-addressed by videoId + rung + index and NEVER rewritten
  (the job overwrites wholesale on retry, doc 09 §5). So:
  `Cache-Control: public, max-age=31536000, immutable` — any cache may keep them a year;
  `immutable` even suppresses revalidation.
- **Playlists:** for our VOD they're write-once too, but they are the *entry points* —
  a re-transcode or a future live playlist mutates them. Short TTL:
  `Cache-Control: public, max-age=60`. Cheap to refetch (a few hundred bytes), and it
  keeps the mental model right for live HLS where the media playlist changes every segment.

Caches key by the **full URL** — token included. Two viewers get different tokens, so
their segment URLs differ and a shared cache stores the bytes twice. That waste is a known
cost of URL-embedded auth; Phase 4's CDN tokens solve it (signed cookie / edge validation).

## 5. Why the token lives in the PATH, not the query string

The obvious design — `master.m3u8?token=abc` — **breaks silently**. RFC 3986 relative
resolution replaces the query string: resolving `720p/index.m3u8` against
`/playback/<id>/master.m3u8?token=abc` yields `/playback/<id>/720p/index.m3u8` — token
gone, segment request 403s. The player fetched the master fine and then died on every
child request. (Real-world fixes: rewrite every URI to carry the query — back to playlist
rewriting — or cookies, which mobile players handle badly.)

Put the token in a **path segment** and relative resolution *propagates* it for free:

```
/playback/<id>/<token>/master.m3u8
  + "720p/index.m3u8"   → /playback/<id>/<token>/720p/index.m3u8   ✓
  + "seg_00000.m4s"     → /playback/<id>/<token>/720p/seg_00000.m4s ✓
```

Every CDN token-auth scheme (Akamai, CloudFront path policies, Fastly) has this same
"token must survive relative resolution" shape — we're learning the real pattern, small.

## 6. The token itself: HMAC, stateless, expiring

`token = <exp>.<base64url(HMAC-SHA256(secret, videoId + ":" + exp))>`

- **HMAC-SHA256** — the workhorse of URL signing. Only holders of the server secret can
  produce a valid signature; anyone can *carry* it. No DB row per grant, no lookup on the
  hot path — verification is one hash. Stateless like a JWT, minus the baggage (we sign
  exactly two fields; a JWT would spend hundreds of bytes saying the same thing).
- **The videoId is inside the MAC but not the token.** The serve route re-computes the MAC
  from the *path's* videoId — a token minted for video A, replayed against video B, fails
  because the recomputed MAC differs. Signing the URL's meaning, not just its expiry.
- **`exp` is plaintext but tamper-evident:** change it and the MAC no longer matches.
- **Verify with `timingSafeEqual`,** never `===` — string comparison bails at the first
  wrong byte, and that timing difference leaks how much of a forged MAC is correct
  (byte-at-a-time forgery). Constant-time compare closes the side channel.
- **No revocation** — a leaked token works until `exp`. Short TTLs bound the damage;
  real revocation needs state (session store / key rotation) — Phase 4 #11 territory.

Issuance (`GET /playback/videos/:id`) checks the catalog: video exists AND `status:
"ready"` (master-last from #4 guarantees ready ⇒ every artifact present). Serving checks
only the token — the whole point is that segment requests skip the DB.

## 7. What Phase 4 changes (so we know what this isn't)

- **CDN** absorbs segment traffic; this proxy becomes the origin (§2).
- **Signed URLs/cookies at the edge** replace our path token for scale; same HMAC idea,
  validated by the CDN instead of Node.
- **DRM (Widevine)** — tokens gate *access to files*; DRM gates *ability to decrypt*.
  Orthogonal layers, both used by every real service.

## 8. Glossary

- **Origin (server)** — the authoritative source a CDN fetches from on cache miss.
- **Backpressure** — downstream slowness propagating upstream through a pipe, capping memory.
- **`immutable`** — Cache-Control extension: "never revalidate this, it cannot change."
- **HMAC** — hash-based message authentication code; keyed hash proving integrity + origin.
- **Presigned URL** — S3 URL carrying a time-limited signature for one object/verb.
- **Token replay** — reusing a captured credential in a different context; scoping the MAC
  to the videoId is the countermeasure here.
