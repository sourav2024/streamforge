/**
 * Postgres access — a shared connection Pool (see docs/concepts/06-postgres-data-access.md).
 * A Pool reuses a bounded set of connections across concurrent requests rather than opening
 * one per query. Constructed once at the composition root and injected into modules.
 */
import pg from "pg";
import type { Config } from "./config.js";

export type Pool = pg.Pool;

export function createPool(config: Config): pg.Pool {
  return new pg.Pool({ connectionString: config.databaseUrl });
}
