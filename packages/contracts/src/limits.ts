/** Product limits. GB/MB here are decimal; MiB/KiB are binary. */
export const MEDIA_LIMITS = Object.freeze({
  totalBytes: 10_000_000_000,
  videoBytes: 512_000_000,
  imageBytes: 20 * 1024 * 1024,
  audioBytes: 50 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  imagePixels: 36_000_000,
});
export const CONTENT_LIMITS = Object.freeze({
  jsonBytes: 256 * 1024,
  blocks: 200,
  titleCharacters: 120,
  summaryCharacters: 300,
  tags: 20,
  nicknameCharacters: 30,
  commentCharacters: 500,
});
export const SCHEMA_VERSION = 1 as const;
export const HERO_TITLE = 'Hello! I am 虚宁' as const;
export const FITNESS_TIMEZONE = 'Asia/Shanghai' as const;
