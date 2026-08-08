/**
 * S3-compatible object storage (MinIO now, real S3 later — same code).
 * See docs/concepts/05-object-storage-and-s3.md. `forcePathStyle` is required for MinIO
 * (bucket in the URL path, not a hostname subdomain). Swap the endpoint + drop path-style
 * and this talks to real AWS S3 / Cloudflare R2 unchanged.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { Config } from "./config.js";

export interface ObjectStream {
  body: Readable;
  /** S3 may omit these; undefined means "we don't know", callers fall back. */
  contentType: string | undefined;
  contentLength: number | undefined;
}

export interface Storage {
  ensureBucket(): Promise<void>;
  putObjectFromFile(key: string, filePath: string, contentType: string): Promise<void>;
  getObjectToFile(key: string, destPath: string): Promise<void>;
  /** Open the object as a stream for proxying (doc 11 §3). Missing key → null, not throw. */
  getObjectStream(key: string): Promise<ObjectStream | null>;
  deleteObject(key: string): Promise<void>;
}

/**
 * One Storage instance per bucket: raw originals and derived HLS artifacts have different
 * lifecycles/access policies (spec §2), so the composition root constructs `rawStorage`
 * and `hlsStorage` from this single implementation.
 */
export function createStorage(config: Config, bucket: string): Storage {
  const client = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  });

  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    },
    async putObjectFromFile(key, filePath, contentType) {
      // Stream the file (don't buffer a whole video into memory). A stream has no known
      // length, so set ContentLength explicitly — otherwise the client buffers it just to
      // measure the size, defeating the point. `stat` gives us the size cheaply.
      const { size } = await stat(filePath);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentType: contentType,
          ContentLength: size,
        }),
      );
    },
    async getObjectToFile(key, destPath) {
      // Stream to disk (a video never fits comfortably in memory — same rule as the put).
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) throw new Error(`empty body for s3://${bucket}/${key}`);
      await pipeline(res.Body as Readable, createWriteStream(destPath));
    },
    async getObjectStream(key) {
      // The body is handed to the caller UNCONSUMED — Fastify pipes it to the client, so
      // backpressure runs end-to-end (client ← Node ← MinIO) and memory stays flat.
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!res.Body) return null;
        return {
          body: res.Body as Readable,
          contentType: res.ContentType,
          contentLength: res.ContentLength,
        };
      } catch (err) {
        // Missing object is an expected outcome for a serving path (→ HTTP 404), not an error.
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
