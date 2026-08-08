import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlaybackTokens } from "./playback.tokens.js";

const SECRET = "test-secret";
const T0 = 1_700_000_000_000; // fixed clock — no Date.now() flake

function makeTokens(nowMs = T0, ttlSeconds = 60) {
  return createPlaybackTokens({ secret: SECRET, ttlSeconds, now: () => nowMs });
}

test("round-trip: issued token verifies for the same video", () => {
  const tokens = makeTokens();
  const { token, expiresAt } = tokens.issue("vid-1");
  assert.equal(tokens.verify("vid-1", token), true);
  assert.equal(expiresAt, new Date(T0 + 60_000).toISOString());
});

test("cross-video replay: a token minted for video A fails for video B", () => {
  const tokens = makeTokens();
  const { token } = tokens.issue("vid-a");
  assert.equal(tokens.verify("vid-b", token), false);
});

test("tampering with exp or signature invalidates the token", () => {
  const tokens = makeTokens();
  const { token } = tokens.issue("vid-1");
  const [exp, sig] = token.split(".") as [string, string];
  assert.equal(tokens.verify("vid-1", `${Number(exp) + 9999}.${sig}`), false, "bumped exp");
  assert.equal(tokens.verify("vid-1", `${exp}.${sig.slice(0, -2)}xx`), false, "mangled sig");
});

test("expiry: valid until exp, invalid after", () => {
  const issued = makeTokens(T0, 60).issue("vid-1").token;
  assert.equal(makeTokens(T0 + 59_000).verify("vid-1", issued), true, "still inside TTL");
  assert.equal(makeTokens(T0 + 61_000).verify("vid-1", issued), false, "past TTL");
});

test("malformed tokens are rejected, never throw", () => {
  const tokens = makeTokens();
  for (const bad of ["", "no-dot", "123.", ".sig", "abc.def.ghi", "NaN.sig", "123.!!!"]) {
    assert.equal(tokens.verify("vid-1", bad), false, `rejected: ${JSON.stringify(bad)}`);
  }
});
