import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpegHls, HLS_PLAYLIST } from "./ffmpeg.js";
import { LADDER } from "./ladder.js";
import { probeVideo } from "../../platform/ffprobe.js";
import { makeSampleMp4 } from "../test-helpers/make-fixture.js";

// Integration tests against real FFmpeg: the flags are the product here, so we prove them
// on a real encode, not a mock (verify-don't-assert).

const rung = (label: string) => LADDER.find((r) => r.label === label)!;

test("1080p source → 720p fMP4 HLS: playlist + init + multiple ~4s segments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sf-hls-"));
  try {
    const src = join(dir, "src.mp4");
    await makeSampleMp4(src, { size: "1920x1080", seconds: 10 });
    const out = join(dir, "out");
    await mkdir(out);

    await runFfmpegHls(src, out, rung("720p"));

    const files = await readdir(out);
    assert.ok(files.includes(HLS_PLAYLIST), "media playlist written");
    assert.ok(files.includes("init.mp4"), "fMP4 init segment written");
    const segments = files.filter((f) => f.endsWith(".m4s"));
    assert.ok(segments.length >= 2, `10s @ 4s segments → ≥2 segments, got ${segments.length}`);

    const playlist = await readFile(join(out, HLS_PLAYLIST), "utf8");
    assert.ok(playlist.startsWith("#EXTM3U"), "valid m3u8 header");
    assert.ok(playlist.includes('#EXT-X-MAP:URI="init.mp4"'), "playlist references init segment");
    assert.ok(playlist.includes("#EXT-X-ENDLIST"), "VOD playlist is finalized");
    // Segment durations declared ≈4s (last one may be shorter).
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
    assert.equal(durations.length, segments.length);
    assert.ok(durations.slice(0, -1).every((d) => Math.abs(d - 4) < 0.5),
      `non-final segments ≈4s, got ${durations.join(",")}`);

    // The rendition is genuinely playable and really 720p h264 (ffprobe reads HLS).
    const probed = await probeVideo(join(out, HLS_PLAYLIST));
    assert.equal(probed.height, 720);
    assert.equal(probed.videoCodec, "h264");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("never upscale: a 640x360 source stays 360p even on the 720p rung", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sf-hls-"));
  try {
    const src = join(dir, "src.mp4");
    await makeSampleMp4(src, { size: "640x360", seconds: 2 });
    const out = join(dir, "out");
    await mkdir(out);

    await runFfmpegHls(src, out, rung("720p"));

    const probed = await probeVideo(join(out, HLS_PLAYLIST));
    assert.equal(probed.height, 360, "min(rung,ih) must not upscale");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("IDR alignment evidence: 480p and 360p rungs from one source have identical segment timing", async () => {
  // The locked GOP trio must make segment boundaries land identically on every rung —
  // identical #EXTINF sequences are the necessary consequence (doc 10 §4, spec §6).
  const dir = await mkdtemp(join(tmpdir(), "sf-hls-"));
  try {
    const src = join(dir, "src.mp4");
    await makeSampleMp4(src, { size: "1920x1080", seconds: 10 });

    const outputs: Record<string, { durations: number[]; segments: number; height: number | null }> = {};
    for (const label of ["480p", "360p"] as const) {
      const out = join(dir, label);
      await mkdir(out);
      await runFfmpegHls(src, out, rung(label));
      const playlist = await readFile(join(out, HLS_PLAYLIST), "utf8");
      const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
      const segments = (await readdir(out)).filter((f) => f.endsWith(".m4s")).length;
      const probed = await probeVideo(join(out, HLS_PLAYLIST));
      outputs[label] = { durations, segments, height: probed.height };
    }

    assert.equal(outputs["480p"]!.height, 480);
    assert.equal(outputs["360p"]!.height, 360);
    assert.equal(outputs["480p"]!.segments, outputs["360p"]!.segments, "identical segment counts");
    assert.deepEqual(outputs["480p"]!.durations, outputs["360p"]!.durations,
      "identical #EXTINF sequences across rungs — the alignment evidence");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
