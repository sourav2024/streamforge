/**
 * Catalog business logic. Thin today (delegates to the repository), but it is the seam
 * where future rules live (validation, status transitions for transcoding). Other modules
 * call THIS (via index.ts), never the repository or the table directly.
 */
import type { Video, CreateVideoInput, VideoStatus } from "@streamforge/contracts";
import type { CatalogRepository } from "./catalog.repository.js";

export interface CatalogService {
  createVideo(input: CreateVideoInput): Promise<Video>;
  listVideos(): Promise<Video[]>;
  getVideo(id: string): Promise<Video | null>;
  /**
   * The transcode pipeline's seam (uploaded → transcoding → ready | failed). A plain write
   * for now; transition VALIDATION (e.g. rejecting ready → transcoding) is a future rule
   * that would live right here (spec §6).
   */
  updateStatus(id: string, status: VideoStatus): Promise<Video | null>;
}

export function createCatalogService(repo: CatalogRepository): CatalogService {
  return {
    createVideo: (input) => repo.insert(input),
    listVideos: () => repo.list(),
    getVideo: (id) => repo.getById(id),
    updateStatus: (id, status) => repo.updateStatus(id, status),
  };
}
