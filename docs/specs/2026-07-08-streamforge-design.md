# StreamForge — Design Spec

> A learning-first, production-grade video (and audio, and eventually live) streaming
> platform. Built incrementally, senior-engineer standard, every concept understood
> before it is implemented.

**Status:** Design approved — pre-implementation
**Created:** 2026-07-08
**Owner:** Sourav (sourav.kashyap@truxo.ai)

---

## 1. Purpose & Goals

StreamForge is a **learning project** whose goal is to understand how real streaming
platforms (Netflix, Amazon Prime, JioHotstar, Spotify) work — end to end — by building
one at a **production-ready, scalable standard**.

The destination is a working platform. The *point*, however, is the journey: to learn
the vast range of concepts, algorithms, tools, patterns, and trade-offs that go into
streaming, at the depth a senior/staff engineer would know them.

### Non-negotiable principles

1. **The Teaching Contract.** For every tool, technology, pattern, or concept we
   introduce — *before* writing any code that uses it — we produce (or update) a concept
   doc covering: what it is, the problem it solves, how we use it here, the alternatives,
   and why we chose this one at production standard. **Understanding precedes
   implementation. Always.**

2. **Incremental vertical slices.** We never big-bang. Each module produces something
   that works end-to-end before the next layer is added. "Production-ready and scalable"
   is the *standard we hold every layer to*, not an excuse to build everything at once.

3. **Nothing is a black box.** We build the real media pipeline (FFmpeg) ourselves first
   to understand the internals, *then* optionally compare against managed services to
   learn the trade-off real teams make.

4. **Continuity across sessions.** This is an interval project. Records are maintained so
   any future session can resume exactly where we left off (see §7).

---

## 2. Scope

### In scope (in order)
- **VOD video streaming** — the core. Upload → transcode → adaptive-bitrate HLS → play.
- **Audio streaming** — HLS audio, background/gapless playback.
- **Production hardening** — CDN, signed-URL security, DRM (Widevine), observability, scaling.
- **Advanced** — live streaming; iOS + FairPlay port.

### Explicitly deferred / out of scope (until their phase)
- Microservices split (start as modular monolith; extract later as a *lesson*).
- iOS / FairPlay (Android / Widevine first, for depth).
- Managed transcoding services (build raw pipeline first; compare later).
- Recommendations, billing, social features — not part of the streaming learning goal.

---

## 3. Architecture (Target System)

We are building toward this. **We will NOT build it all at once** — this is the map.

```
┌─────────────────────────────────────────────────────────────────┐
│                     REACT NATIVE APP (Android first)              │
│  Browse UI → Player Screen (react-native-video / ExoPlayer)       │
│  - Fetches catalog, requests playback, plays HLS manifest         │
│  - Adaptive bitrate, buffering, player state machine              │
└───────────────┬───────────────────────────────────────────────┘
                │ HTTPS (REST/JSON) + HLS (.m3u8 + .ts/.m4s segments)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│              BACKEND — Node.js + TypeScript (modular monolith)    │
│                                                                   │
│  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌───────────────┐  │
│  │ Catalog  │  │  Upload    │  │  Transcode │  │  Playback /   │  │
│  │ Service  │  │  Service   │  │  Worker    │  │  Manifest svc │  │
│  │(metadata)│  │(ingest MP4)│  │ (FFmpeg)   │  │(signed URLs)  │  │
│  └────┬─────┘  └─────┬──────┘  └─────┬──────┘  └──────┬────────┘  │
│       │              │               │                │           │
│       │        ┌─────▼─────┐   ┌─────▼──────┐         │           │
│       │        │ Job Queue │──▶│  FFmpeg    │         │           │
│       │        │(BullMQ/   │   │  pipeline  │         │           │
│       │        │  Redis)   │   │ HLS+ABR    │         │           │
│       │        └───────────┘   └─────┬──────┘         │           │
│       ▼                              ▼                 ▼           │
│  ┌─────────┐                  ┌──────────────────────────┐        │
│  │Postgres │                  │  Object Storage (MinIO)  │        │
│  │metadata │                  │  raw uploads + HLS output│        │
│  └─────────┘                  └──────────────────────────┘        │
└───────────────────────────────────────────────────────────────┘
         (later: CDN in front of storage, DRM license server)
```

