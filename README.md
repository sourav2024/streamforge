# StreamForge

A learning-first, production-grade video/audio streaming platform, built incrementally at
a senior-engineer standard. **Every concept is understood before it is implemented.**

- **Design spec:** [`docs/specs/2026-07-08-streamforge-design.md`](docs/specs/2026-07-08-streamforge-design.md)
- **Progress log (read first on resume):** [`docs/PROGRESS.md`](docs/PROGRESS.md)
- **Concept library (the learning record):** [`docs/concepts/`](docs/concepts/)

## The rhythm

For every tool/pattern we introduce: **📖 concept doc → 💻 implementation → update
`PROGRESS.md`.** Understanding precedes implementation, always.

## Repository layout

```
streamforge/
├── docs/
│   ├── PROGRESS.md          # running session log — READ FIRST on resume
│   ├── specs/               # design specs
│   └── concepts/            # 📖 one concept doc per topic (why / alternatives / trade-offs)
├── apps/
│   ├── backend/             # Node.js + TS modular monolith (Fastify)
│   ├── mobile-bare/         # bare React Native, Android first (Phase 2 — not yet created)
│   └── mobile-expo/         # Expo client (bonus, later — not yet created)
├── packages/
│   └── contracts/           # shared API contract types, used by backend + clients
├── infra/
│   └── docker-compose.yml   # Postgres + Redis + MinIO
├── turbo.json               # task orchestration + caching
└── package.json             # npm workspaces root
```

See [`docs/concepts/01-monorepo-structure.md`](docs/concepts/01-monorepo-structure.md) for
why the repo is shaped this way.

## Prerequisites

- Node.js ≥ 22 (repo pinned to 25 via `.nvmrc`), npm 11+
- Docker Desktop (for local infra)
- FFmpeg (transcoding, Phase 1) — already installed per spec §8

## Getting started

```bash
# 1. Install all workspace dependencies (one install for the whole monorepo)
npm install

# 2. Start local infra (Postgres + Redis + MinIO) in Docker
npm run infra:up          # then: docker compose -f infra/docker-compose.yml ps  → all (healthy)

# 3. Run the backend on the host (instant reload)
cp apps/backend/.env.example apps/backend/.env
npm run dev               # backend on http://localhost:3000

# 4. Verify
curl -s http://localhost:3000/health     # → {"status":"ok","time":"...","version":"0.0.0"}

# MinIO console (browse object storage): http://localhost:9001  (user/pass: streamforge)
```

Stop infra with `npm run infra:down`.

## Common tasks (run from repo root, orchestrated by Turborepo)

| Command | What it does |
|---------|--------------|
| `npm run build` | Build every workspace in dependency order (cached) |
| `npm run typecheck` | Type-check every workspace |
| `npm run dev` | Run dev servers (backend watch mode) |
| `npm run lint` | Lint (added with the first real module) |
| `npm run test` | Test (added with the first real module) |

## Where we are

Phase 0 (Foundations) — see [`docs/PROGRESS.md`](docs/PROGRESS.md) for the current module
and next action.
