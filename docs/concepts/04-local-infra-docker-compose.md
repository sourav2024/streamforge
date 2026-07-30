# Concept: Local Infra with Docker Compose (Postgres + Redis + MinIO)

> **📖 Concept doc — read before `infra/docker-compose.yml`.**
> Part of the Teaching Contract (spec §1). This is the Phase 0 infrastructure deliverable:
> "infra boots, health checks pass."

**Status:** Approved
**Phase:** 0 — Foundations
**Decision:** All backing services run locally via **Docker Compose** (spec §4): Postgres,
Redis, MinIO. The backend itself runs on the host during development (fast reload); the
*stateful dependencies* run in containers.

---

## 1. The two ideas: containers, then Compose

### 1a. Docker / containers (the "what")

A **container** is a process running in an isolated slice of your OS — its own filesystem,
network, and view of the world — created from an **image** (a read-only, layered snapshot
of "a filesystem + a command to run"). It is *not* a VM: there's no guest OS: containers
share the host kernel, so they start in milliseconds and are cheap.

Why we care for StreamForge:
- **Parity with production.** Prod will run Postgres/Redis/object-storage as managed
  services or containers. Running the *same* Postgres image locally means "works on my
  machine" actually predicts "works in prod." A `brew install postgresql` gives you a
  different version, config, and file layout than prod — a classic source of drift.
- **Isolation & reproducibility.** The exact version is pinned in the image tag. No
  polluting your Mac with service installs; `down` removes it cleanly.
- **It's a streaming-industry norm** — knowing containers is table stakes for the "senior"
  phases (scaling, extract-to-services).

Key vocabulary: **image** (the template) vs **container** (a running instance of it);
**port mapping** (`host:container`) to reach a container's port from your Mac; **volume**
(persistent storage that outlives a container so your DB data survives a restart);
**environment variables** (how you configure an image at boot).

### 1b. Docker Compose (the "how we run several together")

Running three services by hand (`docker run ...` ×3, wiring a network, remembering every
flag) is tedious and unrepeatable. **Docker Compose** is a tool that reads one declarative
YAML file describing a set of services and brings them **all up/down together on a shared
network** with one command:

```
npm run infra:up     # docker compose -f infra/docker-compose.yml up -d
npm run infra:down   # ...down
npm run infra:logs   # ...logs -f
```

Compose gives us: one source of truth for the whole local stack, a private network where
services find each other **by service name** (the `postgres` service is reachable at
host `postgres` from inside the network), named volumes for persistence, and
`healthcheck` blocks so we can *know* a service is truly ready (not just "started").

Why Compose and not the alternatives, for local dev:
- **Plain `docker run` scripts** — works, but you rebuild Compose badly by hand.
- **Kubernetes / minikube / kind** — this is what *production* orchestration looks like,
  and we'll meet it in the scaling phase. For local dev it's massive overkill: huge
  conceptual surface for running three services. Compose is the right tool for the
  developer-inner-loop; k8s is the right tool for prod. Using the right one *for its job*
  is itself the lesson.
- **Podman/`compose` variants** — same spec, fine, but Docker Desktop is what's installed
  (spec §8).

## 2. The three services, and why each is here

Each maps directly to a box in the architecture diagram (spec §3).

