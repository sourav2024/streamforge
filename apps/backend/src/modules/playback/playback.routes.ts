/**
 * Playback HTTP layer (Phase 1 #5 spec §3, §5). Two jobs:
 *
 *  1. ISSUE — `GET /playback/videos/:id`: catalog-gated (exists AND ready — master-last
 *     from #4 means ready ⇒ every artifact exists), returns a playbackUrl whose token
 *     lives in the PATH so relative playlist URIs propagate it (doc 11 §5).
 *  2. SERVE — stream master/rung artifacts from object storage through the reply.
 *     Token-only auth (no DB on the segment hot path); Fastify pipes the Readable, so
 *     backpressure runs client ← Node ← MinIO and memory stays flat (doc 11 §3).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Storage } from "../../platform/storage.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import type { PlaybackResponse } from "@streamforge/contracts";
import type { PlaybackTokens } from "./playback.tokens.js";
// Public surface of transcode (boundary rule): the artifact-kind → content-type mapping
// belongs to the module that writes the artifacts; we reuse it as the fallback.
import { contentTypeFor, MASTER_PLAYLIST } from "../transcode/index.js";

export interface PlaybackRouteDeps {
  catalog: CatalogService;
  hlsStorage: Storage;
  tokens: PlaybackTokens;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The routes can only address artifacts the transcode job writes (spec §3): rung dirs
// like "720p"/"1080p", and exactly the three file kinds. No traversal, no surprise keys.
const RUNG_RE = /^\d{3,4}p$/;
const FILE_RE = /^(index\.m3u8|init\.mp4|seg_\d{5}\.m4s)$/;

// Segments/init never change once written (job overwrites wholesale) → cache for a year,
// never revalidate. Playlists are the mutable-in-principle entry points → 60s (doc 11 §4).
const SEGMENT_CACHE = "public, max-age=31536000, immutable";
const PLAYLIST_CACHE = "public, max-age=60";

export function playbackRoutes(app: FastifyInstance, deps: PlaybackRouteDeps): void {
  const { catalog, hlsStorage, tokens } = deps;

  app.get<{ Params: { id: string } }>("/playback/videos/:id", async (req, reply) => {
    const { id } = req.params;
    const video = UUID_RE.test(id) ? await catalog.getVideo(id) : null;
    if (!video) {
      return reply.code(404).send({ error: "Not Found", message: "video not found" });
    }
    if (video.status !== "ready") {
      // The honest status: the resource exists but its current state refuses playback.
      return reply.code(409).send({ error: "Conflict", message: `video is ${video.status}, not ready` });
    }
    const { token, expiresAt } = tokens.issue(id);
    const response: PlaybackResponse = {
      playbackUrl: `/playback/${id}/${token}/${MASTER_PLAYLIST}`,
      expiresAt,
    };
    return response;
  });

  /** Auth first (403 before any storage read), then stream the object or 404. */
  async function serve(
    reply: FastifyReply,
    params: { id: string; token: string },
    key: string,
    filename: string,
  ): Promise<FastifyReply> {
    if (!UUID_RE.test(params.id)) {
      return reply.code(404).send({ error: "Not Found", message: "video not found" });
    }
    if (!tokens.verify(params.id, params.token)) {
      return reply.code(403).send({ error: "Forbidden", message: "invalid or expired playback token" });
    }
    const obj = await hlsStorage.getObjectStream(key);
    if (!obj) {
      return reply.code(404).send({ error: "Not Found", message: "no such artifact" });
    }
    reply.header("content-type", obj.contentType ?? contentTypeFor(filename));
    if (obj.contentLength !== undefined) reply.header("content-length", obj.contentLength);
    reply.header("cache-control", filename.endsWith(".m3u8") ? PLAYLIST_CACHE : SEGMENT_CACHE);
    return reply.send(obj.body);
  }

  app.get<{ Params: { id: string; token: string } }>(
    `/playback/:id/:token/${MASTER_PLAYLIST}`,
    async (req, reply) => {
      const { id } = req.params;
      return serve(reply, req.params, `${id}/${MASTER_PLAYLIST}`, MASTER_PLAYLIST);
    },
  );

  app.get<{ Params: { id: string; token: string; rung: string; file: string } }>(
    "/playback/:id/:token/:rung/:file",
    async (req, reply) => {
      const { id, rung, file } = req.params;
      if (!RUNG_RE.test(rung) || !FILE_RE.test(file)) {
        return reply.code(404).send({ error: "Not Found", message: "no such artifact" });
      }
      return serve(reply, req.params, `${id}/${rung}/${file}`, file);
    },
  );
}
