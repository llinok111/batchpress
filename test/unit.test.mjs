import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal, fold } from '../src/journal.mjs';
import { classifyError, backoffMs } from '../src/retry.mjs';
import { estimateOutputBytes, freeBytes, hasRoom, EST_SAFETY } from '../src/disk.mjs';
import { resolvePreset, taskIdOf, presetSignature, PRESETS } from '../src/presets.mjs';
import { percentile, humanBytes, humanMs, writeFileAtomic, sha256File } from '../src/util.mjs';
import { buildSummary, toMarkdown, failuresCsv } from '../src/report.mjs';
import { walkInputs } from '../src/plan.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `bp-${name}-`));

test('journal: append/read roundtrip preserves order and seq', () => {
  const dir = tmp('journal');
  const file = path.join(dir, 'j.ndjson');
  const j = Journal.open(file);
  j.append({ t: 'run.start', runId: 'r1', total: 2 });
  j.append({ t: 'task.queued', taskId: 'a', rel: 'a.jpg', outRel: 'a.webp', bytes: 10 });
  j.close();

  const { events, torn } = Journal.read(file);
  assert.equal(events.length, 2);
  assert.equal(torn, 0);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  assert.equal(events[0].runId, 'r1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('journal: a torn final line is tolerated and counted, not fatal', () => {
  const dir = tmp('torn');
  const file = path.join(dir, 'j.ndjson');
  const j = Journal.open(file);
  j.append({ t: 'run.start', runId: 'r1', total: 1 });
  j.close();
  fs.appendFileSync(file, '{"v":1,"seq":2,"t":"task.ok","taskId":"x"'); // killed mid-write

  const { events, torn } = Journal.read(file);
  assert.equal(events.length, 1);
  assert.equal(torn, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('journal: seq continues after reopen instead of restarting at 1', () => {
  const dir = tmp('reopen');
  const file = path.join(dir, 'j.ndjson');
  const a = Journal.open(file);
  a.append({ t: 'run.start', runId: 'r1' });
  a.append({ t: 'run.end', status: 'completed' });
  a.close();

  const b = Journal.open(file);
  b.append({ t: 'run.resume', runId: 'r1' });
  b.close();

  const { events } = Journal.read(file);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fold: inflight at end of log is surfaced as interrupted', () => {
  const events = [
    { t: 'run.start', runId: 'r1', total: 2 },
    { t: 'task.queued', taskId: 'a', rel: 'a.jpg', outRel: 'a.webp' },
    { t: 'task.attempt', taskId: 'a', attempt: 1 },
    { t: 'task.ok', taskId: 'a', attempt: 1, output: { bytes: 5, sha256: 'x' }, ms: 10 },
    { t: 'task.queued', taskId: 'b', rel: 'b.jpg', outRel: 'b.webp' },
    { t: 'task.attempt', taskId: 'b', attempt: 1 }
  ];
  const { counts, tasks } = fold(events);
  assert.equal(counts.done, 1);
  assert.equal(counts.interrupted, 1);
  assert.equal(tasks.get('b').status, 'interrupted');
});

test('fold: retryable failure is retry-pending, final failure is failed', () => {
  const base = [{ t: 'run.start', runId: 'r1' }, { t: 'task.queued', taskId: 'a', rel: 'a.jpg', outRel: 'a.webp' }];
  const retryPending = fold([
    ...base,
    { t: 'task.fail', taskId: 'a', attempt: 1, code: 'EBUSY', retryable: true, final: false }
  ]);
  assert.equal(retryPending.tasks.get('a').status, 'retry-pending');
  assert.equal(retryPending.counts.retryPending, 1);

  const final = fold([
    ...base,
    { t: 'task.fail', taskId: 'a', attempt: 2, code: 'ECORRUPT', retryable: false, final: true }
  ]);
  assert.equal(final.tasks.get('a').status, 'failed');
  assert.equal(final.counts.failed, 1);
});

test('fold: last write wins for a task that failed then succeeded', () => {
  const events = [
    { t: 'run.start', runId: 'r1' },
    { t: 'task.queued', taskId: 'a', rel: 'a.jpg', outRel: 'a.webp' },
    { t: 'task.attempt', taskId: 'a', attempt: 1 },
    { t: 'task.fail', taskId: 'a', attempt: 1, code: 'EBUSY', retryable: true, final: false },
    { t: 'task.attempt', taskId: 'a', attempt: 2 },
    { t: 'task.ok', taskId: 'a', attempt: 2, output: { bytes: 7, sha256: 's' }, ms: 12 }
  ];
  const { tasks, counts } = fold(events);
  assert.equal(tasks.get('a').status, 'done');
  assert.equal(tasks.get('a').attempt, 2);
  assert.equal(counts.done, 1);
  assert.equal(counts.failed, 0);
});

test('classifyError: libvips bare "Unknown error" on a truncated JPEG is ECORRUPT', () => {
  // Regression: libvips reports the same truncated input as either
  // "VipsJpeg: premature end of JPEG image" or a bare "Unknown error"
  // (~3 of 200 runs measured). Classifying the second as EUNKNOWN made the
  // reported code for a byte-identical file non-deterministic.
  for (const message of ['Unknown error', 'unknown error', 'Unknown error ']) {
    const r = classifyError({ message });
    assert.equal(r.code, 'ECORRUPT', message);
    assert.equal(r.retryable, false, message);
  }
});

test('classifyError: input defects are never retryable', () => {
  const cases = [
    ['Input Buffer is empty', 'EEMPTY', false],
    ['Input buffer contains unsupported image format', 'EFORMAT', false],
    ['VipsJpeg: premature end of JPEG image', 'ECORRUPT', false],
    ['VipsForeignLoad: file is truncated', 'ECORRUPT', false]
  ];
  for (const [message, code, retryable] of cases) {
    const r = classifyError({ message });
    assert.equal(r.code, code, message);
    assert.equal(r.retryable, retryable, message);
  }
});

test('classifyError: transient conditions are retryable', () => {
  assert.equal(classifyError({ code: 'EBUSY', message: 'busy' }).retryable, true);
  assert.equal(classifyError({ code: 'EWORKER_CRASH', message: 'worker died' }).retryable, true);
  assert.equal(classifyError({ code: 'ETIMEDOUT', message: 'timeout' }).retryable, true);
  assert.equal(classifyError({ message: 'task exceeded 100ms' }).code, 'ETIMEDOUT');
});

test('classifyError: ENOSPC is not retryable (retrying cannot free a disk)', () => {
  const r = classifyError({ code: 'ENOSPC', message: 'no space left on device' });
  assert.equal(r.code, 'ENOSPC');
  assert.equal(r.retryable, false);
});

test('classifyError: unknown errors are not retried unless explicitly allowed', () => {
  assert.equal(classifyError({ message: 'something weird' }).retryable, false);
  assert.equal(classifyError({ message: 'something weird' }, { retryUnknown: true }).retryable, true);
});

test('backoffMs: grows, caps at 3s, and stays jittered', () => {
  const fixed = () => 0.5;
  assert.ok(backoffMs(1, fixed) < backoffMs(2, fixed));
  assert.ok(backoffMs(5, fixed) <= 3000);
  assert.ok(backoffMs(20, fixed) <= 3000);
  const lo = backoffMs(3, () => 0);
  const hi = backoffMs(3, () => 1);
  assert.ok(lo < hi, 'jitter must actually vary the delay');
});

test('presets: unknown preset fails loudly', () => {
  assert.throws(() => resolvePreset('nope'), /unknown preset/);
});

test('taskIdOf: stable across calls, sensitive to path and to transform', () => {
  const p = resolvePreset('webp-q80');
  const a = taskIdOf('a/b.jpg', p);
  assert.equal(a, taskIdOf('a/b.jpg', p));
  assert.notEqual(a, taskIdOf('a/c.jpg', p));
  assert.notEqual(a, taskIdOf('a/b.jpg', resolvePreset('jpeg-q82')));
  assert.equal(a.length, 16);
});

test('taskIdOf: windows and posix separators collapse to the same id', () => {
  const p = resolvePreset('webp-q80');
  assert.equal(taskIdOf('a\\b.jpg', p), taskIdOf('a/b.jpg', p));
});

test('presetSignature: key order in options does not change the signature', () => {
  const p = resolvePreset('webp-q80');
  const shuffled = { ...p, options: Object.fromEntries(Object.entries(p.options).reverse()) };
  assert.equal(presetSignature(p), presetSignature(shuffled));
});

test('every preset declares the fields the estimator and worker need', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.ok(p.format, `${name} format`);
    assert.ok(p.ext, `${name} ext`);
    assert.ok(p.bpp > 0, `${name} bpp`);
    assert.ok(p.options, `${name} options`);
  }
});

test('estimateOutputBytes: resize presets are bounded by target pixels', () => {
  const preset = resolvePreset('thumb-128');
  const tiny = estimateOutputBytes({ bytes: 50 * 1024 * 1024, pixels: 100e6 }, preset);
  const big = estimateOutputBytes({ bytes: 1024, pixels: 1e6 }, preset);
  assert.equal(tiny, big, 'a resize preset must not scale with source size');
  assert.equal(tiny, Math.round(128 * 128 * preset.bpp * EST_SAFETY));
});

test('estimateOutputBytes: falls back to input size when pixels are unknown', () => {
  const preset = resolvePreset('webp-q80');
  const est = estimateOutputBytes({ bytes: 100_000, pixels: null }, preset);
  assert.equal(est, Math.round(100_000 * EST_SAFETY));
});

test('estimateOutputBytes: a small file still gets a 2 KiB floor', () => {
  const preset = resolvePreset('webp-q80');
  assert.equal(estimateOutputBytes({ bytes: 1000, pixels: null }, preset), 2048);
});

test('estimateOutputBytes: never returns zero, so the guard cannot be bypassed', () => {
  const est = estimateOutputBytes({ bytes: 0, pixels: 0 }, resolvePreset('webp-q80'));
  assert.ok(est >= 2048);
});

test('disk: fake free bytes override lets the guard be tested deterministically', () => {
  const prev = process.env.BATCHPRESS_FAKE_FREE_BYTES;
  process.env.BATCHPRESS_FAKE_FREE_BYTES = '1048576';
  assert.equal(freeBytes(os.tmpdir()), 1048576);

  const task = { bytes: 4 * 1024 * 1024, pixels: null };
  const r = hasRoom(os.tmpdir(), task, resolvePreset('webp-q80'), 0);
  assert.equal(r.ok, false);
  assert.equal(r.unknown, false);

  if (prev === undefined) delete process.env.BATCHPRESS_FAKE_FREE_BYTES;
  else process.env.BATCHPRESS_FAKE_FREE_BYTES = prev;
});

test('disk: real statfs reports a plausible free-space figure', () => {
  const free = freeBytes(os.tmpdir());
  assert.equal(typeof free, 'number');
  assert.ok(free > 1024 * 1024, `expected >1MiB free, got ${free}`);
});

test('disk: unknown free space fails open rather than blocking every task', () => {
  const prev = process.env.BATCHPRESS_FAKE_FREE_BYTES;
  process.env.BATCHPRESS_FAKE_FREE_BYTES = '';
  const r = hasRoom('/definitely/not/a/real/path/xyz', { bytes: 1, pixels: null }, resolvePreset('webp-q80'), 0);
  if (prev === undefined) delete process.env.BATCHPRESS_FAKE_FREE_BYTES;
  else process.env.BATCHPRESS_FAKE_FREE_BYTES = prev;
  assert.equal(r.unknown, true);
  assert.equal(r.ok, true);
});

test('util: percentile matches nearest-rank for the tested sizes', () => {
  const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(v, 50), 50);
  assert.equal(percentile(v, 95), 100);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([7], 95), 7);
});

