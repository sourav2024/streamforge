# Concept: Postgres Data Access — raw SQL, pooling, migrations

> **📖 Concept doc — read before `platform/db.ts`, the migration, and the catalog repository.**
> Part of the Teaching Contract (spec §1). Grounds the metadata half of the Storage &
> Upload slice.

**Status:** Approved
**Phase:** 1 #1 — Storage & Upload
**Decision:** Talk to Postgres with the **`pg` driver + hand-written parameterized SQL**,
manage schema with **`node-pg-migrate`**. No ORM (spec §4; brainstorm decision).

---

## 1. The layers between our code and the database

There's a spectrum of abstraction for talking to a SQL database:

| Layer | Example | What you write | What's hidden |
|-------|---------|----------------|---------------|
| **Raw driver** | `pg` | SQL strings + params | nothing — you see every query |
| **Query builder** | Kysely, Knex | typed method chains → SQL | SQL string assembly |
| **ORM** | Prisma, TypeORM, Drizzle | models/entities | SQL, relations, migrations, identity map |

We chose the **raw driver**. For a learning project whose principle is "nothing is a black
box" (spec §1, §4), writing the SQL ourselves means we *understand* exactly what hits the
database — no surprise N+1 queries, no magic lazy-loading, no ORM query-planner mysteries.
The cost is more typing and no compile-time column checking; we accept that now and can
adopt a query builder later as an informed upgrade (the same "build it, then compare"
pattern we use elsewhere). An ORM would hide precisely the lessons we came for.

## 2. The `pg` driver and the connection **pool**

Postgres speaks a wire protocol over a TCP connection. Opening a connection is
*expensive* (TCP handshake + auth + backend process spawn on the server). Two naive
options are both wrong:

- **One shared connection for everything** — serializes all queries (one connection can
  run one query at a time) and a single network blip kills the whole app.
- **A new connection per query** — pays the expensive setup every time and can exhaust
  Postgres's connection limit under load.

The right answer is a **connection pool**: a bounded set of pre-opened connections that are
*checked out* for a query and *returned* afterward, to be reused. `pg`'s `Pool` does this
for us:

```ts
import pg from "pg";
export function createPool(config) {
  return new pg.Pool({ connectionString: config.databaseUrl });
}
// usage: const { rows } = await pool.query("select ... where id = $1", [id]);
```

