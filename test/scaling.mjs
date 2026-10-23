import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildSummary } from '../src/report.mjs';
import { humanBytes } from '../src/util.mjs';

/**
 * Concurrency scaling, measured properly.
 *
 * A single wall-clock sample on a desktop machine is not evidence: the same
 * workload here has varied by 30% between consecutive runs. So each
 * configuration is repeated and the **median** is reported, together with the
 * spread, and the claim is made from ratios rather than absolute times.
 */
const CLI = path.join(import.meta.dirname, '..', 'bin', 'batchpress.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('exit', (code) => resolve({ code }));
  });
}

const lastRun = (out) => {
  const id = fs.readFileSync(path.join(out, '.batchpress', 'last-run'), 'utf8').trim();
  return path.join(out, '.batchpress', 'runs', id);
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  const root = path.join(import.meta.dirname, '..', '.scaling');
  fs.rmSync(root, { recursive: true, force: true });
  const src = path.join(root, 'in');
  fs.mkdirSync(src, { recursive: true });

  const sharp = (await import('sharp')).default;
  let bytes = 0;
  for (let i = 0; i < 60; i += 1) {
    const w = 480 + ((i * 97) % 920);
    const h = 480 + ((i * 53) % 700);
    const file = path.join(src, `img-${String(i).padStart(3, '0')}.jpg`);
    await sharp({
      create: { width: w, height: h, channels: 3, background: { r: 60 + i * 2, g: 100, b: 130 } }
    })
      .jpeg({ quality: 90 })
      .toFile(file);
    bytes += fs.statSync(file).size;
  }

  const configs = [1, 2, 4, 8, 12];
  const reps = Number(process.argv[2] ?? 3);
  const rows = [];

  for (const c of configs) {
    const walls = [];
    const tps = [];
    const rss = [];
    for (let r = 0; r < reps; r += 1) {
      const out = path.join(root, `c${c}-r${r}`);
      await run(['run', '--in', src, '--out', out, '--preset', 'webp-q80', '--concurrency', String(c), '--quiet']);
      const s = buildSummary(lastRun(out));
      walls.push(s.wallMs);
      tps.push(s.throughput);
      rss.push(s.peakRssBytes);
      fs.rmSync(out, { recursive: true, force: true });
      await sleep(250); // let the page cache and the CPU settle between samples
    }
    rows.push({
      c,
      wall: median(walls),
      wallMin: Math.min(...walls),
      wallMax: Math.max(...walls),
      tps: median(tps),
      rss: median(rss)
    });
    process.stdout.write(
      `c${String(c).padStart(2)}  median ${String(Math.round(median(walls))).padStart(5)} ms  (${Math.round(
        Math.min(...walls)
      )}–${Math.round(Math.max(...walls))})  ·  ${median(tps).toFixed(1)} tasks/s  ·  ${humanBytes(
        median(rss)
      )} RSS\n`
    );
  }

  const base = rows[0];
  const md = [
    '| slots | wall (median of ' + reps + ') | spread | tasks/s | speed-up vs 1 | peak RSS | RSS per slot |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const r of rows) {
    md.push(
      `| ${r.c} | ${Math.round(r.wall)} ms | ${Math.round(r.wallMin)}–${Math.round(r.wallMax)} ms | ${r.tps.toFixed(
        1
      )} | ${(base.wall / r.wall).toFixed(2)}× | ${humanBytes(r.rss)} | ${humanBytes(r.rss / r.c)} |`
    );
  }
  md.push('');
  md.push(
    `Corpus: 60 images, 480–1400 px, ${humanBytes(bytes)}. Each configuration run ${reps}× with a 250 ms pause between samples; the table reports the median, the min–max spread, and peak RSS.`
  );

  fs.writeFileSync(path.join(root, 'scaling.md'), `${md.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'scaling.json'), `${JSON.stringify(rows, null, 2)}\n`);
  process.stdout.write(`\n${md.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
