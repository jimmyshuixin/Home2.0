/** Product limits. GB/MB here are decimal; MiB/KiB are binary. */
export const MEDIA_LIMITS = Object.freeze({
  // Media originals, variants and upload reservations share this budget. Keep
  // 1 GB of the account's 10 GB free allowance for releases and other objects.
  // This is an application budget, not an account-wide billing guarantee.
  totalBytes: 9_000_000_000,
  freeTierBytes: 10_000_000_000,
  infrastructureReserveBytes: 1_000_000_000,
  videoBytes: 512_000_000,
  imageBytes: 100_000_000,
  audioBytes: 50 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
  imagePixels: 150_000_000,
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
