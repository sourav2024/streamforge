/**
 * Composition root.
 *
 * This is the ONE place where modules are constructed and wired together (see
 * docs/concepts/02-why-modular-monolith.md §3). `buildApp` takes its dependencies as
 * arguments rather than reaching for globals — that is dependency injection done by hand,
 * which the spec (§4) wants us to understand rather than hide behind a framework.
 *
 * As modules arrive in Phase 1, each exposes a `register<Module>(app, deps)` function from
 * its `index.ts`, and we call it here. Modules never wire themselves into each other; the
 * composition root does it.
 */

import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { Config } from "./platform/config.js";
import type { HealthResponse } from "@streamforge/contracts";
import { createPool } from "./platform/db.js";
import { createStorage } from "./platform/storage.js";
import { probeVideo } from "./platform/ffprobe.js";
import {
  createCatalogRepository,
  createCatalogService,
  registerCatalog,
} from "./modules/catalog/index.js";
import { createUploadService, registerUpload } from "./modules/upload/index.js";
import { createTranscodeProducer } from "./modules/transcode/index.js";
import { redisConnectionOptions } from "./platform/redis.js";

// Read the backend version from package.json at runtime (single source of truth).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/app.js -> ../package.json ; src/app.ts (tsx) -> ../package.json
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "production" ? "info" : "debug",
    },
  });

  // Multipart parsing for file uploads (registering a plugin is async, hence buildApp is async).
  await app.register(multipart, {
    limits: { fileSize: config.uploadMaxBytes, files: 1 },
  });

  const version = readVersion();

  // Health endpoint. Uses the shared contract type so the client and backend can never
  // disagree on the shape (docs/concepts/01-monorepo-structure.md §2).
  app.get("/health", async (): Promise<HealthResponse> => {
    return {
      status: "ok",
      time: new Date().toISOString(),
      version,
    };
  });

  // --- composition root: construct shared infra, then wire modules (DI by hand) ---
  const pool = createPool(config);
  const storage = createStorage(config, config.s3.bucketRaw);

  const catalogRepo = createCatalogRepository(pool);
  const catalogService = createCatalogService(catalogRepo);
  registerCatalog(app, { service: catalogService });

  // Upload depends on storage + catalog + probe + the transcode producer (all injected here).
  const transcodeProducer = createTranscodeProducer(redisConnectionOptions(config));
  const uploadService = createUploadService({
    storage,
    catalog: catalogService,
    probe: probeVideo,
    transcode: transcodeProducer,
  });
  registerUpload(app, { service: uploadService });

  // Ensure the raw bucket exists before we accept any upload.
  await storage.ensureBucket();

  // Release the DB pool + queue connection on shutdown (graceful close from main.ts).
  app.addHook("onClose", async () => {
    await transcodeProducer.close();
    await pool.end();
  });

  return app;
}
