/**
 * Hand-authored HLS master playlist (docs/concepts/10-abr-ladder-and-master-playlist.md §3,
 * spec §4). Built from MEASURED rung outputs — the caller ffprobes each rung playlist and
 * hands us actual width/height/audio, so RESOLUTION and CODECS state facts, not intentions.
 */
import type { Rung } from "./ladder.js";

/** AAC-LC, the `-c:a aac` default — the only audio we ever mux (spec §2). */
const AAC_CODEC = "mp4a.40.2";

export interface MasterEntry {
  rung: Rung;
  /** Measured (ffprobe'd) dimensions of the encoded rung, not the ladder target. */
  width: number;
  height: number;
  /** null = rung has no audio track (silent source) → CODECS stays video-only. */
  audioCodec: string | null;
}

/**
 * BANDWIDTH must be the PEAK rate a player might see (RFC 8216 §4.3.4.2): the rung's
 * video cap + 128k audio, plus ~10% container/mux overhead.
 */
function peakBandwidth(rung: Rung): number {
  return Math.round((rung.maxrateK + 128) * 1000 * 1.1);
}

export function buildMasterPlaylist(entries: MasterEntry[]): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  // Highest rung first — convention players expect for initial-variant choice.
  const ordered = [...entries].sort((a, b) => b.rung.height - a.rung.height);
  for (const { rung, width, height, audioCodec } of ordered) {
    const codecs = audioCodec === null ? rung.videoCodec : `${rung.videoCodec},${AAC_CODEC}`;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${peakBandwidth(rung)},RESOLUTION=${width}x${height},CODECS="${codecs}"`,
      `${rung.label}/index.m3u8`,
    );
  }
  return lines.join("\n") + "\n";
}
