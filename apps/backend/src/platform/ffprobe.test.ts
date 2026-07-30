import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeVideo } from "./ffprobe.js";
import { makeSampleMp4 } from "../modules/test-helpers/make-fixture.js";

test("probeVideo extracts resolution, codec, duration from a real mp4 (silent → audioCodec null)", async () => {
  const p = join(tmpdir(), `sf-probe-${process.pid}.mp4`);
  await makeSampleMp4(p);
  try {
    const r = await probeVideo(p);
    assert.equal(r.width, 320);
    assert.equal(r.height, 240);
    assert.equal(r.videoCodec, "h264");
    assert.equal(r.audioCodec, null);
    assert.ok(r.durationSeconds !== null && r.durationSeconds > 0.5);
  } finally {
    await rm(p, { force: true });
  }
});

test("probeVideo reports the audio codec when a track exists", async () => {
  const p = join(tmpdir(), `sf-probe-audio-${process.pid}.mp4`);
  await makeSampleMp4(p, { audio: true });
  try {
    const r = await probeVideo(p);
    assert.equal(r.videoCodec, "h264");
    assert.equal(r.audioCodec, "aac");
  } finally {
    await rm(p, { force: true });
  }
});

test("probeVideo returns nulls (does not throw) on a non-media file", async () => {
  const r = await probeVideo("/etc/hostname");
  assert.deepEqual(r, {
    durationSeconds: null, width: null, height: null, videoCodec: null, audioCodec: null,
  });
});
