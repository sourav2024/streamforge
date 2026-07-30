# Concept: Background jobs, queues, and BullMQ

> **📖 Concept doc — written before the Transcoding Pipeline (Phase 1 #3) per the Teaching
> Contract.** The pipeline's spec is `docs/specs/2026-07-21-transcoding-pipeline-design.md`;
> the media theory it executes is `docs/concepts/08-media-fundamentals.md`. This doc covers
> the *delivery mechanism*: how work leaves the HTTP request/response cycle and gets done
> reliably in the background.

**Status:** Approved
**Phase:** 1 #3 — Transcoding Pipeline (first use: the `transcode` queue)

---

## 1. The problem: some work cannot live inside a request

Our upload endpoint answers in well under a second: stream bytes, probe, insert a row.
Transcoding is a different animal — FFmpeg re-encodes every frame (doc 08 §2: transcode =
decode → modify → re-encode), which is **CPU-bound and takes seconds to minutes**, roughly
proportional to video length and resolution.

Running that inside `POST /upload/videos` fails on every axis:

- **The client waits.** An HTTP response pinned open for minutes times out at every proxy,
  load balancer, and mobile network between us and the user.
- **The event loop starves.** Node is single-threaded; even though FFmpeg runs as a child
  process, tying request lifecycle to job lifecycle couples API responsiveness to encode load.
- **A crash loses the work.** If the process dies mid-encode, nothing remembers that this
  video still needs transcoding. The request is gone; so is the intent.
- **No backpressure.** Ten simultaneous uploads would mean ten simultaneous FFmpeg runs
  thrashing the same cores.

The fix is as old as computing: **turn the intent into a durable record — a job — and let a
separate consumer work through jobs at its own pace.** The HTTP handler's only transcoding
duty becomes "write down that this needs doing" (milliseconds), and the client polls
`status` to watch progress (`uploaded → transcoding → ready`).

## 2. Anatomy of a job queue

Three roles, deliberately decoupled:

```
 producer                 broker                    worker
(API process)        (Redis, durable)          (worker process)
enqueue(job) ──────▶  [ job ][ job ][ job ] ──────▶ process(job)
   fast                 survives crashes            slow, CPU-bound,
   returns 201          orders + retries            own pace (concurrency)
```

- **Producer** — creates jobs. For us: `upload.service` enqueues `{ videoId }` after the
  catalog row is written.
- **Broker** — stores jobs durably, hands them out, tracks their state. For us: Redis.
- **Worker** — pulls jobs and executes the handler. For us: a second Node process running
  FFmpeg, one job at a time.

The decoupling is the point: producers and workers scale, deploy, crash, and restart
independently. The queue absorbs bursts (10 uploads → 10 queued jobs → the worker chews
through them serially) — that's **backpressure** for free.

## 3. Why Redis as the broker

A broker needs: fast small writes, atomic "give this job to exactly one worker" operations,
and durability good enough for the workload. Redis fits:

- It's an in-memory data-structure server with **atomic operations** (Lua scripting) — the
  primitive you need so two workers can never pop the same job.
- Latency is sub-millisecond, so queue overhead is invisible next to a minutes-long encode.
- **We already run it** (docker-compose, Phase 0) — the master spec picked BullMQ + Redis
  partly for exactly this reason: one broker, no new infrastructure.

Caveat to hold honestly: Redis persistence is configurable (RDB snapshots / AOF), and the
default is *not* "never lose a byte." For transcode jobs that's acceptable — a lost job means
a video stuck at `uploaded`, which is recoverable by re-enqueueing (and is the same class of
gap as our upload saga's crash window, to be swept up in the hardening phase). For jobs that
must never be lost (payments), you'd reach for a broker with stronger durability or an
outbox pattern — see §8.

## 4. BullMQ: the job lifecycle

BullMQ is the de-facto standard Node queue library over Redis. A job moves through states:

```
            (backoff timer)
   ┌─── delayed ◀──────────────┐
   ▼                           │ attempt failed,
waiting ──▶ active ──▶ completed  retries left
   ▲           │
   │           └──▶ failed  (no retries left, or UnrecoverableError)
   │           │
   └── stalled ┘  (worker died mid-job → job re-queued)
```

- **waiting** — in line. **active** — a worker holds it. **completed/failed** — terminal.
- **delayed** — waiting for a backoff timer before retrying.
- **stalled** — the interesting one: a worker must periodically renew a lock on its active
  job; if the process dies mid-encode, the lock expires and BullMQ hands the job to another
  worker (or the same one after restart). *This* is what fixes the "a crash loses the work"
  problem in §1 — the intent survives because it lives in Redis, not in a request.

Key options we use (and why):

- **`jobId`** — normally BullMQ assigns ids; if you set your own, adding a job whose id
  already exists is a **no-op**. We use `jobId = videoId`: enqueueing the same video twice
  yields one job. Cheap, structural dedupe.
- **`attempts` + `backoff`** — retry a failed job N times, waiting between tries
  (exponential: 5s, 10s, 20s…). Retries paper over *transient* faults (MinIO blip, OOM
  killer); backoff stops a hot-failing job from hammering the system.
- **`UnrecoverableError`** — thrown by a handler to say "retrying cannot help" (our case:
  the video row doesn't exist). BullMQ sends the job straight to `failed`.
- **`removeOnComplete`** — completed jobs are deleted (Redis is memory; don't hoard).
  Failed jobs are kept for inspection.

## 5. At-least-once delivery ⇒ handlers must be idempotent

The stalled-job mechanism has a consequence you must design for, not merely know about:
**a job can run more than once.** If the worker finishes the encode but dies before telling
Redis "completed," the job is re-delivered and runs again. BullMQ guarantees *at-least-once*,
not *exactly-once* (exactly-once between separate systems is, in general, impossible — the
same lesson as the upload saga's "no cross-system transaction").

So every step of our handler is written to be safely repeatable — **idempotent**:

| Step | Why re-running is safe |
|---|---|
| `updateStatus('transcoding')` | Setting a row to the value it already has is a no-op. |
| Download original to temp | Fresh temp dir per attempt; overwrites nothing shared. |
| FFmpeg encode | Pure function of input file → output dir. |
| Upload segments to `hls/<id>/…` | S3 PUT **overwrites** the key — same idempotency that made the compensating delete safe in Phase 1 #1. |
| `updateStatus('ready')` | No-op on repeat. |

The rule of thumb: make each step *overwrite* rather than *append*, and key everything by a
stable id (`videoId`), never by "now" or a counter.

## 6. Concurrency — and why ours is 1

A BullMQ `Worker` takes a `concurrency` option: how many jobs it runs simultaneously.
For I/O-bound handlers (send 50 emails) you'd set it high. Ours spawns FFmpeg, which
**already parallelizes across all CPU cores** for a single encode. Two concurrent encodes
don't finish sooner; they context-switch against each other and both finish later.

So: `concurrency: 1` per worker process. Scaling this system later means **more worker
processes** (on more machines), not more concurrency per worker — and because workers just
pull from Redis, adding a second one requires zero code changes. That's the horizontal-scale
story the modular monolith promised (concept doc 02): the worker is already a separately
runnable unit; extraction to its own deployment is a `docker run`, not a rewrite.

## 7. Graceful shutdown

`worker.close()` stops taking new jobs and **waits for the in-flight job to finish** before
resolving. Without it, every deploy would kill a mid-flight encode and burn a retry attempt
(harmless thanks to idempotency, but wasteful — and with retries exhausted it would falsely
mark a video `failed`). Same discipline as the API's SIGTERM handling in `main.ts`, one
layer down the stack.

## 8. Alternatives, and why BullMQ

| Option | What it is | Why not (for us, now) |
|---|---|---|
| In-process (`setImmediate`, a worker thread) | Do it in the API process | Fails §1: crash loses work, no durability, no backpressure, API competes with encode. |
| **pg-boss** | Job queue over Postgres (`SKIP LOCKED`) | Genuinely good; one less moving part if you don't have Redis. We *do* have Redis, master spec locked BullMQ, and its ecosystem/observability for media pipelines is stronger. |
| RabbitMQ / SQS | Dedicated message brokers | Stronger delivery guarantees + fanout, but new infrastructure (or cloud lock-in) and more concepts (exchanges, visibility timeouts) than one queue justifies. |
| Kafka | Distributed event log | For event streaming at scale, not a work queue; radical overkill here. |
| Temporal / durable workflows | Orchestration engine with replay | The heavyweight answer to multi-step sagas; worth knowing it exists (our saga+sweeper layering is the lightweight version of what it automates). |

Decision (master spec §4, reconfirmed): **BullMQ + Redis** — mature, TypeScript-native,
rides infra we already run, and teaches the transferable concepts (lifecycle, retries,
idempotency, at-least-once) that every queue system shares.

Deliberate deferrals: the **transactional outbox** (our enqueue happens after the DB write
but not atomically with it — Redis being down leaves a video stuck at `uploaded`; the
outbox pattern writes the "job to enqueue" into Postgres in the same transaction as the row,
with a relay pumping it to Redis) and the **stuck-job sweeper** — both land in the
hardening phase, both already flagged in the spec §6.

## 9. Glossary

- **Job** — a durable record of work to do (`{ videoId }` + options + state).
- **Queue** — the named, ordered collection of jobs in the broker (`transcode`).
- **Producer / worker** — code that adds jobs / code that processes them.
- **Broker** — the system that stores and dispatches jobs (Redis for us).
- **At-least-once** — delivery guarantee: every job runs ≥1 time; duplicates possible.
- **Idempotent** — safe to run repeatedly with the same result; our handler's hard requirement.
- **Backoff** — growing delay between retry attempts (exponential: 5s, 10s, 20s…).
- **Stalled job** — active job whose worker stopped renewing its lock (crash); re-queued.
- **`jobId` dedupe** — user-supplied id makes duplicate enqueues no-ops.
- **`UnrecoverableError`** — handler's signal that retries are pointless; straight to failed.
- **Concurrency** — simultaneous jobs per worker; 1 for us because FFmpeg is already parallel.
- **Backpressure** — burst absorption: jobs queue up instead of overwhelming the worker.
- **Transactional outbox** — pattern making "DB write + enqueue" atomic via a DB-side outbox
  table and a relay; deferred to hardening.
