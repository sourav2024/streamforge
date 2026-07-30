# Concept: Why a Modular Monolith (and how we'll extract services later)

> **📖 Concept doc — read before scaffolding `apps/backend`.**
> Part of the Teaching Contract (spec §1). This decides the *internal shape* of the
> backend for all of Phase 1.

**Status:** Approved
**Phase:** 0 — Foundations
**Decision:** Start as a **modular monolith**. Extract to microservices *later, as a
deliberate lesson* (spec §5, Phase 4 #14).

---

## 1. The three architectures, defined

Imagine our backend's jobs: Catalog, Upload, Transcode, Playback (spec §3).

- **Big-ball-of-mud monolith** — one process, one codebase, *no internal boundaries*.
  Upload code reaches directly into Catalog's database tables; everything imports
  everything. Fast to start, impossible to reason about or split later.

- **Modular monolith** — **one deployable process**, but internally divided into modules
  (`catalog`, `upload`, `transcode`, `playback`) with **enforced boundaries**: each module
  owns its data and exposes a narrow interface; other modules call that interface, never
  the internals. It runs as a single app, but the *seams of a distributed system are
  already drawn*.

- **Microservices** — each module is its **own process**, deployed independently,
  communicating over the network (HTTP/gRPC/queues), each with its own database.
  Independent scaling and deploys, at the cost of network calls, partial failure,
  distributed transactions, and a lot of operational machinery.

```
BIG BALL OF MUD          MODULAR MONOLITH              MICROSERVICES
┌───────────────┐        ┌───────────────────┐         ┌────┐ ┌────┐ ┌────┐
│ everything     │        │ ┌────┐┌────┐┌────┐│         │Cat.│ │Upl.│ │Tr. │
│ imports        │        │ │Cat.││Upl.││Tr. ││         └─┬──┘ └─┬──┘ └─┬──┘
│ everything     │        │ └────┘└────┘└────┘│           │ net  │ net  │
│ (no seams)     │        │  ↑ interfaces only│         ┌─┴──────┴──────┴─┐
└───────────────┘        │  one process      │         │  network fabric  │
  1 process, 0 seams      └───────────────────┘         └──────────────────┘
                            1 process, N seams            N processes, N seams
```

## 2. The problem each solves — and why the *middle* is right for us

The real question is **"where do the boundaries go, and are they in-process or over the
network?"**

Microservices' benefits (independent scale/deploy, fault isolation, team autonomy) are all
**organizational and scale** benefits. They pay off when you have *many teams* and *real
scale pressure*. Their costs are paid **immediately and always**:

- Every cross-module call is now a network call — latency, retries, timeouts, serialization.
- **Partial failure** becomes the norm — Transcode can be down while Catalog is up.
- No more DB transactions across modules — you need sagas / eventual consistency.
- You need service discovery, per-service CI/CD, distributed tracing, and local dev that
  spins up N services just to test one flow.

For a **solo learning project at the start**, paying all of that on day one would (a) bury
the streaming concepts we actually came to learn under distributed-systems plumbing, and
(b) be premature — we have no scale or team pressure yet.

The **big ball of mud** is rejected outright: it's the one option with no path forward. It
feels fast early and becomes a tar pit exactly when the project gets interesting.

The **modular monolith** gives us:
- **Simplicity now:** one process, one deploy, real DB transactions, trivial local dev,
  a debugger that steps through the whole flow. Concepts stay in focus.
- **A real path later:** because boundaries are enforced from day one, extracting a module
  into its own service is a *mechanical* change (swap an in-process interface call for a
  network client) rather than a rewrite. **The extraction itself becomes a senior lesson**
  (Phase 4) — we'll feel exactly which boundary deserves to be a service and why.

This is the industry's own trajectory in miniature: most successful microservice systems
*started* as well-structured monoliths and extracted services when a specific pain
(scaling one hot path, an independent deploy cadence) justified it. "Monolith first" is a
mainstream senior position, not a compromise.

## 3. What "enforced boundaries" concretely means in our code

A module is a directory under `apps/backend/src/modules/<name>/` with a **public
interface** and **private internals**:

```
apps/backend/src/
├── modules/
│   ├── catalog/
│   │   ├── index.ts        ← PUBLIC surface. The ONLY thing other modules may import.
│   │   ├── catalog.service.ts
│   │   ├── catalog.repository.ts   ← owns catalog's Postgres tables. Private.
│   │   └── catalog.routes.ts
│   ├── upload/
│   ├── transcode/
│   └── playback/
├── platform/               ← cross-cutting infra (db client, redis, config, logger)
└── app.ts                  ← composition root: wires modules together
```

The rules that make it a *modular* monolith and not a ball of mud:

1. **Import only through `index.ts`.** `upload` may `import { catalogService } from
   '../catalog'` — it may **never** `import { db } from '../catalog/catalog.repository'`.
   The interface is the contract; internals are free to change.
2. **A module owns its data.** Only `catalog`'s code touches `catalog`'s tables. If
   `playback` needs catalog data, it calls `catalogService`, it does not query the tables.
   *This is the single most important rule* — it's what makes a future split possible,
   because shared tables are the thing you cannot pull apart over a network.
3. **Dependencies point inward / through interfaces**, wired at the composition root
   (`app.ts`). Modules don't construct each other's guts; they receive interfaces. This is
   dependency injection done *by hand* — which the spec (§4) explicitly wants so we
   understand what frameworks like NestJS do for you.

How we *enforce* it (not just document it): an ESLint boundary rule (e.g.
`eslint-plugin-boundaries` or a `no-restricted-imports` pattern) that fails the build if
one module deep-imports another's internals. Boundaries that aren't enforced rot. We'll
add this when the second module lands.

## 4. The extraction path (the payoff, later)

When Phase 4 comes, extracting `transcode` into its own service looks like:

1. `transcode` already talks to the rest only via its `index.ts` interface and its own
   data + the job queue. Good — no shared tables to untangle.
2. Replace the in-process interface with a **network client** (the callers' code barely
   changes — they still call `transcodeService.enqueue(...)`, it now goes over the wire).
3. Deploy `transcode` as a separate process; point it at the same Redis queue.
4. Observe what got harder (failure handling, tracing) — *that's the lesson.*

Because we drew the seams up front, this is an afternoon, not a quarter. That contrast —
felt firsthand — is the entire point of choosing this path.

## 5. Trade-offs we are explicitly accepting

| We accept now | Because |
|---------------|---------|
| Slightly more ceremony than a ball of mud (interfaces, composition root) | It's the discipline that keeps the future open; small cost, huge option value. |
| One process = one scaling unit for now | We have no scale pressure; when we do, extraction is ready. |
| Discipline is human-enforced until lint rule lands | We add the ESLint boundary rule with the 2nd module; short window. |
| DI by hand instead of a framework | Deliberate — spec §4. Understanding > convenience here. |

## 6. Glossary

- **Module** — a bounded internal unit (catalog/upload/transcode/playback) with a public
  interface and private internals.
- **Public surface / interface** — the `index.ts` exports; the only legal import target.
- **Composition root** — the single place (`app.ts`) where modules are instantiated and
  wired together.
- **Boundary rule** — a lint rule that fails the build on illegal cross-module imports.
- **Data ownership** — the rule that a module's tables are touched only by that module.
- **Extraction** — later turning a module into its own deployed service.

---

**Next:** with both concept docs done, we scaffold the repo per
`01-monorepo-structure.md`, create `apps/backend` shaped per this doc, and write
`infra/docker-compose.yml`.