### Postgres — metadata database
Relational store for catalog metadata (titles, renditions, upload/transcode job records).
Chosen over MySQL/Mongo for relational catalog data + JSONB flexibility (spec §4). In
Phase 0 it just needs to *boot and be reachable*; schema/migrations arrive with the
Storage & Upload module (Phase 1 #1).

### Redis — job queue backing store
Redis is an in-memory data-structure store. We use it as the backing store for **BullMQ**,
our transcode job queue (spec §4): the Upload service enqueues a "transcode this file" job;
the FFmpeg worker pops it. Transcoding is slow and must be asynchronous/background — a
queue is how you decouple "accept the upload" from "do the heavy work later." Redis is the
de-facto BullMQ backend. Phase 0: boot + reachable; real queue usage in Phase 1 #3.

### MinIO — S3-compatible object storage
MinIO is an object store that speaks the **Amazon S3 API**. Object storage (not a
filesystem, not a DB) is where large media blobs belong: raw uploaded MP4s and the
transcoded HLS output (`.m3u8` playlists + `.ts`/`.m4s` segments). Because MinIO is
S3-API-compatible, the exact same code (`@aws-sdk/client-s3`) that talks to MinIO locally
will talk to real S3/R2/GCS in prod — we learn the production API without prod costs or
credentials (spec §4). It exposes two ports: the **S3 API** (what our code uses) and a
**web console** (a browser UI to inspect buckets — handy for *seeing* our HLS output).

## 3. Anatomy of the compose file (what to look for)

The file we write uses these building blocks — recognize them:

- **`services:`** — one block per container (`postgres`, `redis`, `minio`).
- **`image:`** — pinned version tag (e.g. `postgres:17-alpine`). *Pin, never `latest`* —
  `latest` silently changes under you and destroys reproducibility.
- **`ports: "5432:5432"`** — `host:container`. Left = the port on your Mac; right = inside
  the container. This is how the host-run backend reaches a containerized service.
- **`environment:`** — boot config (Postgres user/password/db, MinIO root creds).
- **`volumes:`** — a **named volume** (e.g. `pgdata:/var/lib/postgresql/data`) so data
  survives `down`/`up`. Named volumes are managed by Docker (vs. bind mounts to a host
  path); listed under a top-level `volumes:` key.
- **`healthcheck:`** — a command Docker runs on an interval to decide the container is
  *ready*, not merely *running*. `pg_isready` for Postgres, `redis-cli ping` for Redis,
  MinIO's `/minio/health/live` endpoint. Phase 0's success criterion — "health checks
  pass" — is literally these going green.
- **A default network** — Compose creates one automatically; services reach each other by
  service name. We don't need to declare it for a single-file stack.

> **Local dev topology.** We run the *backend on the host* (`npm run dev`, instant reload)
> and only the *stateful services in Docker*. So the backend connects to
> `localhost:5432/6379/9000` (the mapped host ports). Later, when we containerize the
> backend itself (scaling phase), it will instead use the in-network names
> `postgres`/`redis`/`minio`. Knowing *why the hostname differs* between those two setups
> is a real and commonly-confusing lesson — flagged here, revisited then.

## 4. Security & secrets posture (local)

The compose file contains **development-only** credentials in plaintext (e.g.
`POSTGRES_PASSWORD=streamforge`). That is fine *for local dev* and normal practice, but the
habit to build now: real secrets never live in the repo. Our `.env` files are gitignored;
only `.env.example` (no real values) is committed. Production credential management
(secrets manager, rotation) is a Phase 4 hardening topic. We call this out so the plaintext
here is understood as a deliberate local convenience, not a pattern to copy to prod.

## 5. Trade-offs we accept

| We accept | Because |
|-----------|---------|
| Docker Desktop dependency for local dev | Parity with prod far outweighs the install; industry norm. |
| Backend on host, services in Docker (hybrid) | Fastest reload loop while keeping stateful deps prod-like. Fully-containerized backend comes with the scaling lesson. |
| Plaintext dev creds in the compose file | Standard for local; real secret management is an explicit later topic. |
| Compose, not k8s, locally | Right tool for the dev inner loop; k8s is the prod-orchestration lesson later. |

## 6. Glossary

- **Image** — read-only template (filesystem + start command) a container runs from.
- **Container** — a running, isolated instance of an image.
- **Compose** — declarative multi-container runner (`docker-compose.yml`).
- **Port mapping (`host:container`)** — expose a container port on the host.
- **Named volume** — Docker-managed persistent storage that outlives containers.
- **Healthcheck** — periodic command that reports whether a service is *ready*.
- **S3 API** — the de-facto object-storage API; MinIO implements it so our code is portable to real S3.
- **Service name resolution** — inside the Compose network, services reach each other by name.

---

**Next:** write `infra/docker-compose.yml` implementing the above, then
`npm run infra:up` and confirm all three healthchecks go green (the Phase 0 deliverable),
and that the backend's `/health` responds.
