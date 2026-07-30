/**
 * Catalog data access — the ONLY code permitted to touch the `videos` table
 * (docs/concepts/02-why-modular-monolith.md §3, rule 2). Raw parameterized SQL
 * (docs/concepts/06-postgres-data-access.md).
 */
import type { Pool } from "../../platform/db.js";
import type { Video, CreateVideoInput, VideoStatus } from "@streamforge/contracts";

interface VideoRow {
  id: string;
  title: string;
  storage_key: string;
  size_bytes: string; // bigint comes back as string from pg
  content_type: string;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  status: string;
  created_at: Date;
}

function toVideo(r: VideoRow): Video {
  return {
    id: r.id,
    title: r.title,
    storageKey: r.storage_key,
    sizeBytes: Number(r.size_bytes),
    contentType: r.content_type,
    durationSeconds: r.duration_s,
    width: r.width,
    height: r.height,
    videoCodec: r.video_codec,
    status: r.status as Video["status"],
    createdAt: r.created_at.toISOString(),
  };
}

const COLS =
  "id, title, storage_key, size_bytes, content_type, duration_s, width, height, video_codec, status, created_at";

export interface CatalogRepository {
  insert(input: CreateVideoInput): Promise<Video>;
  list(): Promise<Video[]>;
  getById(id: string): Promise<Video | null>;
  updateStatus(id: string, status: VideoStatus): Promise<Video | null>;
}

export function createCatalogRepository(pool: Pool): CatalogRepository {
  return {
    async insert(input) {
      const { rows } = await pool.query<VideoRow>(
        `insert into videos
           (id, title, storage_key, size_bytes, content_type, duration_s, width, height, video_codec)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning ${COLS}`,
        [
          input.id, input.title, input.storageKey, input.sizeBytes, input.contentType,
          input.durationSeconds, input.width, input.height, input.videoCodec,
        ],
      );
      return toVideo(rows[0]!);
    },
    async list() {
      const { rows } = await pool.query<VideoRow>(
        `select ${COLS} from videos order by created_at desc`,
      );
      return rows.map(toVideo);
    },
    async getById(id) {
      const { rows } = await pool.query<VideoRow>(
        `select ${COLS} from videos where id = $1`,
        [id],
      );
      return rows[0] ? toVideo(rows[0]) : null;
    },
    async updateStatus(id, status) {
      const { rows } = await pool.query<VideoRow>(
        `update videos set status = $2 where id = $1 returning ${COLS}`,
        [id, status],
      );
      return rows[0] ? toVideo(rows[0]) : null;
    },
  };
}
