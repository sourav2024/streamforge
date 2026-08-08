/**
 * @streamforge/contracts
 *
 * The single source of truth for shapes that cross a boundary — between the backend and
 * any client, and (later) between extracted services. See docs/concepts/01-monorepo-structure.md
 * for WHY this lives in a shared workspace package instead of being duplicated per app.
 *
 * For Phase 0 the only contract is the health check. Real domain contracts (catalog items,
 * upload requests, playback manifests) arrive with their modules in Phase 1.
 */

/** Liveness/readiness payload returned by the backend's `/health` endpoint. */
export interface HealthResponse {
  status: "ok";
  /** ISO-8601 timestamp of when the response was produced. */
  time: string;
  /** Backend package version (from package.json). */
  version: string;
}

/**
 * Video pipeline state: uploaded → transcoding → ready, with failed as the terminal
 * error state (set only after the transcode job's final retry — see Phase 1 #3 spec §6).
 */
export type VideoStatus = "uploaded" | "transcoding" | "ready" | "failed";

/** A catalog video record, mirrored from the `videos` Postgres table. */
export interface Video {
  id: string;
  title: string;
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  status: VideoStatus;
  createdAt: string; // ISO-8601
}

/** Fields the upload module hands to catalog to create a row. */
export interface CreateVideoInput {
  id: string;
  title: string;
  storageKey: string;
  sizeBytes: number;
  contentType: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
}

export type CreateVideoResponse = Video;
export interface VideoListResponse {
  videos: Video[];
}

/**
 * Response of `GET /playback/videos/:id` — the entry point a player hands to its HLS
 * engine. The token is embedded in the URL PATH so relative playlist URIs carry it
 * (Phase 1 #5 spec §3; concept doc 11 §5).
 */
export interface PlaybackResponse {
  /** Relative URL of the master playlist, e.g. `/playback/<id>/<token>/master.m3u8`. */
  playbackUrl: string;
  /** ISO-8601 instant after which the URL stops working. */
  expiresAt: string;
}
