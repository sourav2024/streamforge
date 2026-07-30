/**
 * FFmpeg HLS transcode — one 720p capped-bitrate rendition, fMP4/CMAF segments.
 *
 * Every flag traces to docs/concepts/08-media-fundamentals.md (§ refs inline) and the
 * Phase 1 #3 spec §5. The load-bearing trio is `-g 60 -keyint_min 60 -sc_threshold 0`:
 * a segment must START on a keyframe (§4), so we force one every 2s at the normalized
 * 30fps and forbid extra scene-cut keyframes that would desync GOP from segment
 * boundaries. `-hls_time 4` then cuts each 4s segment on exactly 2 GOPs. In Phase 1 #4,
 * the SAME trio across every rendition is what makes the ladder IDR-aligned (§4.3).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
const execFileAsync = promisify(execFile);

export const HLS_PLAYLIST = "index.m3u8";

export function buildHlsArgs(inputPath: string, outDir: string): string[] {
  return [
    "-y",
    "-i", inputPath,
    // 720p rung; min(720,ih) = NEVER upscale a smaller source (§7). -2 keeps width even.
    "-vf", "scale=w=-2:h='min(720,ih)'",
    "-r", "30",
    // h264 main/yuv420p: the universally hardware-decodable combination (§3a).
    "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p", "-preset", "veryfast",
    // Capped-CRF: quality target with a hard bitrate ceiling — ABR-rung discipline (§5).
    "-crf", "23", "-maxrate", "3000k", "-bufsize", "6000k",
    // Fixed 2s GOP @30fps; no scene-cut keyframes (§4 — the keyframe hinge).
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

export async function runFfmpegHls(inputPath: string, outDir: string): Promise<void> {
  await execFileAsync("ffmpeg", buildHlsArgs(inputPath, outDir), {
    maxBuffer: 16 * 1024 * 1024,
  });
}
