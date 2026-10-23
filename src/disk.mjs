import fs from 'node:fs';

/**
 * Free bytes on the volume holding `dir`.
 *
 * Order of preference:
 *  1. BATCHPRESS_FAKE_FREE_BYTES  -> deterministic tests / capacity drills
 *  2. fs.statfsSync               -> real value on Windows (NTFS) and POSIX
 *  3. null                        -> caller must decide a fail-open/fail-closed policy
 */
export function freeBytes(dir) {
  const fake = process.env.BATCHPRESS_FAKE_FREE_BYTES;
  if (fake !== undefined && fake !== '') {
    const n = Number(fake);
    if (Number.isFinite(n)) return n;
  }
  try {
    const s = fs.statfsSync(dir);
    const total = Number(s.bsize) * Number(s.bavail);
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

/** Multiplier applied to every estimate: estimates are not measurements. */
export const EST_SAFETY = 1.35;

/**
 * Conservative estimate of the bytes one task will add to the output volume.
 *
 *  - resize presets: output is bounded by target pixels, so use those
 *  - otherwise: output is bounded by source pixels x bytes-per-pixel
 *  - unknown metadata (corrupt/unsupported): fall back to the input size
 */
export function estimateOutputBytes(task, preset) {
  const SAFETY = EST_SAFETY;
  if (preset.resize) {
    const px = preset.resize.width * preset.resize.height;
    return Math.max(2048, Math.round(px * preset.bpp * SAFETY));
  }
  if (task.pixels && task.pixels > 0) {
    return Math.max(2048, Math.round(task.pixels * preset.bpp * SAFETY));
  }
  return Math.max(2048, Math.round(task.bytes * SAFETY));
}

/**
 * True when writing `task` would eat into the reserve.
 * `reserveBytes` is head-room kept free for journal temps / OS / user.
 */
export function hasRoom(dir, task, preset, reserveBytes) {
  const free = freeBytes(dir);
  if (free === null) return { ok: true, free: null, need: null, unknown: true };
  const need = estimateOutputBytes(task, preset);
  return { ok: free - need >= reserveBytes, free, need, unknown: false };
}
