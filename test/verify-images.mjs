import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { startRun } from '../src/run.mjs';
import { buildSummary } from '../src/report.mjs';
import { outputPathFor } from '../src/plan.mjs';
import { resolvePreset } from '../src/presets.mjs';

/**
 * Independent image verification.
 *
 * Comparing the output against a reference produced by *sharp itself* would be
 * circular. So the expected geometry is computed here with a hand-written
 * bilinear resampler over raw pixels: if the output matches an independent
 * resampling of the same crop window, then the crop window and the orientation
 * are what we intended. A wrong crop, a wrong aspect or a missing EXIF rotation
 * all produce a large, obvious MAE.
 *
 * This replaces eyeballing on a machine where the image viewer is unavailable.
 */

function rawToRgb(raw, channels) {
  // strip alpha; verification is about geometry and luminance/chroma, not alpha
  if (channels === 3) return raw;
  const n = raw.length / channels;
  const out = Buffer.allocUnsafe(n * 3);
  for (let i = 0; i < n; i += 1) {
    out[i * 3] = raw[i * channels];
    out[i * 3 + 1] = raw[i * channels + 1];
    out[i * 3 + 2] = raw[i * channels + 2];
  }
  return out;
}

function bilinear(src, sw, sh, dw, dh) {
  const out = Buffer.allocUnsafe(dw * dh * 3);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = sx - x0;
      for (let c = 0; c < 3; c += 1) {
        const p00 = src[(y0 * sw + x0) * 3 + c];
        const p01 = src[(y0 * sw + x1) * 3 + c];
        const p10 = src[(y1 * sw + x0) * 3 + c];
        const p11 = src[(y1 * sw + x1) * 3 + c];
        const top = p00 + (p01 - p00) * wx;
        const bottom = p10 + (p11 - p10) * wx;
        out[(y * dw + x) * 3 + c] = Math.round(top + (bottom - top) * wy);
      }
    }
  }
  return out;
}

/** Centre-crop to the target aspect, then resample. This is what `fit: cover` means. */
function expectedCover(srcRgb, sw, sh, tw, th) {
  const scale = Math.max(tw / sw, th / sh);
  const cropW = Math.min(sw, Math.round(tw / scale));
  const cropH = Math.min(sh, Math.round(th / scale));
  const left = Math.floor((sw - cropW) / 2);
  const top = Math.floor((sh - cropH) / 2);

  const cropped = Buffer.allocUnsafe(cropW * cropH * 3);
  for (let y = 0; y < cropH; y += 1) {
    srcRgb.copy(cropped, y * cropW * 3, ((top + y) * sw + left) * 3, ((top + y) * sw + left + cropW) * 3);
  }
  return bilinear(cropped, cropW, cropH, tw, th);
}

function compare(a, b) {
  let sumAbs = 0;
  let maxAbs = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    sumAbs += d;
    if (d > maxAbs) maxAbs = d;
  }
  return { mae: sumAbs / n, maxAbs };
}

function stats(rgb) {
  let sum = 0;
  let sumSq = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 1) {
    sum += rgb[i];
    sumSq += rgb[i] * rgb[i];
  }
  const mean = sum / rgb.length;
  const variance = sumSq / rgb.length - mean * mean;
  return { mean, sd: Math.sqrt(Math.max(0, variance)) };
}

