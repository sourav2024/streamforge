/**
 * Playback module — PUBLIC surface. Other modules (and the composition root) may import
 * ONLY from here (docs/concepts/02-why-modular-monolith.md §3, rule 1).
 */
import type { FastifyInstance } from "fastify";
import { playbackRoutes } from "./playback.routes.js";
import type { PlaybackRouteDeps } from "./playback.routes.js";

export { createPlaybackTokens } from "./playback.tokens.js";
export type { PlaybackTokens, PlaybackTokenOptions } from "./playback.tokens.js";
export type { PlaybackRouteDeps } from "./playback.routes.js";

export function registerPlayback(app: FastifyInstance, deps: PlaybackRouteDeps): void {
  playbackRoutes(app, deps);
}
