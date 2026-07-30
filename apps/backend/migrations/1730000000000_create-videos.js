/* eslint-disable camelcase */
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable("videos", {
    id: { type: "uuid", primaryKey: true },
    title: { type: "text", notNull: true },
    storage_key: { type: "text", notNull: true, unique: true },
    size_bytes: { type: "bigint", notNull: true },
    content_type: { type: "text", notNull: true },
    duration_s: { type: "double precision" },
    width: { type: "integer" },
    height: { type: "integer" },
    video_codec: { type: "text" },
    status: { type: "text", notNull: true, default: "uploaded" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
};

export const down = (pgm) => {
  pgm.dropTable("videos");
};
