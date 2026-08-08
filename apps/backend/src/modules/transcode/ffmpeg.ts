/**
 * FFmpeg HLS transcode — one capped-bitrate rendition per call, fMP4/CMAF segments.
 * Phase 1 #4 runs this once per ladder rung (docs/concepts/10 §2); the rung supplies
 * scale target, bitrate caps and h264 level, nothing else.
 *
 * Every flag traces to docs/concepts/08-media-fundamentals.md (§ refs inline) and the
 * Phase 1 #3/#4 specs. The load-bearing trio is `-g 60 -keyint_min 60 -sc_threshold 0`:
 * a segment must START on a keyframe (§4), so we force one every 2s at the normalized
 * 30fps and forbid extra scene-cut keyframes that would desync GOP from segment
 * boundaries. `-hls_time 4` then cuts each 4s segment on exactly 2 GOPs. The trio is
 * deliberately NOT part of `Rung`: identical GOP flags on every rung is what makes the
 * ladder IDR-aligned (§4.3) — parameterizing them would hand callers the alignment gun.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Rung } from "./ladder.js";
const execFileAsync = promisify(execFile);

export const HLS_PLAYLIST = "index.m3u8";

export function buildHlsArgs(inputPath: string, outDir: string, rung: Rung): string[] {
  return [
    "-y",
    "-i", inputPath,
    // min(rung,ih) = NEVER upscale a smaller source (§7). -2 keeps width even.
    "-vf", `scale=w=-2:h='min(${rung.height},ih)'`,
    "-r", "30",
    // h264 main/yuv420p: the universally hardware-decodable combination (§3a). Explicit
    // -level:v so the CODECS string advertised in the master is exact, not hopeful.
    "-c:v", "libx264", "-profile:v", "main", "-level:v", rung.level,
    "-pix_fmt", "yuv420p", "-preset", "veryfast",
    // Capped-CRF: quality target with a hard bitrate ceiling — ABR-rung discipline (§5).
    "-crf", "23", "-maxrate", `${rung.maxrateK}k`, "-bufsize", `${rung.bufsizeK}k`,
    // Fixed 2s GOP @30fps; no scene-cut keyframes (§4 — the keyframe hinge). IDENTICAL
    // on every rung — this is the IDR alignment (§4.3).
    "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    // 4s segments, VOD playlist, CMAF/fMP4 segments + init segment (§6, spec §2).
    "-f", "hls",
    "-hls_time", "4",
    "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", join(outDir, "seg_%05d.m4s"),
    join(outDir, HLS_PLAYLIST),
  ];
}

export async function runFfmpegHls(inputPath: string, outDir: string, rung: Rung): Promise<void> {
  await execFileAsync("ffmpeg", buildHlsArgs(inputPath, outDir, rung), {
    maxBuffer: 16 * 1024 * 1024,
  });
}
