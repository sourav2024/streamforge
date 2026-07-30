/** Generates a tiny valid H.264/MP4 for tests. Requires ffmpeg on PATH. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export interface FixtureOptions {
  /** WxH, e.g. "1920x1080". Default 320x240. */
  size?: string;
  /** Duration in seconds. Default 1. */
  seconds?: number;
  /** Add an AAC sine-tone audio track. Default false (silent). */
  audio?: boolean;
}

export async function makeSampleMp4(
  destPath: string,
  opts: FixtureOptions = {},
): Promise<void> {
  const { size = "320x240", seconds = 1, audio = false } = opts;
  // Test pattern (optionally + sine tone), h264 — deterministic. Defaults stay tiny
  // (~tens of KB); transcode tests ask for bigger/longer sources (1080p/10s → segments).
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `testsrc=size=${size}:rate=30:duration=${seconds}`,
    ...(audio
      ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-c:a", "aac", "-shortest"]
      : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    destPath,
  ]);
}
