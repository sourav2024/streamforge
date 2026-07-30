/**
 * Transcode module — PUBLIC surface. Other modules (and the worker composition root) may
 * import ONLY from here (docs/concepts/02-why-modular-monolith.md §3, rule 1).
 */
export { createTranscodeProducer, TRANSCODE_QUEUE } from "./transcode.producer.js";
export type { TranscodeProducer, TranscodeJobData } from "./transcode.producer.js";
export { processTranscodeJob, contentTypeFor } from "./transcode.job.js";
export type { TranscodeJobDeps } from "./transcode.job.js";
export { runFfmpegHls, buildHlsArgs, HLS_PLAYLIST } from "./ffmpeg.js";
