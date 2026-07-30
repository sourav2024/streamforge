/**
 * Upload module — PUBLIC surface. Registers the ingest route. Depends on the upload service
 * (which itself depends on storage + catalog, injected at the composition root).
 */
import type { FastifyInstance } from "fastify";
import type { UploadService } from "./upload.service.js";
import { uploadRoutes } from "./upload.routes.js";

export { createUploadService } from "./upload.service.js";
export type { UploadService } from "./upload.service.js";

export function registerUpload(
  app: FastifyInstance,
  deps: { service: UploadService },
): void {
  uploadRoutes(app, deps.service);
}