`pool.query(...)` transparently checks out a free connection, runs the query, and returns
it. The pool caps concurrency (default 10), provides **backpressure** (queries queue when
all connections are busy rather than overwhelming the DB), and survives individual
connection failures. We construct **one pool** at the composition root and inject it into
the catalog repository — the app's single, shared door to Postgres. On shutdown we
`pool.end()` (wired to Fastify's `onClose`) to drain it cleanly.

`DATABASE_URL` (`postgres://user:pass@host:port/db`) is the standard connection string;
ours points at the Dockerized Postgres on `localhost:5432` (dev creds from compose).

## 3. Parameterized queries (never string-concatenate SQL)

The single most important safety rule. **Never** build SQL by splicing values into the
string:

```ts
// ❌ NEVER — SQL injection: a title of "'); drop table videos; --" is catastrophic
pool.query(`insert into videos (title) values ('${title}')`);

// ✅ ALWAYS — placeholders; the driver sends SQL and values separately
pool.query("insert into videos (title) values ($1)", [title]);
```

With `$1, $2, …` **placeholders**, the driver sends the query text and the parameter values
to Postgres as *separate* things. Postgres treats the values purely as data — they can
never be parsed as SQL. This eliminates SQL injection *and* handles quoting/escaping/types
correctly for free. Every query in the catalog repository uses placeholders.

### snake_case ↔ camelCase

SQL convention is `snake_case` columns (`storage_key`, `created_at`); TypeScript convention
is `camelCase` (`storageKey`, `createdAt`). The repository is the **mapping boundary**: it
reads snake_case rows and returns camelCase domain objects (the `Video` contract type). One
place does the translation, so the rest of the app only ever sees camelCase. Note a `pg`
quirk we handle there: `BIGINT` comes back as a **string** (JS numbers can't safely hold
all 64-bit integers), so `size_bytes` is `Number(...)`-converted in the mapper.

## 4. Migrations — versioning the schema

The database schema (tables, columns, indexes) is *state* that must evolve in lockstep with
code, across every environment (your machine, a teammate's, CI, prod). You cannot just
"remember" to run `CREATE TABLE` everywhere. **Migrations** solve this: each schema change
is a small, ordered, checked-in script.

`node-pg-migrate` gives us:
- **Timestamped migration files** (`<timestamp>_create-videos.js`) run in order. The
  timestamp prefix guarantees a total ordering even when multiple people add migrations.
- **`up` and `down`** functions per migration — `up` applies the change, `down` reverses
  it. Reversibility lets us roll back and proves the migration is well-understood (our plan
  verifies the `down` works, then re-applies `up`).
- A **`pgmigrations` bookkeeping table** the tool maintains in your database, recording
  which migrations have run. So `migrate up` is idempotent — it applies only what's
  pending, never re-runs an applied migration. This is how any environment converges to the
  same schema by running one command.

We use its small JS DSL (`pgm.createTable(...)`) rather than raw DDL strings — it's still
transparent (it's just building SQL) and gives ergonomic, reversible operations. Forward
motion is **append-only**: you don't edit an applied migration, you add a new one.

> **DDL vs DML vs DCL** (SQL vocabulary): **DDL** = Data *Definition* Language — structure
> (`CREATE`/`ALTER`/`DROP TABLE`); this is what migrations do. **DML** = Data
> *Manipulation* — rows (`INSERT`/`SELECT`/`UPDATE`/`DELETE`); this is what the repository
> does at runtime. **DCL** = Data *Control* — permissions (`GRANT`/`REVOKE`).

## 5. Transactions (named now, used when we need them)

A **transaction** groups statements so they all commit or all roll back — atomicity. This
slice inserts a single row (atomic on its own), so we don't open an explicit transaction
yet. They become relevant when one operation must write multiple rows consistently (e.g.
inserting a video plus its rendition rows in the transcoding phase). Flagged here; the
mechanism (`BEGIN`/`COMMIT`/`ROLLBACK`, or `pool.connect()` + a dedicated client) arrives
when a use case demands it.

## 6. How this maps to our code

- `platform/db.ts` — `createPool(config)`; the single shared `Pool`.
- `migrations/<ts>_create-videos.js` — the `videos` table (spec §5), reversible.
- `modules/catalog/catalog.repository.ts` — the **only** code that runs SQL against
  `videos` (module data-ownership rule, `docs/concepts/02-why-modular-monolith.md` §3).
  Parameterized queries; snake↔camel mapping lives here.

## 7. Trade-offs we accept (this slice)

| We accept | Because |
|-----------|---------|
| Hand-written SQL, no compile-time column safety | Full transparency; ORM/query-builder is a later informed upgrade. |
| Manual snake↔camel mapping in the repository | One clear boundary; no hidden ORM naming magic. |
| `BIGINT` → string → `Number` conversion | `pg` default; safe for our sizes, explicit in the mapper. |
| No explicit transactions yet | Single-row insert is atomic; add them when a multi-write use case appears. |

## 8. Glossary

- **`pg`** — the Node Postgres driver.
- **Connection pool** — reusable bounded set of DB connections; caps concurrency, adds backpressure.
- **`DATABASE_URL`** — `postgres://user:pass@host:port/db` connection string.
- **Parameterized query** — SQL with `$1` placeholders; values sent separately (injection-safe).
- **Migration** — an ordered, reversible, checked-in schema change script.
- **`up`/`down`** — apply / reverse a migration.
- **`pgmigrations` table** — the tool's record of which migrations have run (idempotency).
- **DDL / DML / DCL** — schema / rows / permissions SQL.
- **Transaction** — all-or-nothing group of statements (`BEGIN`/`COMMIT`/`ROLLBACK`).

---

**Next:** `07-media-metadata-ffprobe.md` — extracting real metadata from the uploaded file.
