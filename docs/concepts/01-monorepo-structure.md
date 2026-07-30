# Concept: Monorepo Structure (npm workspaces + Turborepo)

> **📖 Concept doc — read before the repo scaffold.**
> Part of the Teaching Contract (spec §1): understand it before we build it.

**Status:** Approved
**Phase:** 0 — Foundations
**Decisions locked:** npm workspaces (package manager & linking) + Turborepo (task runner & cache).

---

## 1. What is a monorepo?

A **monorepo** is a single version-controlled repository that holds *multiple*
distinct-but-related projects (here: a backend, two mobile apps, and shared packages),
each with its own `package.json`, but sharing one dependency tree, one toolchain config,
and one git history.

The opposite is a **polyrepo**: one git repo per project, wired together by publishing
packages to a registry (npm) and consuming versioned releases across repos.

For StreamForge the units are:

```
apps/backend        — Node + TS modular monolith
apps/mobile-bare    — bare React Native (Phase 2)
apps/mobile-expo    — Expo client (bonus, later)
packages/*          — shared code, e.g. the API contract (types) used by ALL of the above
```

## 2. The problem it solves

Our three apps are **not independent** — they share a contract. When the backend adds a
field to the `/playback` response, the mobile app's TypeScript types must change in
lockstep or the client breaks at runtime. There are two ways to keep them in sync:

- **Polyrepo:** put shared types in `@streamforge/contracts`, publish it to a registry,
  and have each app depend on a *version*. Every contract change is: bump version →
  publish → update each consumer's `package.json` → install. Slow, and it's easy for the
  app to lag a version behind the backend (the classic "works on my machine, breaks in
  prod" drift).
- **Monorepo:** the app imports `@streamforge/contracts` directly from `packages/` in the
  same tree. A contract change is *one commit* that touches the type, the backend, and the
  app together. The compiler sees the mismatch the instant you make it. **Atomic
  cross-project changes** is the headline benefit.

Other benefits that matter for a learning project specifically:
- **One `npm install`** sets up everything; one place for shared tooling config
  (TypeScript, lint, format) so every workspace is held to the same standard.
- **One git history** — a session can see the whole system evolve in one log, which is
  exactly what our continuity system (spec §7) wants.

## 3. The two tools, and why they are *separate concerns*

This is the key mental model. "Monorepo tooling" is really **two jobs**, and people
conflate them:

| Job | Question it answers | Our tool |
|-----|---------------------|----------|
| **Workspace / linking** | "How do the packages find and depend on each other, and where do node_modules live?" | **npm workspaces** |
| **Task orchestration** | "When I run `build`, in what order do packages build, and can we skip work that didn't change?" | **Turborepo** |

They are independent. You can have workspaces with no task runner (just
`npm -w <pkg> run build` by hand). You can, in theory, run tasks without workspaces. We
use both because each solves a real, distinct problem.

### 3a. npm workspaces — the linking layer

Declared in the **root** `package.json`:

```jsonc
{
  "private": true,
  "workspaces": ["apps/*", "packages/*"]
}
```

What this buys us:
- **Hoisting:** dependencies shared across workspaces are installed once at the root
  `node_modules`, not duplicated per package. One install, less disk, consistent versions.
- **Symlinked local packages:** when `apps/backend` lists `"@streamforge/contracts": "*"`
  as a dependency, npm symlinks it to `packages/contracts` on disk instead of downloading
  from a registry. `import { ... } from '@streamforge/contracts'` resolves to your local
  source. Edit the type, the backend sees it immediately — no publish step.

Why npm workspaces and not pnpm/yarn workspaces?
- All three support workspaces; the concept is identical.
- We already standardized on **npm** in the spec (§8 toolchain). Introducing pnpm now adds
  a new package-manager mental model (its strict symlinked `node_modules`, its
  `pnpm-workspace.yaml`) *before* we've felt npm's limitations. Consistent with "don't add
  a tool before you feel the pain it solves." pnpm's wins (stricter dep isolation, faster,
  less disk) are real but are an **optimization we can adopt later as a lesson**, the same
  way we'll extract microservices later.

