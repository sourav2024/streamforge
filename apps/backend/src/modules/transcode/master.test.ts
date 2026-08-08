import test from "node:test";
import assert from "node:assert/strict";
import { buildMasterPlaylist } from "./master.js";
import { LADDER } from "./ladder.js";

const rung = (label: string) => LADDER.find((r) => r.label === label)!;

test("master playlist: audio rungs get mp4a.40.2 in CODECS; highest rung listed first", () => {
  // Entries deliberately out of order — the builder owns the highest-first ordering.
  const out = buildMasterPlaylist([
    { rung: rung("720p"), width: 1280, height: 720, audioCodec: "aac" },
    { rung: rung("1080p"), width: 1920, height: 1080, audioCodec: "aac" },
  ]);
  assert.equal(
    out,
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      '#EXT-X-STREAM-INF:BANDWIDTH=6740800,RESOLUTION=1920x1080,CODECS="avc1.4d4028,mp4a.40.2"',
      "1080p/index.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=3440800,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
      "720p/index.m3u8",
      "",
    ].join("\n"),
  );
});

test("master playlist: silent source stays truthful — CODECS is video-only", () => {
  const out = buildMasterPlaylist([
    { rung: rung("360p"), width: 640, height: 360, audioCodec: null },
  ]);
  assert.equal(
    out,
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      '#EXT-X-STREAM-INF:BANDWIDTH=1020800,RESOLUTION=640x360,CODECS="avc1.4d401e"',
      "360p/index.m3u8",
      "",
    ].join("\n"),
  );
});
