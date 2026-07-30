# Concept: Fastify (our backend HTTP framework)

> **📖 Concept doc — read before we build HTTP routes on top of Fastify.**
> Part of the Teaching Contract (spec §1). Grounded in the code already scaffolded at
> `apps/backend/src/app.ts` and `main.ts`.

**Status:** Approved
**Phase:** 0 — Foundations
**Decision:** Backend HTTP framework = **Fastify 5** (spec §4 listed "Express/Fastify";
this doc commits to Fastify and says why).

---

## 1. What is Fastify?

Fastify is a **web framework for Node.js**: it turns Node's low-level `http` server into
something you can build an API on without hand-writing request parsing, routing, and
response serialization. You register **routes** (URL + method → handler function), and
Fastify handles matching an incoming request to the right handler and sending the reply.

That much every framework does. What distinguishes Fastify is *how* it does it, and that
"how" is exactly what we want to learn:

1. **It is fast, by design.** The name is literal. Its router and its JSON serialization
   are heavily optimized. For a streaming platform whose backend will serve many small
   manifest/segment requests, low per-request overhead matters — and it's a good place to
   understand *why* one framework is faster than another (see §5).
2. **First-class TypeScript & schema validation.** Routes can declare a JSON Schema for
   their body/params/response; Fastify validates input at the edge and *compiles* the
   response serializer from the schema. This gives us runtime safety and a speed win at
   once (§4).
3. **A plugin/encapsulation model** that maps cleanly onto our modular-monolith
   boundaries (§3). This is the deciding factor for *this* project.

## 2. What problem does it solve (vs. raw `node:http`)?

You *can* write our backend on raw `node:http`. You'd hand-write:

- URL + method matching (a router),
- reading and JSON-parsing the request body (and guarding against malformed/huge bodies),
- setting status codes and `Content-Type`, serializing responses,
- error handling, logging, graceful shutdown wiring, 404s.

That's a lot of undifferentiated plumbing, and getting it *correct and fast* is genuinely
hard (streaming bodies, backpressure, header edge cases). A framework packages the
correct, fast version of all of it. We deliberately keep the framework thin (no NestJS —
spec §4) so we still *see* the request lifecycle, but we don't re-derive HTTP parsing from
scratch — that isn't the lesson we came for.

## 3. The core mental model: plugins & encapsulation

**Everything in Fastify is a plugin.** A plugin is just a function that receives the
Fastify instance and adds things to it (routes, decorators, hooks):

```ts
async function catalogPlugin(app: FastifyInstance) {
  app.get("/catalog", async () => { /* ... */ });
}
```

The property that makes this powerful is **encapsulation**. When you register a plugin,
Fastify gives it a *child context*. Anything the plugin adds (routes, hooks, decorators)
is visible **to itself and its children, but not to its siblings or parent** — unless you
explicitly break out. Think of it as lexical scope, but for server capabilities.

Why this is the deciding feature for StreamForge: it is the HTTP-layer expression of the
**module boundaries** from `02-why-modular-monolith.md`. Each module can be a plugin:

```
app (composition root, app.ts)
├── register(catalogPlugin)     → owns /catalog/*  routes + its own hooks
├── register(uploadPlugin)      → owns /upload/*    routes
├── register(transcodePlugin)   → owns /transcode/* routes
└── register(playbackPlugin)    → owns /playback/*  routes
```

A plugin's internal hooks (say, an auth check on `/playback/*`) don't leak onto
`/catalog/*`. The framework *enforces* separation the same way our lint boundary rule will
enforce it at the import level. When we later extract a module into its own service (Phase
4), a module that's already an encapsulated plugin lifts out cleanly — its routes and
middleware come with it.

> Escape hatch to know about: wrapping a plugin with **`fastify-plugin`** deliberately
> *disables* encapsulation, so what it adds is visible to the whole app. That's how you
> write shared infrastructure (e.g. "decorate every request with a DB client"). Rule of
> thumb: **feature/module = encapsulated plugin; shared infrastructure = `fastify-plugin`.**

### Decorators & hooks (the other two primitives)

- **Decorators** attach reusable things onto the instance/request/reply, e.g.
  `app.decorate("db", db)` then use `app.db` anywhere in scope. This is how our
  composition root will hand a module its dependencies (DI, by hand — spec §4).
- **Hooks** run at points in the request lifecycle (`onRequest`, `preHandler`,
  `onSend`, `onError`, …). Auth, logging, and timing live here. Encapsulation applies:
  a hook added inside a plugin only fires for that plugin's routes.

## 4. Schema-based validation & serialization (the standout feature)

