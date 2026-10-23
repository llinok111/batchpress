import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

/**
 * PNG decoder + render verification.
 *
 * The image viewer is unavailable on this machine, so "looks fine" is not
 * available as evidence. This decodes the screenshot itself (zlib inflate plus
 * PNG unfiltering) and reports statistics that fail loudly on the three usual
 * rendering accidents: a blank frame, a white frame, and a half-rendered page.
 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.allocUnsafe(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.allocUnsafe(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: v = (v + paeth(a, b, c)) & 255; break;
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

function analyse(png) {
  const { width, height, channels, data } = png;
  const px = width * height;
  const colors = new Set();
  let lumSum = 0;
  let lumSq = 0;
  const bandLum = [];
  const BANDS = 8;
  for (let b = 0; b < BANDS; b += 1) bandLum.push({ sum: 0, sq: 0, n: 0 });

  for (let y = 0; y < height; y += 1) {
    const band = Math.min(BANDS - 1, Math.floor((y / height) * BANDS));
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * channels;
      const r = data[o];
      const g = channels >= 3 ? data[o + 1] : r;
      const b2 = channels >= 3 ? data[o + 2] : r;
      // coarse quantisation so anti-aliasing does not explode the colour count
      colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b2 >> 3));
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b2;
      lumSum += lum;
      lumSq += lum * lum;
      bandLum[band].sum += lum;
      bandLum[band].sq += lum * lum;
      bandLum[band].n += 1;
    }
  }

  const mean = lumSum / px;
  const sd = Math.sqrt(Math.max(0, lumSq / px - mean * mean));
  const bands = bandLum.map((b) => {
    const m = b.sum / b.n;
    return { mean: +m.toFixed(1), sd: +Math.sqrt(Math.max(0, b.sq / b.n - m * m)).toFixed(1) };
  });

  return {
    width,
    height,
    channels,
    uniqueColors: colors.size,
    meanLum: +mean.toFixed(1),
    sdLum: +sd.toFixed(1),
    bands
  };
}

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: node site/verify-render.mjs <screenshot.png>\n');
  process.exit(1);
}
const png = decodePng(fs.readFileSync(file));
const stats = analyse(png);

const emptyBands = stats.bands.filter((b) => b.sd < 2).length;
const checks = [
  { name: 'not a tiny frame', ok: stats.width >= 1000 && stats.height >= 1500, got: `${stats.width}x${stats.height}` },
  { name: 'not blank (colour variety)', ok: stats.uniqueColors > 400, got: stats.uniqueColors },
  { name: 'not white-on-white', ok: stats.meanLum > 40 && stats.meanLum < 245, got: stats.meanLum },
  { name: 'has visible structure', ok: stats.sdLum > 12, got: stats.sdLum },
  { name: 'no empty horizontal band', ok: emptyBands === 0, got: `${emptyBands} flat band(s)` }
];

const report = [
  `file        ${path.basename(file)} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`,
  `frame       ${stats.width}x${stats.height} · ${stats.channels} channels`,
  `colours     ${stats.uniqueColors} distinct (5-bit quantised)`,
  `luminance   mean ${stats.meanLum} · sd ${stats.sdLum}`,
  `bands       ${stats.bands.map((b) => `${b.mean}/${b.sd}`).join('  ')}`,
  ''
];
for (const c of checks) {
  report.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(30)} ${c.got}`);
}
const failed = checks.filter((c) => !c.ok).length;
report.push('', `${checks.length - failed}/${checks.length} render checks passed`);

process.stdout.write(`${report.join('\n')}\n`);
process.exitCode = failed ? 1 : 0;
