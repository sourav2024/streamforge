/**
 * POST /upload/videos — multipart ingest. Validates content-type + size (spec §6),
 * streams the part to a temp file, hands it to the upload service, cleans up the temp file
 * in a finally (regardless of outcome). HTTP/multipart concerns live HERE; the service stays
 * pure and receives only a temp-file path.
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { UploadService } from "./upload.service.js";

const ALLOWED = new Set(["video/mp4"]);

export function uploadRoutes(app: FastifyInstance, service: UploadService): void {
  app.post("/upload/videos", async (req, reply) => {
    const part = await req.file(); // @fastify/multipart: first file part
    if (!part) {
      return reply.code(400).send({ error: "Bad Request", message: "no file provided" });
    }
    if (!ALLOWED.has(part.mimetype)) {
      return reply.code(400).send({ error: "Bad Request", message: `unsupported content-type: ${part.mimetype}` });
    }
    // `fields.title` may be a single part or an array (repeated field); narrow to a single
    // field part with a string value, else fall back to the uploaded filename.
    const titleField = Array.isArray(part.fields.title) ? part.fields.title[0] : part.fields.title;
    const rawTitle =
      titleField && titleField.type === "field" && typeof titleField.value === "string"
        ? titleField.value.trim()
        : "";
    const title = rawTitle !== "" ? rawTitle : part.filename;

    const tempPath = join(tmpdir(), `sf-upload-${randomUUID()}.mp4`);
    try {
      await pipeline(part.file, createWriteStream(tempPath));
      if (part.file.truncated) {
        // @fastify/multipart flags truncation when the size limit is exceeded.
        return reply.code(413).send({ error: "Payload Too Large", message: "file exceeds size limit" });
      }
      const { size } = await stat(tempPath);
      const video = await service.ingest({
        tempPath, title, contentType: part.mimetype, sizeBytes: size,
      });
      return reply.code(201).send(video);
    } finally {
      await rm(tempPath, { force: true });
    }
  });
}