A Fastify route can carry a JSON Schema:

```ts
app.get("/health", {
  schema: {
    response: {
      200: {
        type: "object",
        required: ["status", "time", "version"],
        properties: {
          status:  { type: "string" },
          time:    { type: "string" },
          version: { type: "string" },
        },
      },
    },
  },
}, async (): Promise<HealthResponse> => ({ status: "ok", time: new Date().toISOString(), version }));
```

Two things happen:
- **Input validation** (for `body`/`params`/`querystring`): malformed requests are
  rejected at the edge with a 400 before your handler runs. Security + correctness for
  free — critical once we accept uploads and signed-URL params.
- **Output serialization:** Fastify *compiles* a serializer specialized to that schema.
  Compiling `JSON.stringify` for a known shape is dramatically faster than the generic
  one, and it guarantees you never accidentally leak a field not in the schema.

Note the two layers we'll run: **TypeScript types** (`HealthResponse` from
`@streamforge/contracts`) give us *compile-time* safety; **JSON Schema** gives us
*runtime* safety. They're complementary — the type checks our code, the schema checks the
outside world's data. (Libraries like `typebox`/`zod` can generate one from the other; a
lesson for when routes get real in Phase 1.)

## 5. Why Fastify over the alternatives

| Alternative | Why not (for us) |
|-------------|------------------|
| **Express** | The classic, biggest ecosystem/tutorials. But: older callback-middleware model, weak built-in TS types, no built-in validation/serialization (bolt on many libs), slower, and its middleware is global-by-default — the *opposite* of the encapsulation we want for module boundaries. Express 5 modernizes some of this but the ergonomics still trail. |
| **NestJS** | Batteries-included (DI container, decorators, module system). Explicitly rejected in spec §4: it *hides* the DI and module-boundary lessons we came to learn behind decorators and magic. We want to build those by hand first. |
| **Koa** | Minimal, elegant async middleware from the Express authors — but *too* minimal; you assemble a framework from parts. More plumbing than we want, less structure than Fastify's plugin model gives. |
| **Hono / raw `node:http`** | Hono is great and fast (edge-first); raw http is maximal control. Both push more per-route plumbing onto us than is worth it here. |
| **Fastify** ✅ | Fast, first-class TS, built-in schema validation + serialization, and — decisively — an **encapsulated plugin model that mirrors our modular-monolith boundaries** and survives the future service extraction. Thin enough that the request lifecycle stays visible. |

## 6. How our scaffolded code uses it (walkthrough)

- `app.ts` → `Fastify({ logger: {...} })` creates the instance. Fastify ships with
  **Pino** structured logging built in (`app.log`), so we get JSON logs and per-request
  log context without extra setup — we'll lean on this for observability (Phase 4 #13).
- `app.get("/health", async () => ({...}))` registers our one route. Its return value is
  the response body; Fastify serializes it and sets `Content-Type: application/json`. We
  type the return as `HealthResponse` from the shared contract.
- The `// Phase 1 modules register here` comment marks where
  `app.register(catalogPlugin)` etc. will go — turning §3's diagram into code.
- `main.ts` → `app.listen({ host, port })` starts the server and `app.close()` drains it
  on SIGTERM. `close()` runs plugins' `onClose` hooks, so each module can release its
  resources (DB pools, queue connections) cleanly — important in Docker.

## 7. What we're deferring (and when it lands)

- **Route schemas** on real endpoints → Phase 1, when routes accept input worth validating.
- **`@fastify/*` plugins** (`@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`,
  `@fastify/multipart` for uploads, `@fastify/static`/range support for serving segments) →
  as each need appears; each gets a mention when introduced.
- **Auth hooks / signed-URL verification** → Phase 4 #11.

## 8. Glossary

- **Plugin** — a function `(app, opts) => void` that adds routes/decorators/hooks. The unit
  of composition in Fastify.
- **Encapsulation** — a plugin's additions are scoped to it and its children by default.
- **`fastify-plugin`** — a wrapper that *breaks* encapsulation to share infrastructure app-wide.
- **Decorator** — a value attached to the instance/request/reply for reuse (`app.db`).
- **Hook** — a function run at a lifecycle point (`onRequest`, `preHandler`, `onSend`, …).
- **Schema** — JSON Schema on a route; drives input validation and compiled output serialization.
- **Pino** — the fast JSON logger Fastify integrates as `app.log`.

---

**Next:** with Fastify understood, we finish the Phase 0 scaffold — the infra concept doc +
`infra/docker-compose.yml` (Postgres + Redis + MinIO) — then boot everything and confirm
`/health` responds and the containers pass health checks.