**Core data flow:** Upload MP4 → stored raw in MinIO → transcode job queued in Redis →
FFmpeg worker produces HLS with multiple bitrate renditions → output stored in MinIO →
catalog records metadata in Postgres → app browses catalog → requests playback → receives
signed manifest URL → player streams adaptively.

---

## 4. Technology Decisions (with rationale)

Each choice below gets a full concept doc when we reach it. Summary of the *what* and
*why-this-not-that*:

| Area | Choice | Why (short) | Alternatives considered |
|------|--------|-------------|-------------------------|
| Backend language | **Node.js + TypeScript** | JS everywhere (shared types with RN), huge streaming ecosystem, async I/O suits media serving | Go (great for CDN/throughput), Python (slower), Java (heavy) |
| Backend framework | **Express/Fastify, no NestJS** | Build DI/module boundaries by hand to *understand why* frameworks exist | NestJS (hides the lessons), Koa, raw http |
| Architecture | **Modular monolith → extract later** | Clean boundaries without distributed-systems overhead; extraction is itself a senior lesson | Microservices day 1 (premature), single blob (unscalable) |
| Job queue | **BullMQ + Redis** | De-facto Node queue, robust, observable; transcoding must be async/background | RabbitMQ, SQS, Kafka (overkill early) |
| Transcoding | **FFmpeg (self-hosted)** | The real thing; understand codecs/segments/ABR | Mux, Cloudflare Stream, AWS MediaConvert (black boxes, compared later) |
| Metadata DB | **Postgres** | Relational catalog data, mature, JSONB when needed | MySQL, MongoDB (weaker for relational catalog) |
| Object storage | **MinIO (local) → S3-compatible** | Production uses object storage + CDN; MinIO mirrors S3 API locally | Local FS (unrealistic), direct S3 (costs/creds while learning) |
| Streaming protocol | **HLS first** | Universal client support, Apple-origin, ExoPlayer + AVPlayer both speak it | MPEG-DASH (added as comparison), CMAF (convergence, later) |
| Local infra | **Docker Compose** | One command up/down; mirrors prod; teaches compose | Native brew installs (messy), cloud tiers (network complexity) |
| Mobile | **Bare React Native, Android first** | Full native player access for DRM/ABR/buffering depth | Expo (abstracts the layer we want to learn) |
| Player | **react-native-video (ExoPlayer)** | Wraps the same players Netflix/Hotstar use | expo-video (walls at DRM), custom native (too much early) |
| DRM (later) | **Widevine (Android) → FairPlay (iOS)** | Widevine most common in industry | PlayReady (Windows/Xbox) |

---

## 5. Learning Roadmap (Module Sequence)

Every module follows the two-beat rhythm: **📖 Concept doc → 💻 Implementation** →
update PROGRESS.md.

### Phase 0 — Foundations & Infrastructure
- Monorepo structure & tooling; TypeScript config.
- Docker Compose: Postgres + Redis + MinIO.
- "Why modular monolith" architecture doc.
- *Deliverable:* infra boots, health checks pass.

### Phase 1 — VOD Core (the heart)
1. **Storage & Upload** — ingest MP4 → MinIO, metadata → Postgres.
2. **Media Fundamentals doc** — containers vs codecs, H.264, segments, why HLS. (Pure concept.)
3. **Transcoding Pipeline** — BullMQ queue + FFmpeg worker → single-rendition HLS.
4. **Adaptive Bitrate (ABR)** — multi-rendition ladder + master manifest. *Most important concept.*
5. **Playback Service** — serve manifests + segments, signed URLs.

