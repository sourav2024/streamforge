import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpegHls, HLS_PLAYLIST } from "./ffmpeg.js";
import { probeVideo } from "../../platform/ffprobe.js";
import { makeSampleMp4 } from "../test-helpers/make-fixture.js";

// Integration tests against real FFmpeg: the flags are the product here, so we prove them
// on a real encode, not a mock (verify-don't-assert).

test("1080p source → 720p fMP4 HLS: playlist + init + multiple ~4s segments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sf-hls-"));
  try {
    const src = join(dir, "src.mp4");
    await makeSampleMp4(src, { size: "1920x1080", seconds: 10 });
    const out = join(dir, "out");
    await mkdir(out);

    await runFfmpegHls(src, out);

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

test("never upscale: a 640x360 source stays 360p", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sf-hls-"));
  try {
    const src = join(dir, "src.mp4");
    await makeSampleMp4(src, { size: "640x360", seconds: 2 });
    const out = join(dir, "out");
    await mkdir(out);

    await runFfmpegHls(src, out);

    const probed = await probeVideo(join(out, HLS_PLAYLIST));
    assert.equal(probed.height, 360, "min(720,ih) must not upscale");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
