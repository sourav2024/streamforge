/**
 * Playback tokens: stateless, expiring, video-scoped URL credentials
 * (docs/concepts/11-playback-serving-and-signed-tokens.md §6).
 *
 * token = "<expMs>.<base64url(HMAC-SHA256(secret, videoId + ":" + expMs))>"
 *
 * The videoId is INSIDE the MAC but not the token: verify() recomputes the MAC from the
 * path's videoId, so a token minted for video A replayed against video B fails. exp is
 * plaintext but tamper-evident — change it and the MAC no longer matches.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface PlaybackTokens {
  issue(videoId: string): { token: string; expiresAt: string };
  verify(videoId: string, token: string): boolean;
}

export interface PlaybackTokenOptions {
  secret: string;
  ttlSeconds: number;
  /** Injectable clock so expiry tests don't race real time. */
  now?: () => number;
}

function sign(secret: string, videoId: string, expMs: number): string {
  return createHmac("sha256", secret).update(`${videoId}:${expMs}`).digest("base64url");
}

export function createPlaybackTokens(opts: PlaybackTokenOptions): PlaybackTokens {
  const { secret, ttlSeconds, now = Date.now } = opts;

  return {
    issue(videoId) {
      const expMs = now() + ttlSeconds * 1000;
      return {
        token: `${expMs}.${sign(secret, videoId, expMs)}`,
        expiresAt: new Date(expMs).toISOString(),
      };
    },
    verify(videoId, token) {
      const dot = token.indexOf(".");
      if (dot <= 0) return false;
      const expMs = Number(token.slice(0, dot));
      const sig = token.slice(dot + 1);
      if (!Number.isFinite(expMs) || sig === "") return false;
      if (expMs < now()) return false;
      const expected = Buffer.from(sign(secret, videoId, expMs));
      const given = Buffer.from(sig);
      // timingSafeEqual, never ===: string compare bails at the first wrong byte, and that
      // timing leak enables byte-at-a-time MAC forgery (doc 11 §6). Length check first —
      // timingSafeEqual throws on mismatched lengths (length is not secret here).
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
