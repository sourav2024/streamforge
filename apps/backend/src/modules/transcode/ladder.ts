/**
 * The ABR ladder (docs/concepts/10-abr-ladder-and-master-playlist.md §2, spec §3).
 *
 * CRF is constant; the caps differentiate rungs (capped-CRF, doc 08 §5). `level` +
 * `videoCodec` travel together: we pass `-level:v` to the encoder so the RFC 6381 string
 * advertised in the master playlist is exact, not hopeful. GOP flags are deliberately NOT
 * per-rung — they live once in ffmpeg.ts because IDR alignment requires them identical.
 */
export interface Rung {
  /** Directory name under <videoId>/ and the label in logs, e.g. "720p". */
  label: string;
  /** Target height; the scale filter still applies min(height, ih) as belt-and-suspenders. */
  height: number;
  maxrateK: number;
  bufsizeK: number;
  /** h264 level for -level:v, e.g. "3.1". */
  level: string;
  /** RFC 6381 video codec string matching profile+level, e.g. "avc1.4d401f". */
  videoCodec: string;
}

export const LADDER: readonly Rung[] = [
  { label: "1080p", height: 1080, maxrateK: 6000, bufsizeK: 12000, level: "4.0", videoCodec: "avc1.4d4028" },
  { label: "720p",  height: 720,  maxrateK: 3000, bufsizeK: 6000,  level: "3.1", videoCodec: "avc1.4d401f" },
  { label: "480p",  height: 480,  maxrateK: 1400, bufsizeK: 2800,  level: "3.1", videoCodec: "avc1.4d401f" },
  { label: "360p",  height: 360,  maxrateK: 800,  bufsizeK: 1600,  level: "3.0", videoCodec: "avc1.4d401e" },
];

/**
 * Pick the rungs a source can honestly fill: never upscale (doc 10 §2). A source smaller
 * than the whole ladder gets one native-height rung with the smallest rung's caps. An
 * unknown height is a hard error: if ffprobe can't read it, ffmpeg can't transcode it —
 * let the job fail → retry → 'failed'.
 */
export function selectRungs(sourceHeight: number | null): Rung[] {
  if (sourceHeight === null || sourceHeight <= 0) {
    throw new Error("source height unknown — cannot select ABR rungs for an unprobeable video");
  }
  const fitting = LADDER.filter((rung) => rung.height <= sourceHeight);
  if (fitting.length > 0) return fitting;
  const smallest = LADDER[LADDER.length - 1]!;
  return [{ ...smallest, label: `${sourceHeight}p`, height: sourceHeight }];
}
