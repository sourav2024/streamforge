import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "./db.js";
import { loadConfig } from "./config.js";

test("createPool builds a pool from config without connecting", () => {
  process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
  const pool = createPool(loadConfig());
  assert.ok(pool, "pool should be created");
  assert.equal(typeof pool.query, "function");
  void pool.end();
});
