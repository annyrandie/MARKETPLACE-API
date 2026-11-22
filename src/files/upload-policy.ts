const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * The allowlist. The EXTENSION of the object key comes from here, by
 * content type — never from the client's filename. Each type also has its
 * own size cap and its file signature (checked at commit: the client's
 * Content-Type is only its word).
 */
export const ALLOWED_TYPES: Record<string, { ext: string; maxBytes: number; magic: (head: Buffer) => boolean }> = {
  'image/jpeg': { ext: 'jpg', maxBytes: 10 * MiB, magic: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  'image/png': {
    ext: 'png',
    maxBytes: 10 * MiB,
    magic: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/webp': {
    ext: 'webp',
    maxBytes: 10 * MiB,
    magic: (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  'application/pdf': { ext: 'pdf', maxBytes: 50 * MiB, magic: (h) => h.subarray(0, 5).toString('latin1') === '%PDF-' },
  // DB dumps (HW #15's backups now have an object-storage destination)
  'application/gzip': { ext: 'gz', maxBytes: 100 * GiB, magic: (h) => h[0] === 0x1f && h[1] === 0x8b },
  'video/mp4': { ext: 'mp4', maxBytes: 100 * GiB, magic: (h) => h.subarray(4, 8).toString('latin1') === 'ftyp' },
};

/** How many bytes commit reads to check the signature (Range GET). */
export const MAGIC_BYTES = 16;

// S3's multipart contract — the numbers everything below is derived from.
export const MIN_PART_SIZE = 5 * MiB; // every part except the last
export const MAX_PARTS = 10_000;

/**
 * Multipart above 2 × the minimum part: below that a file is at most two
 * parts anyway, and re-sending all of it after a dropped connection costs
 * ≤ 10 MiB — cheaper than three extra round trips (create, list,
 * complete). Above it, resuming starts to pay.
 */
export const MULTIPART_THRESHOLD = 2 * MIN_PART_SIZE;

/**
 * Part size is COMPUTED, never a constant: max(5 MiB, size / 10 000),
 * rounded up to a whole MiB. A hardcoded 5 MiB breaks above 5 MiB ×
 * 10 000 ≈ 48.8 GiB; e.g. 100 GiB → 11 MiB parts, 9 310 of them.
 */
export function partSizeFor(size: number): number {
  return Math.max(MIN_PART_SIZE, Math.ceil(size / MAX_PARTS / MiB) * MiB);
}

export type UploadPlan = { mode: 'single' } | { mode: 'multipart'; partSize: number; partsCount: number };

export function planUpload(size: number): UploadPlan {
  if (size <= MULTIPART_THRESHOLD) return { mode: 'single' };
  const partSize = partSizeFor(size);
  return { mode: 'multipart', partSize, partsCount: Math.ceil(size / partSize) };
}

/** Byte range of part n (1-based) — the client cuts the file the same way. */
export function partRange(n: number, partSize: number, size: number): { start: number; end: number } {
  const start = (n - 1) * partSize;
  return { start, end: Math.min(start + partSize, size) - 1 };
}
