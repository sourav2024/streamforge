import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { registerPlayback } from "./index.js";
import { createPlaybackTokens } from "./playback.tokens.js";
import type { Storage } from "../../platform/storage.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import type { Video, VideoStatus, PlaybackResponse } from "@streamforge/contracts";

const ID = "45c90a42-b2b4-4b37-87f3-2f2ca4891b41";
const T0 = 1_700_000_000_000;

function makeVideo(status: VideoStatus): Video {
  return {
    id: ID, title: "T", storageKey: `${ID}/original.mp4`, sizeBytes: 10,
    contentType: "video/mp4", durationSeconds: 10, width: 1920, height: 1080,
    videoCodec: "h264", status, createdAt: "2026-08-08T00:00:00.000Z",
  };
}

/** Route tests with fakes (unit): real Fastify + real tokens, fake catalog/storage. */
async function makeApp(opts: { status?: VideoStatus; nowMs?: number; objects?: Record<string, string> } = {}) {
  const { status = "ready", nowMs = T0, objects = { [`${ID}/master.m3u8`]: "#EXTM3U-master" } } = opts;
  const catalog = {
    getVideo: async (id: string) => (id === ID ? makeVideo(status) : null),
  } as CatalogService;
  const requested: string[] = [];
  const hlsStorage = {
    getObjectStream: async (key: string) => {
      requested.push(key);
      const body = objects[key];
      if (body === undefined) return null;
      // contentType deliberately undefined → routes must fall back to contentTypeFor.
      return { body: Readable.from([body]), contentType: undefined, contentLength: body.length };
    },
  } as Storage;
  const tokens = createPlaybackTokens({ secret: "s", ttlSeconds: 60, now: () => nowMs });
  const app = Fastify();
  registerPlayback(app, { catalog, hlsStorage, tokens });
  return { app, tokens, requested };
}

test("issue: ready video → playbackUrl with a path-embedded token that verifies", async () => {
  const { app, tokens } = await makeApp();
  const res = await app.inject({ method: "GET", url: `/playback/videos/${ID}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as PlaybackResponse;
  const m = /^\/playback\/([^/]+)\/([^/]+)\/master\.m3u8$/.exec(body.playbackUrl);
  assert.ok(m, `playbackUrl shape: ${body.playbackUrl}`);
  assert.equal(m![1], ID);
  assert.equal(tokens.verify(ID, m![2]!), true, "embedded token verifies for this video");
  assert.equal(body.expiresAt, new Date(T0 + 60_000).toISOString());
});

test("issue: non-UUID and unknown ids → 404; not-ready video → 409", async () => {
  const { app } = await makeApp({ status: "transcoding" });
  assert.equal((await app.inject({ url: "/playback/videos/nope" })).statusCode, 404);
  assert.equal(
    (await app.inject({ url: "/playback/videos/00000000-0000-0000-0000-000000000000" })).statusCode,
    404,
  );
  const notReady = await app.inject({ url: `/playback/videos/${ID}` });
  assert.equal(notReady.statusCode, 409, "transcoding video is not playable yet");
});

test("serve master: valid token → 200, m3u8 content-type, short playlist cache", async () => {
  const { app, tokens } = await makeApp();
  const { token } = tokens.issue(ID);
  const res = await app.inject({ url: `/playback/${ID}/${token}/master.m3u8` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/vnd.apple.mpegurl");
  assert.equal(res.headers["cache-control"], "public, max-age=60");
  assert.equal(res.body, "#EXTM3U-master");
});

test("serve rung artifacts: correct storage key, segment gets immutable cache", async () => {
  const seg = `${ID}/720p/seg_00000.m4s`;
  const { app, tokens, requested } = await makeApp({ objects: { [seg]: "SEGBYTES" } });
  const { token } = tokens.issue(ID);
  const res = await app.inject({ url: `/playback/${ID}/${token}/720p/seg_00000.m4s` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "video/iso.segment");
  assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(res.body, "SEGBYTES");
  assert.deepEqual(requested, [seg], "key is <id>/<rung>/<file>");
});

test("serve: tampered and expired tokens → 403, storage never touched", async () => {
  const { app, tokens, requested } = await makeApp();
  const { token } = tokens.issue(ID);
  const bad = await app.inject({ url: `/playback/${ID}/${token}xx/master.m3u8` });
  assert.equal(bad.statusCode, 403);

  const expiredApp = await makeApp({ nowMs: T0 + 61_000 });
  // Token minted at T0 (ttl 60s), presented at T0+61s via an app whose clock has moved on.
  const expired = await expiredApp.app.inject({ url: `/playback/${ID}/${token}/master.m3u8` });
  assert.equal(expired.statusCode, 403);
  assert.deepEqual(requested, [], "no storage reads on auth failure");
  assert.deepEqual(expiredApp.requested, []);
});

test("serve: malformed rung/file and missing objects → 404", async () => {
  const { app, tokens } = await makeApp();
  const { token } = tokens.issue(ID);
  for (const path of [
    `/playback/${ID}/${token}/720x/index.m3u8`, // bad rung shape
    `/playback/${ID}/${token}/720p/evil.txt`, // file outside the artifact whitelist
    `/playback/${ID}/${token}/720p/index.m3u8`, // well-formed but not in storage
  ]) {
    const res = await app.inject({ url: path });
    assert.equal(res.statusCode, 404, path);
  }
});