test('util: humanBytes/humanMs are stable at unit boundaries', () => {
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(1024), '1.0 KB');
  assert.equal(humanBytes(1024 * 1024), '1.0 MB');
  assert.equal(humanMs(500), '500ms');
  assert.equal(humanMs(1500), '1.5s');
  assert.equal(humanMs(90000), '1m30s');
});

test('util: sha256File matches a known digest and is streaming-safe', async () => {
  const dir = tmp('sha');
  const f = path.join(dir, 'x.bin');
  fs.writeFileSync(f, Buffer.alloc(3 * 1024 * 1024, 7));
  const digest = await sha256File(f);
  assert.equal(digest.length, 64);
  assert.equal(digest, await sha256File(f));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('util: writeFileAtomic leaves no temp file behind', () => {
  const dir = tmp('atomic');
  const f = path.join(dir, 'r.json');
  writeFileAtomic(f, '{"a":1}');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}');
  assert.deepEqual(fs.readdirSync(dir), ['r.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('walkInputs: excludes the output dir and non-image extensions', () => {
  const root = tmp('walk');
  const input = path.join(root, 'in');
  const output = path.join(root, 'out');
  fs.mkdirSync(path.join(input, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(input, '.batchpress'), { recursive: true });
  fs.writeFileSync(path.join(input, 'a.jpg'), 'x');
  fs.writeFileSync(path.join(input, 'sub', 'b.png'), 'x');
  fs.writeFileSync(path.join(input, 'sub', 'c.txt'), 'x');
  fs.writeFileSync(path.join(input, '.batchpress', 'state.json'), 'x');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'd.jpg'), 'x');

  const found = walkInputs(input, output).map((f) => path.relative(input, f).split(path.sep).join('/'));
  assert.deepEqual(found.sort(), ['a.jpg', 'sub/b.png']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('report: markdown and csv are derived from the journal, not from counters', () => {
  const dir = tmp('report');
  const file = path.join(dir, 'journal.ndjson');
  const j = Journal.open(file);
  j.append({ t: 'run.start', runId: 'r9', total: 2, spec: { presetName: 'webp-q80', concurrency: 2, attempts: 2 }, startedAt: '2026-01-01T00:00:00.000Z' });
  j.append({ t: 'task.queued', taskId: 'a', rel: 'a.jpg', outRel: 'a.webp', bytes: 1000 });
  j.append({ t: 'task.ok', taskId: 'a', attempt: 1, output: { bytes: 250, sha256: 's' }, ms: 40 });
  j.append({ t: 'task.queued', taskId: 'b', rel: 'bad.jpg', outRel: 'bad.webp', bytes: 500 });
  j.append({ t: 'task.fail', taskId: 'b', attempt: 2, code: 'ECORRUPT', message: 'truncated', retryable: false, final: true });
  j.append({ t: 'run.end', status: 'completed-with-failures', exitCode: 2, endedAt: '2026-01-01T00:00:02.000Z' });
  j.close();

  const s = buildSummary(dir);
  assert.equal(s.counts.total, 2);
  assert.equal(s.counts.done, 1);
  assert.equal(s.counts.failed, 1);
  assert.equal(s.bytes.input, 1000);
  assert.equal(s.bytes.output, 250);
  assert.equal(s.bytes.ratio, 0.25);
  assert.equal(s.failures.length, 1);
  assert.equal(s.byCode.ECORRUPT, 1);
  assert.equal(s.wallMs, 2000);

  const md = toMarkdown(s);
  assert.match(md, /bad\.jpg/);
  assert.match(md, /ECORRUPT/);
  const csv = failuresCsv(s);
  assert.match(csv, /^taskId,path,status,code,attempts,message/m);
  assert.match(csv, /ECORRUPT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('report: csv escapes commas and quotes in paths', () => {
  const dir = tmp('csv');
  const file = path.join(dir, 'journal.ndjson');
  const j = Journal.open(file);
  j.append({ t: 'run.start', runId: 'r1', total: 1 });
  j.append({ t: 'task.queued', taskId: 'a', rel: 'we,ird "name".jpg', outRel: 'x.webp' });
  j.append({ t: 'task.fail', taskId: 'a', attempt: 1, code: 'EUNKNOWN', message: 'has, comma', final: true });
  j.close();
  const csv = failuresCsv(buildSummary(dir));
  assert.match(csv, /"we,ird ""name"".jpg"/);
  assert.match(csv, /"has, comma"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