### Phase 2 — The Mobile Client
6. **RN app skeleton** — bare RN, navigation, catalog browse UI.
7. **The Player** — react-native-video/ExoPlayer playing our HLS; player state machine, buffering, ABR on-device.
8. **Player UX** — controls, quality selection, resume, scrubbing.

### Phase 3 — Audio Streaming
9. **Audio pipeline** — HLS audio, differences from video, gapless/background playback.

### Phase 4 — Production Hardening (the "senior" phase)
10. **CDN & caching strategy.**
11. **Auth & signed-URL security.**
12. **DRM** (Widevine).
13. **Observability** (metrics/logging/tracing).
14. **Scaling** (extract-to-microservices, worker autoscaling).

### Phase 5 — Advanced
15. **Live streaming.**
16. **iOS + FairPlay port.**

### Bonus (do later, once the above is done)

- **Expo client (`apps/mobile-expo`).** A *second, separate* client app built as a bonus
  after the core project is complete — NOT in parallel with the bare RN work. It points at
  the same backend and reuses the shared `packages/` API contract. Goal: an informed
  comparison of what the Expo abstraction buys and costs, having already built the native
  layer by hand in the bare app. Streaming concepts (HLS, ABR, player state machine, DRM)
  are platform-agnostic and carry over unchanged; only the client shell differs. The repo
  structure already leaves room for this app so nothing needs rearranging later. (User
  works in Expo day-to-day; this closes the loop.)

---

## 6. Repository Structure (initial intent)

Finalized in the Phase 0 monorepo concept doc. Initial intent:

```
streamforge/
├── docs/
│   ├── PROGRESS.md            # running session log — READ FIRST on resume
│   ├── specs/                 # design specs (this file)
│   └── concepts/              # 📖 concept doc per topic (the learning record)
├── apps/
│   ├── backend/               # Node.js + TS modular monolith (shared by both clients)
│   ├── mobile-bare/           # bare React Native, Android first — built FIRST (Phase 2)
│   └── mobile-expo/           # Expo client — built LATER, same backend (Phase 5)
├── packages/                  # shared types/utils (e.g. API contracts) — used by BOTH apps
├── infra/
│   └── docker-compose.yml     # Postgres + Redis + MinIO
└── README.md
```

---

## 7. Continuity System (cross-session)

Two layers so any future session resumes cleanly:

- **Layer 1 — Persistent memory.** A project memory entry (auto-loaded each session)
  tracking: what we're building, key decisions, and the *current module/step*. Updated at
  the end of each working session.

- **Layer 2 — In-repo learning log (source of truth).**
  - `docs/PROGRESS.md` — running log: "Session N: built X, learned Y, next up Z." Read first on resume.
  - `docs/specs/` — this design doc and any future specs.
  - `docs/concepts/` — the per-topic learning write-ups (why / alternatives / trade-offs).

**Resume protocol:** read PROGRESS.md + memory → know exactly the current module and next action.

---

## 8. Toolchain State (as of 2026-07-08)

Installed: Node v25.3.0, npm 11.7.0, FFmpeg 8.1.2, OpenJDK 17, Android SDK (NDK,
emulator, system images), adb, Xcode 26.1.1, CocoaPods, Homebrew, git.

To install: **Docker Desktop** (user will install), **Watchman** (via brew, part of setup).

---

## 9. Success Criteria

- A working Android RN app that browses a catalog and plays adaptive-bitrate HLS streamed
  from our own backend, with content we uploaded and transcoded ourselves.
- Audio streaming working with background playback.
- A complete `docs/concepts/` library capturing the "why" behind every layer.
- The system hardened with signed URLs, CDN strategy, DRM, and observability — and a
  documented path to horizontal scale.
- Above all: a durable, resumable learning record that takes the reader from beginner to
  senior understanding of streaming.
```
