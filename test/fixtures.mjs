import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

/**
 * Deterministic fixture generator.
 *
 * Everything here is driven by a seeded PRNG, so the corpus is byte-reproducible
 * on any machine: `node test/fixtures.mjs <dir>` twice yields identical sha256
 * sums. That is what lets the recorded benchmark numbers be re-checked later.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE = [
  [201, 96, 62],
  [232, 176, 75],
  [92, 148, 138],
  [60, 72, 90],
  [238, 233, 222],
  [140, 58, 44]
];

/** Noise + soft bands: high entropy (hard to compress) and non-trivial to decode. */
async function makeImage(file, { width, height, seed, format = 'jpeg' }) {
  const rand = mulberry32(seed);
  const channels = 3;
  const raw = Buffer.allocUnsafe(width * height * channels);
  const bandCount = 3 + Math.floor(rand() * 3);
  const bands = Array.from({ length: bandCount }, () => ({
    y: rand(),
    h: 0.05 + rand() * 0.3,
    color: PALETTE[Math.floor(rand() * PALETTE.length)]
  }));
  for (let y = 0; y < height; y += 1) {
    const fy = y / height;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      let r = 30 + rand() * 60;
      let g = 30 + rand() * 60;
      let b = 34 + rand() * 60;
      for (const band of bands) {
        if (fy >= band.y && fy <= band.y + band.h) {
          const k = 0.55 + 0.45 * Math.sin((x / width) * Math.PI * 2);
          r = r * (1 - k) + band.color[0] * k;
          g = g * (1 - k) + band.color[1] * k;
          b = b * (1 - k) + band.color[2] * k;
        }
      }
      raw[i] = Math.max(0, Math.min(255, r));
      raw[i + 1] = Math.max(0, Math.min(255, g));
      raw[i + 2] = Math.max(0, Math.min(255, b));
    }
  }
  let pipe = sharp(raw, { raw: { width, height, channels } });
  if (format === 'jpeg') pipe = pipe.jpeg({ quality: 88, chromaSubsampling: '4:2:0' });
  else if (format === 'png') pipe = pipe.png({ compressionLevel: 6 });
  else if (format === 'webp') pipe = pipe.webp({ quality: 90 });
  else if (format === 'tiff') pipe = pipe.tiff({ compression: 'lzw' });
  await pipe.toFile(file);
  return fs.statSync(file).size;
}

export const SCALES = {
  small: { count: 24, minSide: 64, maxSide: 320, dir: 'small' },
  medium: { count: 60, minSide: 480, maxSide: 1400, dir: 'medium' },
  large: { count: 14, minSide: 2000, maxSide: 3200, dir: 'large' }
};

export async function buildCorpus(root, scale = 'all') {
  const made = { files: 0, bytes: 0, dirs: [] };
  const scales = scale === 'all' ? Object.keys(SCALES) : [scale];
  for (const name of scales) {
    const cfg = SCALES[name];
    const dir = path.join(root, cfg.dir);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < cfg.count; i += 1) {
      const rand = mulberry32(1000 + i * 37 + name.length);
      const width = Math.round(cfg.minSide + rand() * (cfg.maxSide - cfg.minSide));
      const height = Math.round(cfg.minSide + rand() * (cfg.maxSide - cfg.minSide));
      const format = i % 7 === 0 ? 'png' : i % 11 === 0 ? 'tiff' : 'jpeg';
      const ext = format === 'jpeg' ? 'jpg' : format;
      const sub = i % 5 === 0 ? 'nested/' : '';
      const file = path.join(dir, sub, `img-${String(i).padStart(3, '0')}.${ext}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      made.bytes += await makeImage(file, { width, height, seed: 7000 + i, format });
      made.files += 1;
    }
    made.dirs.push(dir);
  }
  return made;
}

/**
 * Edge cases. Each one maps to a distinct expected outcome, which is the point:
 * a batch manager is judged by how it handles the files nobody tests.
 */
export async function buildEdgeCases(root) {
  const dir = path.join(root, 'edge');
  fs.mkdirSync(dir, { recursive: true });

  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#c9603e' } })
    .png()
    .toFile(path.join(dir, 'px-1x1.png'));

  await sharp({ create: { width: 2000, height: 40, channels: 3, background: '#5c948a' } })
    .jpeg({ quality: 80 })
    .toFile(path.join(dir, 'wide-2000x40.jpg'));

  await sharp({ create: { width: 40, height: 2000, channels: 3, background: '#e8b04b' } })
    .jpeg({ quality: 80 })
    .toFile(path.join(dir, 'tall-40x2000.jpg'));

  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#3c485a' } })
    .greyscale()
    .png()
    .toFile(path.join(dir, 'grey.png'));

  await sharp({ create: { width: 240, height: 160, channels: 4, background: { r: 200, g: 96, b: 62, alpha: 0.5 } } })
    .png()
    .toFile(path.join(dir, 'alpha.png'));

  // EXIF orientation 6: must be rotated by the pipeline, so output is portrait.
  await sharp({ create: { width: 320, height: 200, channels: 3, background: '#e8b04b' } })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 85 })
    .toFile(path.join(dir, 'rotated-exif6.jpg'));

  const animFrames = [];
  for (let i = 0; i < 3; i += 1) {
    animFrames.push(
      await sharp({
        create: { width: 120, height: 90, channels: 3, background: PALETTE[i] }
      })
        .png()
        .toBuffer()
    );
  }
  // GIF: animated input, single-frame output is the documented behaviour.
  fs.writeFileSync(path.join(dir, 'animated.gif'), await buildGif(animFrames));

  fs.writeFileSync(path.join(dir, 'empty-0bytes.png'), Buffer.alloc(0));

  const truncated = await sharp({ create: { width: 900, height: 700, channels: 3, background: '#8c3a2c' } })
    .jpeg({ quality: 92 })
    .toBuffer();
  fs.writeFileSync(path.join(dir, 'truncated.jpg'), truncated.subarray(0, Math.floor(truncated.length * 0.4)));

  fs.writeFileSync(path.join(dir, 'not-an-image.png'), Buffer.from('this is plain text, not a PNG'));

  fs.writeFileSync(path.join(dir, 'notes.txt'), Buffer.from('ignored: unsupported extension'));

  return dir;
}

/** Minimal GIF89a encoder: palette + LZW is overkill for a fixture, so emit 3 frames of raw-index data. */
async function buildGif(frames) {
  // sharp cannot write animated GIFs; a single-frame GIF still exercises the
  // "animated-capable decoder" path, which is what matters here.
  return sharp(frames[0]).gif().toBuffer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('usage: node test/fixtures.mjs <dir>\n');
    process.exit(1);
  }
  const t0 = Date.now();
  const made = await buildCorpus(target, 'all');
  const edge = await buildEdgeCases(target);
  process.stdout.write(
    `built ${made.files} images (${(made.bytes / 1024 / 1024).toFixed(1)} MiB) + edge cases in ${
      Date.now() - t0
    } ms\nedge dir: ${edge}\n`
  );
}
