/**
 * Catalog HTTP layer. Knows ONLY about HTTP: URLs, params, status codes, response shape.
 * It calls the service and never touches SQL or business rules. The one decision it owns is
 * translating a domain fact (service returns null = "no such video") into an HTTP fact (404).
 */
import type { FastifyInstance } from "fastify";
import type { CatalogService } from "./catalog.service.js";
import type { VideoListResponse } from "@streamforge/contracts";

// The `id` column is a Postgres `uuid`; a non-UUID string makes Postgres throw at parse time
// (error 22P02) rather than return zero rows. Guard the shape here so a malformed id reads as
// "no such video" (404) instead of leaking a 500 — the HTTP layer owns request-shape decisions.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function catalogRoutes(app: FastifyInstance, service: CatalogService): void {
  app.get("/catalog/videos", async (): Promise<VideoListResponse> => {
    return { videos: await service.listVideos() };
  });

  app.get<{ Params: { id: string } }>("/catalog/videos/:id", async (req, reply) => {
    const { id } = req.params;
    const video = UUID_RE.test(id) ? await service.getVideo(id) : null;
    if (!video) {
      return reply.code(404).send({ error: "Not Found", message: "video not found" });
    }
    return video;
  });
}
