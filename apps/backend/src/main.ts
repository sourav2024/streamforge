/**
 * Process entry point.
 *
 * Responsibilities kept deliberately thin: load config, build the app (composition root),
 * start listening, and handle graceful shutdown. All wiring lives in app.ts.
 */

import { buildApp } from "./app.js";
import { loadConfig } from "./platform/config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  // Graceful shutdown: on SIGINT/SIGTERM, stop accepting connections and let in-flight
  // requests drain before exiting. Matters in containers (Docker sends SIGTERM on stop).
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, "shutting down");
      app
        .close()
        .then(() => process.exit(0))
        .catch((err) => {
          app.log.error(err, "error during shutdown");
          process.exit(1);
        });
    });
  }

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error(err, "failed to start");
    process.exit(1);
  }
}

void main();
