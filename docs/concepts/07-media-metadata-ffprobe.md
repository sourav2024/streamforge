# Concept: Media Metadata with ffprobe (containers, codecs, and what we read)

> **📖 Concept doc — read before `platform/ffprobe.ts`.**
> Part of the Teaching Contract (spec §1). A focused primer; the fuller treatment is the
> **Media Fundamentals** doc coming in Phase 1 #2.

**Status:** Approved
**Phase:** 1 #1 — Storage & Upload
**Decision:** Extract real media metadata from each upload with **`ffprobe`** (ships with
FFmpeg 8.1.2, master spec §8), run as a subprocess. Probe failure is **non-fatal**.

---

## 1. The distinction that trips everyone up: container vs. codec

An `.mp4` file is **not** "a video." It's a **container** — a box format that packages one
or more **streams** (a video stream, one or more audio streams, maybe subtitles) plus
timing/index metadata, so a player can find and sync them. Common containers: MP4, MKV,
WebM, MPEG-TS (the `.ts` segments we'll produce for HLS).

Inside the container, each stream's actual bytes are compressed with a **codec**
(*co*der-*dec*oder) — the algorithm that turns raw pixels/samples into a compact bitstream.
Common video codecs: **H.264/AVC** (universal, our default), H.265/HEVC, VP9, AV1. Audio:
AAC, Opus, MP3.

> **The mental model:** container = the shipping box (what holds and labels things); codec =
> how each item inside is compressed. `.mp4` (box) commonly carries **H.264** video +
> **AAC** audio. The *same* H.264 stream can be repackaged into a different container
> without re-compressing — that's **remuxing**, and it's central to how HLS segmenting
> works later. Confusing "mp4" (container) with "h264" (codec) causes real bugs, so we nail
> it now.

This matters for StreamForge because transcoding (Phase 1 #3) is fundamentally about
containers and codecs: we'll take an uploaded MP4/H.264 and produce HLS — many small
segments in the MPEG-TS or fragmented-MP4 container, at multiple bitrates. Knowing what's
*in* an upload is the first step.

## 2. What `ffprobe` is and how we run it

`ffprobe` is FFmpeg's inspection tool: point it at a media file and it reports the
container format and every stream's properties — without decoding or transcoding. We invoke
it as a **subprocess** (not a library binding) and ask for machine-readable JSON:

```
ffprobe -v quiet -print_format json -show_format -show_streams <file>
```

- `-v quiet` — suppress logging noise on stderr.
- `-print_format json` — emit JSON we can `JSON.parse`.
- `-show_format` — container-level info (notably `format.duration` in seconds).
- `-show_streams` — an array of streams, each with `codec_type` (`"video"`/`"audio"`),
  `codec_name` (e.g. `"h264"`), and for video `width`/`height`.

Our wrapper (`platform/ffprobe.ts`) runs this, finds the first `codec_type === "video"`
stream, and returns a small typed result:

```ts
interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
}
```

## 3. Which fields we persist, and why each earns its column

We store exactly the fields that pay off downstream (spec §5):

| Field | Source | Why we keep it |
|-------|--------|----------------|
| `durationSeconds` | `format.duration` | UI (show length, scrub bar); sanity-check transcode output |
| `width` / `height` | video stream | drives the **ABR ladder** — you don't upscale, so source resolution caps the renditions we generate (Phase 1 #4) |
| `videoCodec` | `codec_name` | informs transcode decisions (e.g. is it already H.264? does it need re-encoding?) |

We intentionally don't hoard every probe field now (YAGNI); we can widen the schema when a
feature needs more (bitrate, frame rate, audio streams, HDR flags…).

## 4. Why probe failure is non-fatal

A corrupt, unusual, or non-video file might make `ffprobe` error or return nothing useful.
Our rule (spec §6): **the upload still succeeds** — the bytes are safely stored and a
catalog row is written — but the probe fields are `null`. Storage integrity must not depend
on our ability to *understand* the file. So `probeVideo` **never throws**: on any error it
returns all-nulls. The nullable columns in the `videos` table are the schema-level
expression of this contract. (A later phase could re-probe or reject non-video uploads more
strictly; not needed for the slice.)

## 5. Trade-offs we accept (this slice)

| We accept | Because |
|-----------|---------|
| Subprocess to `ffprobe`, not a native binding | Simple, matches how FFmpeg is normally driven; no binding to compile/maintain. |
| Probe the local temp file, not the MinIO object | `ffprobe` wants a seekable path; avoids a storage round-trip (see doc 05 §4). |
| Store only 4 metadata fields | YAGNI — widen when a feature needs it. |
| Probe failure → nulls, upload still succeeds | Storage integrity ≠ media comprehension (spec §6). |

## 6. Glossary

- **Container** — file format packaging streams + timing/index (MP4, MKV, MPEG-TS…).
- **Codec** — compression algorithm for a stream (H.264, AAC, VP9…).
- **Stream** — one track inside a container (a video stream, an audio stream…).
- **Remux** — repackage streams into a different container without re-encoding.
- **Transcode** — decode and re-encode (change codec/bitrate/resolution) — Phase 1 #3.
- **ffprobe** — FFmpeg's read-only media inspector.
- **Bitrate** — bits per second of a stream; the main ABR lever (Phase 1 #4).

---

**Next (code):** with docs 05–07 in place, implement Task 2 onward — deps, config/pool,
migration, storage, ffprobe wrapper, then the catalog and upload modules.
