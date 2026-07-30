import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRungs, LADDER } from "./ladder.js";

test("1080p source gets the full 4-rung ladder, highest first", () => {
  const rungs = selectRungs(1080);
  assert.deepEqual(rungs.map((r) => r.label), ["1080p", "720p", "480p", "360p"]);
});

test("4K source still tops out at 1080p (ladder is the ceiling)", () => {
  assert.deepEqual(selectRungs(2160).map((r) => r.label), ["1080p", "720p", "480p", "360p"]);
});

test("720p source: never upscale → 3 rungs", () => {
  assert.deepEqual(selectRungs(720).map((r) => r.label), ["720p", "480p", "360p"]);
});

test("odd 500p source fits 480p and 360p", () => {
  assert.deepEqual(selectRungs(500).map((r) => r.label), ["480p", "360p"]);
});

test("360p source gets exactly one rung", () => {
  assert.deepEqual(selectRungs(360).map((r) => r.label), ["360p"]);
});

test("tiny 240p source: single native-height rung with the smallest rung's caps", () => {
  const rungs = selectRungs(240);
  assert.equal(rungs.length, 1);
  assert.equal(rungs[0]!.label, "240p");
  assert.equal(rungs[0]!.height, 240);
  assert.equal(rungs[0]!.maxrateK, LADDER[LADDER.length - 1]!.maxrateK);
});

test("unknown source height throws (unprobeable → job fails → retries → failed)", () => {
  assert.throws(() => selectRungs(null), /unknown/i);
});
