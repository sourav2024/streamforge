# Concept: The ABR ladder and the master playlist

> **📖 Concept doc — written before the ABR slice (Phase 1 #4) per the Teaching Contract.**
> Doc 08 established *why* adaptive bitrate exists (§5–§6) and why it demands IDR-aligned
> keyframes (§4.3). This doc covers what we actually design and author in this slice: the
> **ladder** (which renditions, at which bitrates, and why) and the **master playlist**
> (the file that advertises them to the player). Spec:
> `docs/specs/2026-07-22-abr-ladder-design.md`.

**Status:** Approved
**Phase:** 1 #4 — ABR ladder + master playlist

---

## 1. What a player actually does with ABR

Mechanics first, because they justify every design rule below. A player given a master
playlist:

1. Downloads the master → sees the menu of renditions (bitrate + resolution each).
2. Starts conservatively (often the lowest or a middle rung), begins fetching that
   rendition's segments, and **measures real throughput** from each download.
3. Before each next segment, asks: "does my measured bandwidth comfortably exceed a higher
   rung's `BANDWIDTH`? Is my buffer healthy?" If yes, it fetches the *next segment* from the
   better rendition; if the buffer is draining, it drops down.
4. The switch happens **at a segment boundary** — which only produces seamless video if the
   new segment starts with a keyframe at exactly the same timestamp the old rendition would
   have had one. That is IDR alignment (doc 08 §4.3), and it's why our GOP flags
   (`-r 30 -g 60 -keyint_min 60 -sc_threshold 0`) must be *byte-identical across every
   rung*. The ladder is one decision, not N independent encodes that happen to coexist.

Everything the player needs for step 3 must be *advertised honestly* — which is the whole
job of the master playlist and the reason rung bitrates are capped, not aspirational.

## 2. Designing the ladder

A ladder is a set of (resolution, bitrate) pairs. Three principles shape ours:

- **Bitrate is the axis, resolution follows** (doc 08 §5). The player switches on
  bandwidth; resolution is how we *spend* each bandwidth budget best. At ~800 kbit/s,
  spending it on 360p looks better than starving 1080p with it — starved high resolution
  produces blockier video than honest low resolution.
- **~1.5–2× spacing between rungs.** Too close (3.0 vs 3.5 Mbit/s) wastes storage/encode on
  imperceptible steps; too far (6 → 0.8) forces jarring quality cliffs. Geometric-ish
  spacing gives the player a usable step for most bandwidth situations.
- **Bits-per-pixel sanity check.** bitrate ÷ (width × height × fps) ≈ 0.05–0.15 for decent
  h264. Our 720p rung: 3,000,000 ÷ (1280·720·30) ≈ 0.11 — comfortable. The 1080p rung:
  6,000,000 ÷ (1920·1080·30) ≈ 0.10. Consistent quality across rungs, by design not luck.

Our ladder (spec §3): **1080p@6M, 720p@3M, 480p@1.4M, 360p@0.8M** — a standard VOD shape.
Production systems go further with **per-title encoding** (analyze each video's complexity
and bend the ladder per title — cartoons need far fewer bits than confetti); we note it and
defer it.

**Never upscale, at two levels.** A 480p source gets rungs 480p and 360p only. Upscaling
would *spend more bits to show less detail than the source has* — the label would lie.
Enforced twice: rung *selection* (skip rungs taller than the source) and the scale filter
(`min(height,ih)`) as a belt-and-suspenders inside each encode.

## 3. The master playlist, attribute by attribute

The master is a text file we author ourselves this slice — because every attribute is a
promise to the player, and writing it teaches what's being promised:

```
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=6740800,RESOLUTION=1920x1080,CODECS="avc1.4d4028,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3440800,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8
...
```

- **`BANDWIDTH` — the peak, not the average.** The spec (RFC 8216) says this must be an
  upper bound of the stream's bitrate. The player uses it as "can I afford this rung?" — if
  we under-declare, the player picks a rung it can't sustain and rebuffers. Ours =
  `(maxrate + 128k audio) × 1.1` container overhead. This is *why* rungs are encoded with
  capped-CRF (doc 08 §5): CRF alone has no cap, so there'd be no honest number to put here.
- **`RESOLUTION`** — actual encoded WxH. We *measure* it by probing each rung's output
  rather than computing it — the file is the truth (verify-don't-assert, applied to
  ourselves).
- **`CODECS` — the precise decoder contract**, RFC 6381 syntax. `avc1.4d401f` decodes as:
  `4d` = H.264 **Main** profile (hex), `40` = constraint flags, `1f` = level 3.1 (31 in
  hex ÷ 10). The level encodes decode complexity limits (macroblocks/sec); fun consequence:
  854×480@30 slightly *exceeds* level 3.0's macroblock rate, so our 480p rung is level 3.1.
  We pass `-level:v` explicitly per rung so this string is exact, and we only append
  `mp4a.40.2` (AAC-LC) when the rung really has an audio track — a silent video must not
  advertise audio. Players use CODECS to *skip* renditions they can't decode without
  wasting a download on them.
- **Relative URIs** (`720p/index.m3u8`) — the whole `<videoId>/` tree stays relocatable;
  Phase 1 #5 can serve it from any base URL or CDN without rewriting playlists.
- Order: highest quality first (common convention some players use as a hint).

## 4. Alignment: from rule to evidence

We can't eyeball IDR alignment, so what's the checkable consequence? With a locked GOP and
shared `-hls_time`, every rendition of the same source must cut segments at the **same
timestamps** → *identical segment counts and identical `#EXTINF` duration sequences across
rungs*. That's what the integration test asserts. (The deeper proof — dumping per-frame
keyframe timestamps with `ffprobe -show_frames` — is noted for debugging days.)

## 5. Deferred production upgrades (named, on purpose)

- **Audio rendition groups** (`EXT-X-MEDIA`): encode audio once, share across rungs —
  saves ~128k × (N−1) per second of storage. Ours is muxed per rung for simplicity.
- **Single-pass ladder encode** (`filter_complex split` + `-var_stream_map`): decode the
  source once instead of N times. Big CPU win; hairier invocation; our per-rung runs keep
  each rung independently testable while we learn.
- **Per-title ladders**, trick-play tracks (`EXT-X-IMAGE-STREAM-INF`), separate subtitle
  renditions — all master-playlist tenants we now have the vocabulary for.

## 6. Glossary

- **Ladder / rung** — the set of renditions / one (resolution, bitrate) member of it.
- **Bits-per-pixel** — bitrate ÷ (w·h·fps); ~0.05–0.15 is sane h264 territory.
- **Per-title encoding** — bending the ladder to each video's measured complexity.
- **`BANDWIDTH`** — advertised *peak* bits/s of a rung; the player's affordability test.
- **`CODECS` / RFC 6381** — exact decoder requirement, e.g. `avc1.4d401f` = h264 Main 3.1.
- **Level (h264)** — numeric cap on decode complexity (macroblock rate, etc.); part of the
  codec string.
- **IDR alignment evidence** — identical EXTINF sequences across rungs of one source.
- **Audio rendition group** — shared audio stream referenced by all video rungs (deferred).
