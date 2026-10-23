import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildCorpus, buildEdgeCases } from './fixtures.mjs';
import { buildSummary } from '../src/report.mjs';
import { humanBytes } from '../src/util.mjs';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'batchpress.mjs');

function run(args) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) =>
      resolve({ code, stdout, stderr, elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6 })
    );
  });
}

function lastRunDir(output) {
  const pointer = path.join(output, '.batchpress', 'last-run');
  const id = fs.readFileSync(pointer, 'utf8').trim();
  return path.join(output, '.batchpress', 'runs', id);
}

function dirBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else total += fs.statSync(abs).size;
    }
  }
  return total;
}

function makeMany(dir, sourceFile, count) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = fs.readFileSync(sourceFile);
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(path.join(dir, `copy-${String(i).padStart(4, '0')}.jpg`), buf);
  }
  return count;
}

const CONFIGS = [
  { label: 'small · webp-q80 · c1', corpus: 'small', preset: 'webp-q80', concurrency: 1 },
  { label: 'small · webp-q80 · c4', corpus: 'small', preset: 'webp-q80', concurrency: 4 },
  { label: 'medium · webp-q80 · c1', corpus: 'medium', preset: 'webp-q80', concurrency: 1 },
  { label: 'medium · webp-q80 · c2', corpus: 'medium', preset: 'webp-q80', concurrency: 2 },
  { label: 'medium · webp-q80 · c4', corpus: 'medium', preset: 'webp-q80', concurrency: 4 },
  { label: 'medium · webp-q80 · c8', corpus: 'medium', preset: 'webp-q80', concurrency: 8 },
  { label: 'medium · avatar-256 · c4', corpus: 'medium', preset: 'avatar-256', concurrency: 4 },
  { label: 'medium · avif-q55 · c4', corpus: 'medium', preset: 'avif-q55', concurrency: 4 },
  { label: 'large · webp-q80 · c4', corpus: 'large', preset: 'webp-q80', concurrency: 4 },
  { label: 'many(400) · thumb-128 · c4', corpus: 'many', preset: 'thumb-128', concurrency: 4 }
];

async function main() {
  const root = process.argv[2] ?? path.join(import.meta.dirname, '..', '.bench');
  const work = path.join(root, 'work');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  process.stdout.write(`building corpus in ${root} …\n`);
  const made = await buildCorpus(root, 'all');
  await buildEdgeCases(root);
  const manyDir = path.join(root, 'many');
  // img-000 lands in nested/ (every 5th file does), so use a flat one as the source.
  const manyCount = makeMany(manyDir, path.join(root, 'small', 'img-001.jpg'), 400);
  process.stdout.write(
    `corpus: ${made.files} images + edge cases + ${manyCount} copies (${humanBytes(made.bytes)})\n\n`
  );

  const rows = [];
  for (const cfg of CONFIGS) {
    const out = path.join(work, cfg.label.replace(/[^a-z0-9]+/gi, '-'));
    fs.rmSync(out, { recursive: true, force: true });
    const res = await run([
      'run',
      '--in',
      path.join(root, cfg.corpus),
      '--out',
      out,
      '--preset',
      cfg.preset,
      '--concurrency',
      String(cfg.concurrency),
      '--quiet'
    ]);
    const summary = buildSummary(lastRunDir(out));
    rows.push({
      label: cfg.label,
      code: res.code,
      files: summary.counts.total,
      done: summary.counts.done,
      failed: summary.counts.failed,
      input: summary.bytes.input,
      output: summary.bytes.output,
      ratio: summary.bytes.ratio,
      wallMs: summary.wallMs,
      p50: summary.durations.p50Ms,
      p95: summary.durations.p95Ms,
      tps: summary.throughput,
      rss: summary.peakRssBytes,
      outDisk: dirBytes(out)
    });
    process.stdout.write(
      `${cfg.label.padEnd(30)} ${String(summary.counts.done).padStart(4)} done · ${String(
        summary.wallMs
      ).padStart(6)} ms · ${String(summary.throughput ?? 0).padStart(6)} t/s · ${humanBytes(
        summary.peakRssBytes ?? 0
      ).padStart(9)} RSS\n`
    );
  }

  // Idempotency cost: a second pass over an already-complete output tree.
  const idemOut = path.join(work, 'medium-webp-q80-c4');
  const idem = await run([
    'run',
    '--in',
    path.join(root, 'medium'),
    '--out',
    idemOut,
    '--preset',
    'webp-q80',
    '--concurrency',
    '4',
    '--quiet'
  ]);
  const idemSummary = buildSummary(lastRunDir(idemOut));
  process.stdout.write(
    `\nsecond pass (idempotent): ${idemSummary.counts.done} re-encoded · ${idemSummary.counts.skipped} skipped · ${idemSummary.wallMs} ms\n`
  );

  const md = [
    '| configuration | files | done | failed | in | out | ratio | wall | p50 | p95 | tasks/s | peak RSS |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ];
  for (const r of rows) {
    md.push(
      `| ${r.label} | ${r.files} | ${r.done} | ${r.failed} | ${humanBytes(r.input)} | ${humanBytes(
        r.output
      )} | ${r.ratio ?? '-'} | ${r.wallMs} ms | ${r.p50} ms | ${r.p95} ms | ${r.tps ?? '-'} | ${humanBytes(
        r.rss ?? 0
      )} |`
    );
  }
  md.push('');
  md.push(
    `Second pass over the completed \`medium · webp-q80 · c4\` tree: **${idemSummary.counts.done} re-encoded**, ${idemSummary.counts.skipped} skipped, ${idemSummary.wallMs} ms (vs ${rows.find((r) => r.label === 'medium · webp-q80 · c4').wallMs} ms for the first pass).`
  );

  fs.writeFileSync(path.join(root, 'bench.md'), `${md.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'bench.json'), `${JSON.stringify({ rows, idempotent: idemSummary.counts }, null, 2)}\n`);
  process.stdout.write(`\n${md.join('\n')}\n`);
  process.stdout.write(`\nwrote ${path.join(root, 'bench.md')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
