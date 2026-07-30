# ABR Ladder Implementation Plan (Phase 1 #4)

> **⚠️ GIT IS DEFERRED.** No `git` commands; tasks end with verification Checkpoints.

**Goal:** Transcode job encodes every honest ladder rung (IDR-aligned, capped bitrate) and
hand-writes the master playlist. Spec: `docs/specs/2026-07-22-abr-ladder-design.md`.

**Architecture:** All inside the existing `transcode` module + small `platform/ffprobe.ts`
extension. New pure units: `ladder.ts` (rung table + `selectRungs`), `master.ts`
(`buildMasterPlaylist`). `ffmpeg.ts` gains a per-rung parameter. `transcode.job.ts` loops
rungs and uploads master last. Worker deps gain `probe`.

## File structure

```
docs/concepts/10-abr-ladder-and-master-playlist.md   Create (Task 1)
apps/backend/src/
  platform/ffprobe.ts(+test)                         Modify (Task 2: audioCodec)
  modules/transcode/
    ladder.ts + ladder.test.ts                       Create (Task 2, TDD)
    master.ts + master.test.ts                       Create (Task 3, TDD)
    ffmpeg.ts (+ffmpeg.test.ts updated)              Modify (Task 4: rung param, -level:v)
    transcode.job.ts (+test updated)                 Modify (Task 5: ladder loop + master)
    index.ts                                         Modify (Tasks 2–5: exports)
  worker.ts                                          Modify (Task 5: inject probe)
```

### Task 1: Concept doc 10
- [ ] `10-abr-ladder-and-master-playlist.md`: ladder design (why those bitrates; ~2×
  spacing; bits-per-pixel intuition); master playlist attributes (BANDWIDTH=peak,
  RESOLUTION, CODECS — `avc1.<profile><constraints><level-hex>` anatomy, why 480p30 needs
  level 3.1); IDR alignment from concept (08 §4.3) to enforcement (identical GOP flags) to
  evidence (identical EXTINF sequences); rung selection / never-upscale; how a player
  actually uses the master (measure → pick → switch at segment boundary); production
  upgrades deferred (audio groups, single-pass encode, per-title ladders).
- [ ] **Checkpoint:** file exists; PROGRESS note.

### Task 2: ffprobe `audioCodec` + rung model (TDD)
- [ ] `ProbeResult` gains `audioCodec: string | null` (from `codec_type === "audio"`);
  update NULLS + tests (fixture is silent → null; extend fixture opts with `audio?: true`
  (lavfi `sine`) and assert `"aac"`).
- [ ] `ladder.ts`: `interface Rung { label; height; maxrateK; bufsizeK; level; videoCodec }`
  + `LADDER` table (spec §3) + `selectRungs(sourceHeight: number | null): Rung[]` — TDD:
  1080→4 rungs, 720→3, 500→2 (480p+360p), 360→1, 240→single native rung `240p` w/ 360p
  caps, null→throws.
- [ ] **Checkpoint:** tests green; typecheck.

### Task 3: Master playlist builder (TDD)
- [ ] `master.ts`: `buildMasterPlaylist(entries: Array<{ rung: Rung; width: number;
  height: number; audioCodec: string | null }>): string` — `#EXTM3U`/`#EXT-X-VERSION:7`,
  one `#EXT-X-STREAM-INF` per entry (highest rung first), BANDWIDTH =
  `round((maxrateK + 128) * 1000 * 1.1)`, CODECS video-only when `audioCodec === null`,
  relative URI `<label>/index.m3u8`. TDD with exact expected text (2 cases: with/without
  audio).
- [ ] **Checkpoint:** tests green.

### Task 4: Per-rung FFmpeg args
- [ ] `buildHlsArgs(inputPath, outDir, rung)`: scale `min(rung.height,ih)`, rung caps,
  `-level:v`, rest unchanged (GOP flags identical across rungs — the point). `runFfmpegHls`
  passes rung through. Update existing ffmpeg tests (720p rung) + new integration test:
  480p & 360p rungs from one 1080p/10s source → identical `#EXTINF` sequences + segment
  counts (alignment evidence), probed heights 480/360.
- [ ] **Checkpoint:** real-encode tests green.

### Task 5: Job orchestration + worker wiring
- [ ] `transcode.job.ts`: deps gain `probe`; flow per spec §5 (probe local → selectRungs →
  loop encode/upload under `<id>/<label>/` → probe rung playlists → master uploaded LAST →
  `ready`). Update unit tests: multi-rung fakes, master-last assertion, upload prefixes,
  probe-null → regular Error (not Unrecoverable), statuses unchanged.
- [ ] `worker.ts`: inject `probe: probeVideo`. `index.ts` exports ladder/master.
- [ ] **Checkpoint:** full suite green; build PASS.

### Task 6: E2E + PROGRESS
- [ ] Boot API+worker. Upload 1080p/10s → ready → `mc ls`: master + 4 rung dirs; master
  content has 4 STREAM-INFs w/ correct RESOLUTION/CODECS; ffprobe master OK. Upload
  640×360/4s → master has exactly one rung. Update PROGRESS.md with evidence.

## Self-review
Spec §3 table → Task 2; §4 layout+master → Tasks 3/5; §5 flow → Task 5; §6 tests all
mapped (unit T2/T3/T5, alignment T4, E2E T6); never-upscale preserved in scale expr AND
selection; `audioCodec` truthfulness → T2+T3. Type flow: `Rung` produced T2, consumed
T3/T4/T5. ✓