async function main() {
  const root = path.join(import.meta.dirname, '..', '.verify');
  fs.rmSync(root, { recursive: true, force: true });
  const input = path.join(root, 'in');
  fs.mkdirSync(input, { recursive: true });

  // Non-square, clearly asymmetric, so a wrong crop or a wrong aspect is loud.
  const seeds = [
    { name: 'seed-a.jpg', w: 300, h: 200 },
    { name: 'seed-b.jpg', w: 173, h: 311 },
    { name: 'seed-c.jpg', w: 512, h: 512 }
  ];
  for (const [i, s] of seeds.entries()) {
    const buf = Buffer.allocUnsafe(s.w * s.h * 3);
    for (let y = 0; y < s.h; y += 1) {
      for (let x = 0; x < s.w; x += 1) {
        const o = (y * s.w + x) * 3;
        // left third warm, right third cool, a hard horizontal band in the middle
        const band = y > s.h * 0.4 && y < s.h * 0.6;
        buf[o] = band ? 240 : x < s.w / 3 ? 200 - (i * 10) : 40;
        buf[o + 1] = band ? 220 : x < s.w / 3 ? 90 : 60 + (i * 20);
        buf[o + 2] = band ? 60 : x < s.w / 3 ? 50 : 190;
      }
    }
    await sharp(buf, { raw: { width: s.w, height: s.h, channels: 3 } })
      .jpeg({ quality: 95 })
      .toFile(path.join(input, s.name));
  }

  // EXIF orientation 6: the stored 240x160 must be displayed as 160x240.
  {
    const w = 240;
    const h = 160;
    const buf = Buffer.allocUnsafe(w * h * 3);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const o = (y * w + x) * 3;
        buf[o] = x < w / 2 ? 210 : 30;
        buf[o + 1] = y < h / 2 ? 180 : 70;
        buf[o + 2] = 90;
      }
    }
    const base = await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 95 })
      .toBuffer();
    fs.writeFileSync(path.join(input, 'seed-exif6.jpg'), base);
  }

  const presets = ['avatar-256', 'thumb-128', 'webp-q80'];
  const rows = [];

  for (const presetName of presets) {
    const preset = resolvePreset(presetName);
    const out = path.join(root, `out-${presetName}`);
    const res = await startRun({
      inputDir: input,
      outputDir: out,
      presetName,
      concurrency: 2,
      log: () => {},
      onProgress: () => {}
    });
    const summary = buildSummary(res.runDir);

    for (const task of summary.tasks) {
      const outFile = outputPathFor(out, { outRel: task.rel.replace(/\.jpg$/, `.${preset.ext}`) });
      const srcFile = path.join(input, task.rel);

      // `rotate()` means the *displayed* orientation is the reference, so ask
      // sharp for the auto-oriented raw pixels as the independent input too.
      const meta = await sharp(outFile).metadata();
      const oriented = await sharp(srcFile).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const outRaw = await sharp(outFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const srcRgb = rawToRgb(oriented.data, oriented.info.channels);
      const outRgb = rawToRgb(outRaw.data, outRaw.info.channels);
      const sw = oriented.info.width;
      const sh = oriented.info.height;

      const tw = preset.resize ? preset.resize.width : sw;
      const th = preset.resize ? preset.resize.height : sh;
      const ref = preset.resize ? expectedCover(srcRgb, sw, sh, tw, th) : srcRgb;
      const diff = compare(ref, outRgb);
      const s = stats(outRgb);

      rows.push({
        preset: presetName,
        file: task.rel,
        src: `${sw}x${sh}`,
        out: `${meta.width}x${meta.height}`,
        expected: `${tw}x${th}`,
        dimsOk: meta.width === tw && meta.height === th,
        mae: +diff.mae.toFixed(2),
        maxAbs: diff.maxAbs,
        sd: +s.sd.toFixed(1),
        pass: diff.mae < 8 && s.sd > 10
      });
    }
  }

  const md = [
    '| preset | file | source | output | expected | dims ok | MAE vs independent resample | max | output sd | verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const r of rows) {
    md.push(
      `| ${r.preset} | ${r.file} | ${r.src} | ${r.out} | ${r.expected} | ${r.dimsOk ? 'yes' : 'NO'} | ${r.mae} | ${r.maxAbs} | ${r.sd} | ${r.pass ? 'pass' : 'FAIL'} |`
    );
  }
  const text = `${md.join('\n')}\n`;
  fs.writeFileSync(path.join(root, 'verify.md'), text);
  process.stdout.write(`\n${text}\n`);
  const failed = rows.filter((r) => !r.pass).length;
  process.stdout.write(
    `${rows.length - failed}/${rows.length} outputs match an independent resampling of the intended crop window (MAE < 8, sd > 10)\n`
  );
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
