/**
 * Media metadata via ffprobe subprocess. See docs/concepts/07-media-metadata-ffprobe.md.
 * Probe failure is NON-FATAL by contract (spec §6): return all-nulls, never throw — a bad
 * or unreadable file still yields a valid (nullable) video row instead of failing the upload.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  /** Audio codec if an audio stream exists (e.g. "aac"). Null for silent video. */
  audioCodec: string | null;
}

const NULLS: ProbeResult = {
  durationSeconds: null, width: null, height: null, videoCodec: null, audioCodec: null,
};

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export async function probeVideo(filePath: string): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);
    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const video = parsed.streams?.find((s) => s.codec_type === "video");
    if (!video) return NULLS; // audio-only files are out of contract: all-nulls
    const audio = parsed.streams?.find((s) => s.codec_type === "audio");
    const durationRaw = parsed.format?.duration;
    const duration = durationRaw !== undefined ? Number.parseFloat(durationRaw) : NaN;
    return {
      durationSeconds: Number.isFinite(duration) ? duration : null,
      width: video.width ?? null,
      height: video.height ?? null,
      videoCodec: video.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
    };
  } catch {
    return NULLS;
  }
}
