/**
 * Catalog module — PUBLIC surface. Other modules may import ONLY from here
 * (docs/concepts/02-why-modular-monolith.md §3, rule 1). Exposes the construction functions,
 * the service type, and `registerCatalog` (installs the HTTP routes at the composition root).
 */
import type { FastifyInstance } from "fastify";
import type { CatalogService } from "./catalog.service.js";
import { catalogRoutes } from "./catalog.routes.js";

export { createCatalogRepository } from "./catalog.repository.js";
export type { CatalogRepository } from "./catalog.repository.js";
export { createCatalogService } from "./catalog.service.js";
export type { CatalogService } from "./catalog.service.js";

export function registerCatalog(
  app: FastifyInstance,
  deps: { service: CatalogService },
): void {
  catalogRoutes(app, deps.service);
}