### 3b. Turborepo — the task-orchestration layer

Workspaces link packages but say *nothing* about running tasks across them. Without a task
runner, "build everything in the right order" is a manual, error-prone chore, and every
`build` re-does all work even if nothing changed. Turborepo solves two things:

1. **Task graph / ordering.** You declare that a package's `build` depends on its
   dependencies' `build` (`"dependsOn": ["^build"]`). Turbo topologically sorts the
   workspaces and runs them in the correct order, parallelizing independent ones.
2. **Caching.** Turbo hashes each task's inputs (source files, deps, env). If the hash is
   unchanged since last run, it **replays the cached output instantly** instead of
   re-running. On a repo with a backend + two RN apps, this is the difference between a
   3-second and a 30-second `build`.

Minimal `turbo.json`:

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":   { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint":    {},
    "test":    { "dependsOn": ["^build"] },
    "dev":     { "cache": false, "persistent": true }
  }
}
```

`^build` = "the `build` of everything I depend on, first." `persistent: true` marks
long-running dev servers so turbo doesn't wait for them to exit.

### Why Turborepo over the alternatives

| Alternative | Why not (for us, now) |
|-------------|------------------------|
| **Nothing** (`npm -w` by hand) | Fine for one package; painful and error-prone across 4+. No caching, manual ordering. We'd outgrow it in Phase 2. |
| **Nx** | More powerful (generators, plugins, dep graph viz, computation caching) but a much bigger conceptual surface and more opinionated. Heavier than we need; the abstraction would hide lessons. |
| **Bazel** | Google-scale, language-agnostic, hermetic builds. Enormous learning curve; wildly overkill for a Node/TS repo. |
| **Turborepo** | Small, focused, does exactly the two jobs above with almost no config. Easy to read what it's doing — fits "nothing is a black box." |

**Honest trade-off we accept:** Turbo is technically a tool we could defer (npm workspaces
alone would work in Phase 0). We adopt it now anyway because (a) its config is tiny and
transparent, and (b) task ordering + caching become genuinely useful the moment the second
workspace appears, which is soon. This is a deliberate exception to "defer tools," made
with eyes open — not a black box.

## 4. How the pieces resolve together (the flow)

```
root package.json  ──workspaces──▶  npm links packages/* and apps/* into one node_modules
        │
        │   apps/backend depends on "@streamforge/contracts": "*"
        ▼
   npm symlinks packages/contracts  ──▶  backend imports it as local source (no publish)
        │
turbo.json  ──reads each workspace's package.json scripts──▶  builds contracts BEFORE backend
        │                                                      (because ^build), caches results
        ▼
   `turbo run build`  →  correct order, parallel where possible, cached on repeat
```

## 5. TypeScript across the monorepo

Two layers, mirroring the two-tool split:
- A **root `tsconfig.base.json`** holds shared compiler options (`strict: true`, target,
  module resolution). Every workspace's `tsconfig.json` does `"extends":
  "../../tsconfig.base.json"` so the standard is uniform.
- **Project references** (`"references": [{ "path": "../../packages/contracts" }]`) let
  `tsc` understand cross-package dependencies and build them incrementally — the
  compiler-level analogue of Turbo's task graph. (We'll wire these as packages appear; not
  needed until `packages/contracts` exists.)

## 6. What we are NOT doing (and why)

- **Not** publishing any package to npm — everything stays internal (`"private": true`).
- **Not** adding changesets/release tooling — we ship nothing externally.
- **Not** setting up remote Turbo cache (Vercel) — local cache is enough; remote caching is
  a CI optimization we don't need solo.

## 7. Glossary

- **Workspace** — one package (an `apps/*` or `packages/*` dir with its own package.json).
- **Hoisting** — installing shared deps once at the root instead of per package.
- **Task graph** — the DAG of "task X must run after task Y" across workspaces.
- **Topological order** — running dependencies before dependents.
- **`^` (caret) in turbo** — "in my dependencies," as opposed to a task in the same package.

---

**Next concept doc:** `02-why-modular-monolith.md` — the *architecture* decision that
determines what lives inside `apps/backend`.
