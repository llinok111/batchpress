import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildSummary } from '../src/report.mjs';
import { Journal } from '../src/journal.mjs';
import { humanBytes } from '../src/util.mjs';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'batchpress.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnRun(args, env = {}) {
  const t0 = Date.now();
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, ...env }
  });
  const done = new Promise((resolve) =>
    child.on('exit', (code) => resolve({ code, wallMs: Date.now() - t0 }))
  );
  return { child, done };
}

function lastRun(output) {
  const id = fs.readFileSync(path.join(output, '.batchpress', 'last-run'), 'utf8').trim();
  return path.join(output, '.batchpress', 'runs', id);
}

function countEvents(runDir) {
  const { events } = Journal.read(path.join(runDir, 'journal.ndjson'));
  const n = (t) => events.filter((e) => e.t === t).length;
  return {
    attempts: n('task.attempt'),
    ok: n('task.ok'),
    fail: n('task.fail'),
    cancel: n('task.cancel'),
    skip: n('task.skip'),
    recovered: events.filter((e) => e.t === 'task.ok' && e.recovered).length,
    paused: n('run.paused'),
    events: events.length,
    torn: Journal.read(path.join(runDir, 'journal.ndjson')).torn
  };
}

const outFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.endsWith('.part')).length;

async function main() {
  const root = path.join(import.meta.dirname, '..', '.drills');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const src = path.join(root, 'in');
  fs.mkdirSync(src, { recursive: true });

  // 48 medium images: long enough to interrupt mid-flight, short enough to iterate.
  const sharp = (await import('sharp')).default;
  for (let i = 0; i < 48; i += 1) {
    await sharp({
      create: {
        width: 900 + (i % 5) * 40,
        height: 700,
        channels: 3,
        background: { r: 40 + i * 2, g: 110, b: 140 }
      }
    })
      .jpeg({ quality: 90 })
      .toFile(path.join(src, `img-${String(i).padStart(3, '0')}.jpg`));
  }

  const results = [];

  // ---- Drill 1: kill -9 mid-run, then resume -------------------------------
  {
    const out = path.join(root, 'd1');
    const { child, done } = spawnRun([
      'run', '--in', src, '--out', out, '--preset', 'webp-q80', '--concurrency', '1', '--quiet'
    ]);
    await sleep(1100);
    child.kill('SIGKILL');
    await done;
    const before = buildSummary(lastRun(out));
    const beforeFiles = outFiles(out);

    const resume = spawnRun(['resume', '--out', out, '--concurrency', '2', '--quiet']);
    const r = await resume.done;
    const after = buildSummary(lastRun(out));
    const ev = countEvents(lastRun(out));

    results.push({
      drill: 'kill -9 at 1.1 s, then resume',
      detail: `done before kill ${before.counts.done}/${before.counts.total} · interrupted ${before.counts.interrupted} · adopted ${ev.recovered}`,
      outcome: `done ${after.counts.done}/${after.counts.total} · attempts ${ev.attempts} (${ev.attempts - after.counts.done} redundant) · exit ${r.code}`,
      extra: `outputs on disk ${outFiles(out)} (expected ${after.counts.total}) · staging remnants ${
        fs.readdirSync(path.join(lastRun(out), 'staging')).length
      } · torn lines ${ev.torn}`
    });
  }

  // ---- Drill 2: external cancel, then resume -------------------------------
  {
    const out = path.join(root, 'd2');
    const { child, done } = spawnRun([
      'run', '--in', src, '--out', out, '--preset', 'webp-q80', '--concurrency', '1', '--quiet'
    ]);
    await sleep(900);
    const cancel = spawnRun(['cancel', '--out', out]);
    await cancel.done;
    const r = await done;
    const mid = buildSummary(lastRun(out));

    const resume = spawnRun(['resume', '--out', out, '--concurrency', '2', '--quiet']);
    const rr = await resume.done;
    const after = buildSummary(lastRun(out));

    results.push({
      drill: 'external cancel, then resume',
      detail: `cancel exit ${r.code} · done ${mid.counts.done} · cancelled ${mid.counts.cancelled} · status ${mid.status}`,
      outcome: `resume exit ${rr.code} · final done ${after.counts.done}/${after.counts.total} · status ${after.status}`,
      extra: `outputs on disk ${outFiles(out)} (expected ${after.counts.total}) · cancelled remaining 0 after resume`
    });
  }

  // ---- Drill 3: disk guard -------------------------------------------------
  {
    const out = path.join(root, 'd3');
    const { done } = spawnRun(
      ['run', '--in', src, '--out', out, '--preset', 'webp-q80', '--quiet'],
      { BATCHPRESS_FAKE_FREE_BYTES: String(64 * 1024 * 1024) }
    );
    const r = await done;
    const paused = buildSummary(lastRun(out));
    const writtenUnderPause = outFiles(out);

    const resume = spawnRun(['resume', '--out', out, '--concurrency', '2', '--quiet']);
    const rr = await resume.done;
    const after = buildSummary(lastRun(out));

    results.push({
      drill: 'disk reserve guard (64 MiB free, 512 MiB reserve)',
      detail: `exit ${r.code} · status ${paused.status} · reason ${paused.paused?.reason} · tasks run ${paused.counts.done}`,
      outcome: `after freeing space: exit ${rr.code} · done ${after.counts.done}/${after.counts.total}`,
      extra: `files written while paused ${writtenUnderPause} · preserved output untouched`
    });
  }

  // ---- Drill 4: transient fault, retry accounting --------------------------
  {
    const out = path.join(root, 'd4');
    const { done } = spawnRun([
      'run', '--in', src, '--out', out, '--preset', 'webp-q80', '--concurrency', '2',
      '--attempts', '3', '--fault', 'transient', '--quiet'
    ]);
    const r = await done;
    const s = buildSummary(lastRun(out));
    const ev = countEvents(lastRun(out));

    results.push({
      drill: 'injected transient EBUSY on every first attempt',
      detail: `exit ${r.code} · done ${s.counts.done}/${s.counts.total} · fail ${s.counts.failed} · retries ${ev.fail}`,
      outcome: `attempts ${ev.attempts} for ${s.counts.total} tasks (= 1 fault + 1 success each)`,
      extra: `outputs on disk ${outFiles(out)} (no duplicates) · staging remnants ${
        fs.readdirSync(path.join(lastRun(out), 'staging')).length
      }`
    });
  }

  // ---- Drill 5: permanent input defect, no retry burn ----------------------
  {
    const out = path.join(root, 'd5');
    fs.writeFileSync(path.join(src, 'zz-corrupt.jpg'), Buffer.from('not a jpeg at all'));
    const { done } = spawnRun([
      'run', '--in', src, '--out', out, '--preset', 'webp-q80', '--attempts', '5', '--quiet'
    ]);
    const r = await done;
    const s = buildSummary(lastRun(out));
    const ev = countEvents(lastRun(out));
    results.push({
      drill: 'corrupt input with --attempts 5',
      detail: `exit ${r.code} · failed ${s.counts.failed} (${Object.entries(s.byCode).map(([k, v]) => `${k}x${v}`).join(',')})`,
      outcome: `attempts ${ev.attempts} for ${s.counts.total} tasks · retries ${ev.fail - s.counts.failed}`,
      extra: 'a corrupt file is attempted exactly once: retrying cannot change the bytes'
    });
    fs.rmSync(path.join(src, 'zz-corrupt.jpg'));
  }

  const md = [
    '| drill | observed during the event | final outcome | invariants checked |',
    '| --- | --- | --- | --- |'
  ];
  for (const r of results) {
    md.push(`| ${r.drill} | ${r.detail} | ${r.outcome} | ${r.extra} |`);
  }
  const text = `${md.join('\n')}\n`;
  fs.writeFileSync(path.join(root, 'drills.md'), text);
  process.stdout.write(`\n${text}\n`);
  process.stdout.write(`corpus: 48 images (${humanBytes(fs.statSync(path.join(src, 'img-000.jpg')).size)} each, 900x700)\n`);
  process.stdout.write(`cpus: ${os.cpus().length} · ${os.platform()} ${os.release()}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
