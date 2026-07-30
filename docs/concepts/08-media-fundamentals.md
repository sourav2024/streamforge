# Concept: Media Fundamentals (containers, codecs, H.264, segments, and why HLS)

> **📖 Concept doc — the vocabulary foundation for the rest of Phase 1.**
> Part of the Teaching Contract (spec §1). Pure concept, no code. Every FFmpeg flag we set in
> the Transcoding Pipeline (Phase 1 #3), every rung of the ABR ladder (Phase 1 #4), and every
> manifest we serve in Playback (Phase 1 #5) traces back to an idea established here. It expands
> the focused primer in `07-media-metadata-ffprobe.md`.

**Status:** Approved
**Phase:** 1 #2 — Media Fundamentals (pure concept)
**Depth:** Staff-engineer working model — enough to *reason about and defend* every pipeline
decision, debug it, and know the trade-offs cold. Not an encyclopedia: each internal earns its
place by connecting to something we build.

---

## 1. The mental model everything hangs on: raw video is enormous

Start with the number that makes the entire field exist.

A single 1080p frame is 1920 × 1080 = 2,073,600 pixels. Store each pixel as 3 bytes (8 bits
each of red, green, blue) and one frame is ~6.2 MB. Play 30 of those per second:

```
1920 × 1080 × 3 bytes × 30 fps ≈ 186 MB/s  ≈ 1.5 Gbit/s
```

A two-hour movie at that rate is ~1.3 **terabytes**. 4K at 60fps is ~8× that. No network
delivers this to a phone, no disk economically stores it, no budget survives it.

So the foundational truth of streaming: **raw video is never stored or transmitted. Compression
is not an optimization — it is the whole game.** Everything below is about *how* we throw away
data the eye won't miss, package what's left, and deliver it adaptively. Hold this number in
your head; every design choice is ultimately in service of shrinking it.

Two independent problems fall out of this, and conflating them is the #1 confusion in media:

1. **How do we compress the pixels/samples?** → the job of a **codec**.
2. **How do we package the compressed streams into a file we can index, interleave, and ship?**
   → the job of a **container**.

---

## 2. Container vs. codec — the distinction people conflate

**A codec compresses the bytes. A container organizes them.** They are orthogonal.

- **Codec** (COder-DECoder): the algorithm that turns raw pixels into a small compressed
  bitstream and back. Video codecs: **H.264/AVC**, H.265/HEVC, VP9, AV1. Audio codecs: **AAC**,
  Opus, MP3. A codec knows *nothing* about files — it produces a stream of compressed frames.

- **Container** (a.k.a. format/wrapper): the file structure that holds one or more compressed
  **streams** (a video stream, one or more audio streams, subtitles, chapters) plus the
  **metadata** needed to play them: which codecs are used, durations, timestamps, and an index
  mapping "time → byte offset" so a player can seek. Containers: **MP4** (`.mp4`, ISO-BMFF),
  **fMP4** (fragmented MP4), MPEG-TS (`.ts`), Matroska (`.mkv`), WebM.

The classic analogy: the **container is the shipping box; the codec is how the contents were
compressed to fit.** The same H.264 video can live in an `.mp4`, a `.ts`, or a `.mkv` — same
compressed bytes, different box. This is exactly what `ffprobe` reported in Phase 1 #1: the
`format` was the container (mp4), and each `stream` had a `codec_name` (h264, aac). We stored
`videoCodec` (the codec) separately from `contentType: video/mp4` (the container) *because they
are different axes.*

**Why this separation is load-bearing for us.** Because container and codec are independent, you
can sometimes change the box **without re-compressing the contents** — a cheap operation called
**remuxing** (re-multiplexing) or "copying" the stream (`-c copy` in FFmpeg). Repackaging H.264
from an `.mp4` into HLS's fragmented segments *without re-encoding* is remuxing; it's ~free.
Actually changing resolution or bitrate is **transcoding** — decode → modify → re-encode — which
is expensive (CPU-bound, the reason we need a background job queue at all). Knowing which
operation a task requires is a real, money-saving distinction in production: transcode only when
you must; remux when you can.

**Multiplexing (muxing):** a container interleaves the streams so a player reading linearly gets
video and audio chunks in roughly time-synchronized order (you don't want to read the entire
video stream before any audio). The index lets the player jump to any timestamp. When we
"demux," we split the streams back apart; when we "remux," we re-interleave into a new container.

---

## 3. Inside the video codec — how H.264 actually compresses

H.264 (also called AVC, MPEG-4 Part 10) is the workhorse of the internet: the most universally
*decodable* video codec, hardware-accelerated on essentially every phone, TV, and browser. That
universality is why we start here (spec §4). To reason about the pipeline, you need to know
*how* it achieves its compression, because the mechanism dictates how we can cut and stream it.

Compression exploits two kinds of **redundancy**:

### 3a. Spatial redundancy (within one frame) — "intra" coding

Neighbouring pixels are usually similar (a patch of sky is mostly the same blue). H.264 divides a
frame into **macroblocks** (e.g. 16×16), predicts each block from its neighbours, and stores only
the small *difference*. That difference is transformed (a DCT-like integer transform),
**quantized** (precision deliberately thrown away — this is the *lossy* step, and the main knob
quality/bitrate turns), and **entropy-coded** (CABAC/CAVLC — lossless packing of the remaining
symbols). Two supporting tricks worth naming:

- **Chroma subsampling (`yuv420p`).** The eye is far more sensitive to brightness (luma) than to
  colour (chroma). So video is stored as Y (luma) + U/V (chroma), and the chroma is stored at
  *half* resolution in both directions (4:2:0) — instantly ~50% fewer colour samples for almost
  no perceived loss. `yuv420p` is what we pass to `-pix_fmt` (and generated in our test fixture)
  because it's what every hardware decoder and browser reliably supports. 4:4:4 (full chroma)
  exists but breaks broad playback — hence 4:2:0 is the safe production default.

### 3b. Temporal redundancy (between frames) — "inter" coding, the big win

Consecutive frames are *nearly identical* — most of the scene doesn't change frame to frame. So
instead of storing every frame in full, H.264 stores most frames as *changes from other frames*.
This produces three frame types:

- **I-frame (Intra / "keyframe"):** a complete, self-contained image. Decodable on its own, with
  no reference to any other frame — exactly like a JPEG. Largest in bytes.
- **P-frame (Predicted):** stores only the difference from a *previous* frame, using **motion
  vectors** ("this block moved 8px right from the last frame") plus a small residual. Much
  smaller than an I-frame.
- **B-frame (Bi-directional):** stores differences from *both* past **and future** frames.
  Smallest of all. (This is why an encoder reorders frames: it must encode a future reference
  *before* the B-frames that depend on it — the "decode order" differs from "display order.")

The compression ratio comes overwhelmingly from P/B frames. A talking-head video is tiny because
almost nothing moves; a confetti explosion is huge because everything does.

### 3c. The GOP — Group of Pictures

Frames are organized into a repeating **GOP**: one I-frame followed by a run of P/B frames until
the next I-frame. A typical structure:

```
I  B  B  P  B  B  P  B  B  P  ...  I  B  B  P ...
└──────────── one GOP ────────────┘└── next GOP ──
▲ keyframe                          ▲ keyframe
```

GOP length is a deliberate trade-off:

- **Longer GOP** (keyframes far apart) → better compression (fewer expensive I-frames) but coarser
  seeking and slower error recovery.
- **Shorter GOP** (keyframes frequent) → worse compression but fast seek/recovery — **and clean
  segment boundaries**, which §4 shows is the requirement that makes streaming possible.

In FFmpeg this is the `-g` flag (GOP size, in frames). We will set it deliberately, not by
default, for the reason in §4.

---

## 4. Why keyframes are the hinge of streaming

This is the section that connects "codec internals" to "everything we build." One sentence:

> **You can only start decoding at an I-frame, so you can only cut a clean, independently-playable
> segment at a keyframe boundary.**

Why: a P- or B-frame is meaningless alone — it's *a diff against other frames*. If a segment (or a
seek, or a bitrate switch) began on a P-frame, the decoder would have nothing to diff against and
produce garbage until the next I-frame. So every independently-decodable unit **must begin with a
keyframe.**

Three consequences that drive the entire pipeline:

1. **Segmenting.** HLS chops a video into segments of ~2–6 seconds. Each segment must start with a
   keyframe or a player can't start mid-stream. Therefore the encoder must place keyframes at
   *predictable, regular* intervals aligned to the segment length. This is why, when we transcode,
   we force a fixed GOP aligned to segment duration (e.g. keyframe every 2s) rather than letting
   the encoder place keyframes wherever it likes. Get this wrong and segments don't line up →
   playback stutters or fails.

2. **Seeking.** When a user scrubs to 1:03:20, the player jumps to the *nearest preceding
   keyframe* and decodes forward. Keyframe spacing = seek granularity.

3. **Adaptive switching (the ABR payoff, Phase 1 #4).** To switch from 480p to 1080p mid-playback,
   the player must switch at a segment boundary — and for the switch to be seamless, **keyframes
   across every rendition must be aligned to the same timestamps** ("IDR-aligned"). If the 480p
   and 1080p renditions put keyframes in different places, the player can't cleanly cut from one to
   the other. This is *the* reason ABR requires a fixed, identical GOP structure across the whole
   ladder — a decision we make once, here, in concept, and enforce later in code.

Keyframe discipline is the thread running from codec internals → segmenting → seeking → ABR. If
you understand only one thing from this doc, understand this.

---

## 5. The knobs: bitrate × resolution × framerate (and rate control)

"Quality" isn't one number. Three independent dials produce it, and the pipeline sets all three.

- **Resolution** — pixel dimensions (1920×1080). More pixels = more detail = more data. The ABR
  ladder is largely a *resolution* ladder (1080p / 720p / 480p / 360p).
- **Framerate (fps)** — frames per second (24/30/60). Higher = smoother motion = more data.
  Usually kept constant across the ladder (you drop resolution, not smoothness).
- **Bitrate** — **bits per second of output**, the single most important number. This is the
  actual size of the compressed stream over time, and it is what must fit through the viewer's
  network pipe. Two videos at the same resolution can look very different at 1 Mbps vs 5 Mbps.

The crucial insight: **bitrate is the master variable of streaming.** Resolution and framerate
*influence how much bitrate you need for good quality*, but bitrate is what you're actually
delivering and what the network constrains. ABR is fundamentally about **switching between streams
of different bitrates** as the network changes.

### Rate control — how the encoder hits a bitrate

You tell the encoder its bitrate *goal*, and the mode determines how strictly it holds it:

- **CRF (Constant Rate Factor)** — you set a *quality* target (e.g. CRF 23); bitrate floats to
  whatever that quality needs, spending bits on hard scenes and saving on easy ones. Best
  quality-per-byte. Ideal for a single download/VOD master. **But** its output bitrate is
  unpredictable — bad for ABR, where each rung must stay within a known ceiling.
- **CBR (Constant Bitrate)** — holds a fixed bitrate regardless of scene difficulty. Predictable
  (good for strict bandwidth budgets/broadcast) but wastes bits on easy scenes and starves hard
  ones.
- **VBR / capped-CRF / constrained bitrate** — the ABR compromise: aim for good quality but
  **cap** the bitrate (`-maxrate` + `-bufsize`) so a rung never exceeds the bandwidth its label
  promises. A "3 Mbps 720p" rung must actually stay near/under 3 Mbps or ABR's whole premise (pick
  the rung that fits your bandwidth) breaks.

So: **VOD single-file → CRF; ABR ladder → constrained/capped bitrate per rung.** That's why the
transcoding step will use different rate-control flags than a naive "just compress it" would — and
now you know why, before we write a single flag.

---

## 6. Why we segment, and why HLS

### Why segment at all

Segmenting = splitting the encoded stream into many small files (~2–6s each) plus a text
**manifest** listing them in order. It unlocks four things a single monolithic file cannot:

1. **Adaptive bitrate.** The player fetches one segment at a time and can choose *which rendition's*
   next segment to fetch based on measured bandwidth — switching quality mid-playback at segment
   boundaries (§4.3). Impossible with one big file.
2. **Instant start & seek.** The player grabs the first (or the sought) segment and plays; it never
   downloads the whole file.
3. **CDN cacheability.** Small, immutable, individually-cacheable files are ideal for CDNs — the
   same 720p segment is cached once and served to thousands. A single huge file with range
   requests caches far worse.
4. **Resilience.** A dropped segment retries cheaply; you don't restart the movie.

### HLS — HTTP Live Streaming

HLS (Apple-origin, now ubiquitous) is our protocol (spec §4). Its genius is that it's **just HTTP
files** — no special streaming server, no exotic protocol. A plain object store + CDN serves it.
It's two kinds of artifact:

- **Media playlist** (`.m3u8`) — an ordered text list of the segment files for *one* rendition,
  with each segment's duration. The player downloads segments in this order.
- **Master playlist** (`.m3u8`) — lists the available renditions (each with its bitrate/resolution)
  and points to each one's media playlist. **This is the ABR menu**: the player reads the master,
  sees "480p@1M, 720p@3M, 1080p@6M," and picks based on bandwidth. (Phase 1 #3 produces a single
  media playlist; Phase 1 #4 adds the master + multiple renditions.)
- **Segments** — the actual media, historically MPEG-TS (`.ts`), now increasingly **fMP4/CMAF**
  (`.m4s`) fragments.

### HLS vs DASH vs CMAF — the real trade-off

- **HLS** — Apple's; the *only* thing iOS/Safari play natively; ExoPlayer (Android) speaks it too.
  Broadest device support. **We choose it first for exactly that reach** (spec §4).
- **MPEG-DASH** — the ISO/vendor-neutral equivalent; technically clean, but *not* natively
  supported on Apple platforms. Common on Android/web/smart-TVs.
- **CMAF** — not a competitor but a *convergence*: a common fMP4 segment format that **both** HLS
  and DASH can reference, so you encode segments **once** and generate two thin manifests over the
  same bytes (huge storage/CDN savings). The modern production endgame; we note it now and can
  layer it in later without re-encoding — precisely because of the container/codec separation in
  §2.

---

## 7. How this maps to StreamForge

Explicit bridge from concept to the code we've built and will build:

- **Already done (Phase 1 #1).** `ffprobe` reads the container (`format`) and per-stream
  `codec_name`/`width`/`height`/`duration` — §2's distinction in action. We persist `videoCodec`,
  `width`, `height`, `durationSeconds` on the `videos` row *because* the transcoder and ABR ladder
  will need them (e.g. never upscale a 480p source to a 1080p rung). The `status` seam
  (`uploaded → transcoding → ready`) exists to track the pipeline stage this doc's next steps drive.
- **Phase 1 #3 — Transcoding Pipeline.** A BullMQ job takes the raw MP4 and runs FFmpeg to produce
  **single-rendition HLS**: force a fixed GOP aligned to segment length (§4), pick rate control
  (§5), output a media playlist + segments (§6). On success, flip `status` → `ready`. This is where
  every flag we'll write is justified by §§3–6.
- **Phase 1 #4 — ABR.** Produce *multiple* renditions with **IDR-aligned keyframes** (§4.3) and
  **capped per-rung bitrates** (§5), plus a **master playlist** (§6). The "most important concept"
  in the roadmap — and now it has a foundation.
- **Phase 1 #5 — Playback.** Serve the manifests + segments (signed URLs); the player reads the
  master, does ABR on-device. Pure HLS-over-HTTP (§6).

---

## 8. Glossary

- **Container / format / wrapper** — file structure holding compressed stream(s) + metadata/index
  (MP4, fMP4, MPEG-TS, MKV). Organizes; does not compress.
- **Codec** — algorithm that compresses/decompresses media bytes (H.264, AAC). Compresses; knows
  nothing about files.
- **Stream** — one track inside a container (a video stream, an audio stream, subtitles).
- **Muxing / demuxing / remuxing** — interleaving streams into a container / splitting them out /
  re-packaging into a new container **without re-encoding**.
- **Transcoding** — decode → modify (resolution/bitrate/codec) → re-encode. Expensive, CPU-bound.
- **Remuxing (`-c copy`)** — change the container only, keep the compressed bytes. Cheap.
- **Macroblock** — the block unit (e.g. 16×16) H.264 predicts and compresses.
- **Chroma subsampling (`yuv420p`, 4:2:0)** — storing colour at lower resolution than brightness;
  ~half the colour data for near-zero perceived loss. The safe, universally-decodable default.
- **Quantization** — the lossy precision-reduction step; the main quality/bitrate knob.
- **Entropy coding (CABAC/CAVLC)** — lossless packing of the remaining symbols.
- **I-frame / keyframe / IDR** — a fully self-contained frame, decodable alone (like a JPEG).
- **P-frame** — stored as a difference from a *previous* frame (motion vectors + residual).
- **B-frame** — stored as a difference from *both* past and future frames; smallest.
- **Motion vector** — "this block moved by (x,y)" — how P/B frames reference other frames cheaply.
- **GOP (Group of Pictures)** — one keyframe + the run of P/B frames until the next keyframe;
  its length (`-g`) trades compression against seek/segment granularity.
- **IDR-aligned** — keyframes placed at identical timestamps across all renditions, so ABR can
  switch renditions seamlessly at segment boundaries.
- **Bitrate** — bits per second of the compressed output; the master streaming variable and what
  the network constrains.
- **Resolution / framerate** — pixel dimensions / frames per second; influence needed bitrate.
- **Rate control (CRF / CBR / VBR / capped)** — how strictly the encoder hits a bitrate goal:
  quality-target (CRF, for VOD masters) vs fixed (CBR) vs capped/constrained (for ABR rungs).
- **Segment** — a small (~2–6s) independently-decodable media file; must start on a keyframe.
- **Manifest / playlist (`.m3u8`)** — text file listing segments (media playlist) or renditions
  (master playlist).
- **Media playlist** — ordered segment list for one rendition.
- **Master playlist** — the ABR menu: lists renditions (bitrate/resolution) → their media playlists.
- **Rendition** — one encoded version of the video at a specific resolution/bitrate; a rung of the
  ABR ladder.
- **ABR (Adaptive Bitrate)** — client switches among renditions of different bitrates at segment
  boundaries based on measured bandwidth.
- **HLS** — Apple's HTTP-based streaming protocol; broadest device support; our first choice.
- **MPEG-DASH** — vendor-neutral equivalent; not native on Apple platforms.
- **CMAF** — common fMP4 segment format both HLS and DASH can share (encode once, two manifests).
