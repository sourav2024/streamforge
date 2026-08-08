# Playback Service Implementation Plan (Phase 1 #5)

**Goal:** issue signed playback URLs; proxy-stream the HLS tree from MinIO.
Spec: `docs/specs/2026-08-08-playback-service-design.md`.

### Task 1: Concept doc 11 ✅
- [x] `11-playback-serving-and-signed-tokens.md` (HTTP delivery, proxy-vs-presign-vs-public,
  backpressure, cache semantics, path-token rationale, HMAC anatomy).

### Task 2: Config + storage stream
- [x] Config: `playback: { tokenSecret (required), tokenTtlSeconds (default 21600) }`;
  `.env` + `.env.example`.
- [x] `Storage.getObjectStream(key) → { body, contentType?, contentLength? } | null`
  (null on missing key). Integration test vs real MinIO (round-trip + missing ⇒ null).
- [x] **Checkpoint:** typecheck + storage tests green.

### Task 3: Tokens (TDD)
- [x] `playback.tokens.ts`: `createPlaybackTokens({ secret, ttlSeconds, now? })` →
  `issue(videoId)` / `verify(videoId, token)`. Tests: round-trip; tampered exp; tampered
  sig; expired; cross-video replay; malformed token shapes.
- [x] **Checkpoint:** unit tests green.

### Task 4: Routes (TDD) + contracts + wiring
- [x] Contracts: `PlaybackResponse { playbackUrl, expiresAt }`.
- [x] `playback.routes.ts` + `index.ts`; wire in `app.ts` (hlsStorage + tokens).
  Route tests with fakes: issue 200/404(unknown, non-UUID)/409(not ready); serve 200
  (content-type + cache headers, master and rung file)/403(bad sig, expired)/404(bad
  rung, bad file, missing object).
- [x] **Checkpoint:** full suite green; build PASS.

### Task 5: E2E + PROGRESS
- [x] Boot API. Issue URL for the ready 1080p video → curl master via proxy → ffprobe the
  proxied master (full cascade). Drills: tampered token 403, not-ready 409, bad file 404.
- [x] Update PROGRESS.md with evidence.
