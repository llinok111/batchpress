import crypto from 'node:crypto';

/**
 * A preset is *pure data* on purpose: the parent process computes task ids and
 * disk estimates from it, the worker thread turns it into a sharp pipeline.
 * Keeping one representation prevents "estimate says X, encoder does Y" drift.
 *
 * bpp = bytes-per-output-pixel coefficient used by the disk estimator.
 * These are deliberately conservative (over-estimate) because an under-estimate
 * means we discover a full disk mid-encode.
 */
export const PRESETS = {
  'webp-q80': {
    label: 'WebP q80',
    format: 'webp',
    ext: 'webp',
    options: { quality: 80, effort: 4 },
    bpp: 0.22
  },
  'jpeg-q82': {
    label: 'JPEG q82 (mozjpeg)',
    format: 'jpeg',
    ext: 'jpg',
    options: { quality: 82, mozjpeg: true },
    bpp: 0.30
  },
  'avif-q55': {
    label: 'AVIF q55',
    format: 'avif',
    ext: 'avif',
    options: { quality: 55, effort: 3 },
    bpp: 0.12
  },
  'png-opt': {
    label: 'PNG optimised',
    format: 'png',
    ext: 'png',
    options: { compressionLevel: 9, palette: true, quality: 90 },
    bpp: 1.20
  },
  'avatar-256': {
    label: 'Avatar 256x256 cover',
    format: 'webp',
    ext: 'webp',
    options: { quality: 82, effort: 4 },
    resize: { width: 256, height: 256, fit: 'cover', position: 'centre' },
    bpp: 0.45
  },
  'thumb-128': {
    label: 'Thumb 128x128 cover',
    format: 'webp',
    ext: 'webp',
    options: { quality: 78, effort: 4 },
    resize: { width: 128, height: 128, fit: 'cover', position: 'centre' },
    bpp: 0.55
  },
  'reencode-jpeg': {
    label: 'JPEG q90 re-encode (metadata stripped)',
    format: 'jpeg',
    ext: 'jpg',
    options: { quality: 90, mozjpeg: true },
    bpp: 0.34
  }
};

export const INPUT_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff', '.gif', '.svg'
]);

export function resolvePreset(name) {
  const preset = PRESETS[name];
  if (!preset) {
    const err = new Error(
      `unknown preset "${name}"; available: ${Object.keys(PRESETS).join(', ')}`
    );
    err.code = 'EPRESET';
    throw err;
  }
  return { name, ...preset };
}

/**
 * Deterministic JSON: keys sorted at every level.
 *
 * This is not cosmetic. taskIdOf() hashes this string, so if key order leaked
 * into the signature, two logically identical presets would produce different
 * task ids -- and a resume would re-encode work that was already done.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Stable, order-independent serialisation of the parts that affect output bytes. */
export function presetSignature(preset) {
  return canonical({
    format: preset.format,
    options: preset.options ?? {},
    resize: preset.resize ?? null
  });
}

/**
 * Content-independent task identity: same relative path + same transform
 * signature => same id across runs and across machines. This is what makes
 * resume and "already done" detection deterministic.
 */
export function taskIdOf(relPath, preset) {
  const h = crypto
    .createHash('sha256')
    .update(relPath.split('\\').join('/'))
    .update('\u0000')
    .update(presetSignature(preset))
    .digest('hex');
  return h.slice(0, 16);
}
