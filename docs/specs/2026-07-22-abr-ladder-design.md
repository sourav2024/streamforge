# ABR Ladder & Master Playlist — Design Spec (Phase 1 #4)

> The payoff slice: one video becomes a ladder of IDR-aligned renditions plus the master
> playlist that lets a player switch quality mid-stream. Builds directly on Phase 1 #3
> (`docs/specs/2026-07-21-transcoding-pipeline-design.md`) and doc 08 §§4–6.

**Status:** Design approved — pre-implementation
**Created:** 2026-07-22
**Phase / Module:** Phase 1 #4 — ABR ladder + master playlist
**Owner:** Sourav

---

## 1. Goal & scope

The transcode job, instead of one 720p rendition, encodes **every ladder rung the source
can honestly fill** (never upscale), each with the *identical* GOP/keyframe flags (that is
what makes them IDR-aligned, doc 08 §4.3), each capped at its advertised bitrate — then
writes a **hand-authored master playlist** referencing them. `ready` means master + all
rungs are uploaded.

**In scope:** rung model + selection logic; per-rung FFmpeg invocation (parameterized
Phase 1 #3 runner, incl. explicit `-level:v` so CODECS strings are truthful); master
playlist builder (BANDWIDTH / RESOLUTION / CODECS); ffprobe gains `audioCodec`; job
orchestration (probe source locally → select rungs → encode+upload each → master last);
tests incl. an alignment check.

**Out of scope:** playback/serving (Phase 1 #5); shared audio group (`EXT-X-MEDIA`),
single-pass `var_stream_map` encode, per-title/content-aware ladders — all documented as
production upgrades in concept doc 10; re-transcoding the one existing 720p-only dev video.

## 2. Decisions locked in brainstorming (2026-07-22)

| Decision | Choice | Why |
|---|---|---|
| Ladder | **4 rungs capped by source** (1080p/720p/480p/360p) | Industry-standard shape; exercises rung-skipping for real. |
| Encode strategy | **One FFmpeg run per rung + hand-written master** | Reuses the proven runner; per-rung testability; we *learn* the master format by writing it. N× decode cost accepted for VOD; single-pass documented as the upgrade. |
| Job granularity | **One job = whole ladder** | `ready` stays one atomic decision; concurrency is 1 anyway. Fan-out-per-rung = scaling path. |
| Audio | **Muxed AAC 128k into every rung** | Simple master; audio-group extraction deferred. |

## 3. The ladder

CRF 23 everywhere; the caps differentiate the rungs (capped-CRF discipline, doc 08 §5).
GOP flags (`-r 30 -g 60 -keyint_min 60 -sc_threshold 0`) are **identical on every rung —
non-negotiable**, that is the IDR alignment.

| Rung | Scale | maxrate / bufsize | `-level:v` | Video CODECS |
|---|---|---|---|---|
| `1080p` | ≤1080 | 6000k / 12000k | 4.0 | `avc1.4d4028` |
| `720p` | ≤720 | 3000k / 6000k | 3.1 | `avc1.4d401f` |
| `480p` | ≤480 | 1400k / 2800k | 3.1 | `avc1.4d401f` |
| `360p` | ≤360 | 800k / 1600k | 3.0 | `avc1.4d401e` |

(`avc1.4d….` = H.264 **Main** profile (`4d`) + level hex; 854×480@30 exceeds level 3.0's
macroblock rate, hence 3.1. Explained in concept doc 10.)

**Rung selection** (`selectRungs(sourceHeight)`): rungs with `height <= sourceHeight`.
Edge cases: source < 360p → encode a single rung at native height with the 360p caps,
labeled `<height>p`. Source height unknown (probe returned null) → the job throws a normal
Error (retry → `failed`): if ffprobe can't read it, ffmpeg can't transcode it. The job
probes the **downloaded file** — never trusts possibly-null catalog metadata when it has
the bytes.

## 4. Storage layout & master playlist

```
streamforge-hls/<videoId>/
  master.m3u8                  ← uploaded LAST (the "ladder complete" artifact)
  1080p/index.m3u8  init.mp4  seg_00000.m4s …
  720p/…   480p/…   360p/…
```

Master is hand-built from **measured** rung outputs (each rung's playlist is ffprobe'd
after encode for actual width/height/audio — truth over arithmetic):

```
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=6740800,RESOLUTION=1920x1080,CODECS="avc1.4d4028,mp4a.40.2"
1080p/index.m3u8
… (one per rung, highest first)
```

- `BANDWIDTH` = peak: `(maxrate + 128k audio) × 1.1` container overhead, rounded.
- `CODECS` includes `mp4a.40.2` only if the rung output actually has audio (silent
  sources stay truthful) — hence `ProbeResult.audioCodec`.
- Relative URIs, so the whole `<id>/` prefix is relocatable (matters for Phase 1 #5).

## 5. Job flow & error handling

getVideo (miss → `UnrecoverableError`) → `transcoding` → download original → **probe local
file** → `selectRungs` → per rung: encode into `out/<label>/` → upload under
`<id>/<label>/` → probe rung playlist → collect → build master → upload `master.m3u8`
**last** → `ready`. Temp dir removed in `finally`.

Unchanged semantics from Phase 1 #3 (all still hold): idempotent steps (overwrite
everything), retries + backoff, `failed` only on final attempt, partial uploads harmless
because `ready` (and now also master) come last.

## 6. Testing & verification

- **Unit:** `selectRungs` (1080/720/500/360/240/null sources); master builder (exact
  expected m3u8 text, incl. no-audio CODECS variant); job orchestration with fakes (rung
  loop, upload prefixes, master uploaded last, statuses).
- **Integration (real FFmpeg):** encode 480p + 360p rungs from one 1080p/10s fixture and
  assert **alignment evidence**: identical segment counts and identical `#EXTINF` duration
  sequences across rungs (necessary consequence of locked GOP); probe says heights 480/360.
- **E2E:** upload 1080p/10s → `ready` → `mc ls` shows master + 4 rung dirs; pull master,
  assert 4 `#EXT-X-STREAM-INF` rows with correct RESOLUTION/CODECS; ffprobe the master.
  Then upload 640×360 → exactly one rung (`360p`) in master (never-upscale proof).

## 7. Success criteria

- 1080p upload → `ready`; master lists 4 rungs (6M/3M/1.4M/0.8M, correct resolutions);
  every rung playable (`ffprobe`), all with identical segment timing (alignment).
- 360p upload → master lists exactly one rung. Probe-null source → `failed`, not a crash.
- Concept doc 10 before code; suite green; PROGRESS updated with evidence.
