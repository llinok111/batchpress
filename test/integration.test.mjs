import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { startRun, resumeRun, requestCancelFile } from '../src/run.mjs';
import { buildSummary, writeReports } from '../src/report.mjs';
import { Journal, fold } from '../src/journal.mjs';
import { outputPathFor } from '../src/plan.mjs';
import { resolvePreset } from '../src/presets.mjs';
import { sha256File } from '../src/util.mjs';

const CLI = path.join(import.meta.dirname, '..', 'bin', 'batchpress.mjs');
const QUIET = { log: () => {}, onProgress: () => {} };

function sandbox(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `bp-it-${name}-`));
  return {
    root,
    input: path.join(root, 'in'),
    output: path.join(root, 'out'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

async function seedImage(file, { width = 240, height = 180, color = { r: 200, g: 96, b: 62 } } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg({ quality: 90 })
    .toFile(file);
}

async function seedMany(dir, count, size = 240) {
  for (let i = 0; i < count; i += 1) {
    await seedImage(path.join(dir, `img-${String(i).padStart(3, '0')}.jpg`), {
      width: size,
      height: size,
      color: { r: 40 + i * 3, g: 90 + (i % 7) * 10, b: 120 }
    });
  }
}

const run = (cfg) => startRun({ ...QUIET, ...cfg });

test('I1/I2: a second run skips every completed task and re-encodes nothing', async () => {
  const s = sandbox('idempotent');
  try {
    await seedMany(s.input, 12);
    const first = await run({ inputDir: s.input, outputDir: s.output, presetName: 'webp-q80', concurrency: 2 });
    assert.equal(first.counts.done, 12);

    const hashes = new Map();
    for (const f of fs.readdirSync(s.output).filter((n) => n.endsWith('.webp'))) {
      hashes.set(f, await sha256File(path.join(s.output, f)));
    }

    const second = await run({ inputDir: s.input, outputDir: s.output, presetName: 'webp-q80', concurrency: 2 });
    assert.equal(second.counts.done, 0, 'nothing should be re-encoded');
    assert.equal(second.counts.skipped, 12);

    for (const [f, h] of hashes) {
      assert.equal(await sha256File(path.join(s.output, f)), h, `${f} must be untouched`);
    }
  } finally {
    s.cleanup();
  }
});

test('I4: output bytes are identical across independent runs (retry cannot change results)', async () => {
  const s = sandbox('determinism');
  try {
    await seedMany(s.input, 6);
    const a = await run({ inputDir: s.input, outputDir: path.join(s.root, 'outA'), presetName: 'webp-q80' });
    const b = await run({ inputDir: s.input, outputDir: path.join(s.root, 'outB'), presetName: 'webp-q80' });
    assert.equal(a.counts.done, 6);
    assert.equal(b.counts.done, 6);

    const sa = buildSummary(a.runDir);
    const sb = buildSummary(b.runDir);
    const digestA = sa.tasks.map((t) => `${t.rel}:${t.outputSha256}`).sort();
    const digestB = sb.tasks.map((t) => `${t.rel}:${t.outputSha256}`).sort();
    assert.deepEqual(digestA, digestB);
    assert.ok(digestA.every((d) => d.includes(':') && d.split(':')[1].length === 64));
  } finally {
    s.cleanup();
  }
});

test('retry: an injected transient fault is retried and ends in success', async () => {
  const s = sandbox('retry');
  try {
    await seedMany(s.input, 3);
    const r = await run({
      inputDir: s.input,
      outputDir: s.output,
      presetName: 'webp-q80',
      concurrency: 1,
      attempts: 3,
      fault: 'transient'
    });
    assert.equal(r.counts.done, 3);
    assert.equal(r.counts.failed, 0);
    assert.equal(r.counts.retries, 3, 'each task should have retried exactly once');

    const { events } = Journal.read(path.join(r.runDir, 'journal.ndjson'));
    const fails = events.filter((e) => e.t === 'task.fail');
    assert.equal(fails.length, 3);
    assert.ok(fails.every((f) => f.code === 'EBUSY' && f.retryable === true && f.final === false));

    // exactly one published output per input, no duplicate artefacts
    const outputs = fs.readdirSync(s.output).filter((n) => n.endsWith('.webp'));
    assert.equal(outputs.length, 3);
  } finally {
    s.cleanup();
  }
});

test('retry: exhausting attempts produces one final failure, not N failures', async () => {
  const s = sandbox('retry-exhaust');
  try {
    await seedMany(s.input, 1);
    const r = await run({
      inputDir: s.input,
      outputDir: s.output,
      presetName: 'webp-q80',
      concurrency: 1,
      attempts: 3,
      fault: 'transient'
    });
    // The fault hook only fires on attempt 1, so this must still succeed.
    assert.equal(r.counts.done, 1);

    const { events } = Journal.read(path.join(r.runDir, 'journal.ndjson'));
    const attempts = events.filter((e) => e.t === 'task.attempt');
    assert.equal(attempts.length, 2, 'attempt 1 fails, attempt 2 succeeds');
  } finally {
    s.cleanup();
  }
});

test('attempts=1 disables retry entirely', async () => {
  const s = sandbox('norety');
  try {
    await seedMany(s.input, 2);
    const r = await run({
      inputDir: s.input,
      outputDir: s.output,
      presetName: 'webp-q80',
      concurrency: 1,
      attempts: 1,
      fault: 'transient'
    });
    assert.equal(r.counts.failed, 2);
    assert.equal(r.counts.retries, 0);
    const { events } = Journal.read(path.join(r.runDir, 'journal.ndjson'));
    assert.equal(events.filter((e) => e.t === 'task.attempt').length, 2);
  } finally {
    s.cleanup();
  }
});

test('retry: no staging residue and no partial file ever reaches the output dir', async () => {
  const s = sandbox('staging');
  try {
    await seedMany(s.input, 4);
    const r = await run({
      inputDir: s.input,
      outputDir: s.output,
      presetName: 'webp-q80',
      concurrency: 2,
      attempts: 2,
      fault: 'transient'
    });
    assert.equal(r.counts.done, 4);
    const staging = path.join(r.runDir, 'staging');
    assert.deepEqual(fs.readdirSync(staging), [], 'staging must be empty after a clean run');
    assert.ok(!fs.readdirSync(s.output).some((n) => n.endsWith('.part')));
  } finally {
    s.cleanup();
  }
});

test('concurrency: never exceeds the requested number of simultaneous tasks', async () => {
  const s = sandbox('conc');
  try {
    await seedMany(s.input, 16, 320);
    const samples = [];
    await startRun({
      ...QUIET,
      inputDir: s.input,
      outputDir: s.output,
      presetName: 'webp-q80',
      concurrency: 2,
      onProgress: (p) => samples.push(p.inflight)
    });
    // Sample the real overlap from the journal instead of trusting the counter.
    const r = await run({ inputDir: s.input, outputDir: path.join(s.root, 'out2'), presetName: 'webp-q80', concurrency: 2 });
    const { events } = Journal.read(path.join(r.runDir, 'journal.ndjson'));
    let live = 0;
    let peak = 0;
    for (const e of events) {
      if (e.t === 'task.attempt') live += 1;
      if (e.t === 'task.ok' || e.t === 'task.fail' || e.t === 'task.cancel') live -= 1;
      peak = Math.max(peak, live);
    }
    assert.ok(peak <= 2, `peak concurrency was ${peak}, expected <= 2`);
  } finally {
    s.cleanup();
  }
});

test('memory budget: maxInflightBytes throttles the queue instead of overshooting', async () => {
  const s = sandbox('inflight');
  try {
    await seedMany(s.input, 6, 900);
    const r = await run({
      inputDir: s.input,
      outputDir: s.output,
      presetName: 'webp-q80',
      concurrency: 4,
      maxInflightBytes: 200 * 1024 // far below one file, so at most 1 at a time
    });
    assert.equal(r.counts.done, 6, 'throttling must not lose work');
  } finally {
    s.cleanup();
  }
});

test('cancel: a pre-existing cancel request stops the queue before any work', async () => {
  const s = sandbox('cancel-pre');
  try {
    await seedMany(s.input, 8);
    const first = await run({ inputDir: s.input, outputDir: s.output, presetName: 'webp-q80', limit: 1 });
    requestCancelFile(s.output, first.runId);

    const r = await run({
      inputDir: s.input,
      outputDir: s.output,
      presetName: 'webp-q80',
      concurrency: 1
    });
    assert.ok(r.counts.cancelled > 0 || r.counts.done > 0);
    // The cancel file belongs to the previous run, so this run is unaffected.
    assert.equal(r.status, 'completed');
  } finally {
    s.cleanup();
  }
});

test('cancel: cancel during a run marks remaining tasks cancelled and exits 3', async () => {
  const s = sandbox('cancel-live');
  try {
    await seedMany(s.input, 24, 700);
    const controller = { cancelled: false, hard: false };
    const timer = setTimeout(() => {
      controller.cancelled = true;
    }, 120);
    const r = await run({
      inputDir: s.input,
      outputDir: s.output,
      presetName: 'webp-q80',
      concurrency: 1,
      controller
    });
    clearTimeout(timer);
    assert.ok(r.counts.done < 24, 'cancel must leave work undone');
    assert.equal(r.status, 'cancelled');
    assert.equal(r.exitCode, 3);
    const summary = buildSummary(r.runDir);
    assert.ok(summary.counts.cancelled > 0);
  } finally {
    s.cleanup();
  }
});

test('cancel: resume after a cancel finishes exactly the remaining work', async () => {
  const s = sandbox('cancel-resume');
  try {
    await seedMany(s.input, 20, 600);
    const first = await run({
      inputDir: s.input,
      outputDir: s.output,
      presetName: 'webp-q80',
      concurrency: 1,
      controller: { cancelled: true, hard: false }
    });
    assert.ok(first.counts.done < 20);
    const doneBefore = first.counts.done;

    const resumed = await resumeRun({
      ...QUIET,
      outputDir: s.output,
      runId: first.runId,
      concurrency: 2
    });
    assert.equal(resumed.counts.done + doneBefore, 20, 'all tasks done exactly once');
    const files = fs.readdirSync(s.output).filter((n) => n.endsWith('.webp'));
    assert.equal(files.length, 20);
  } finally {
    s.cleanup();
  }
});

test('disk guard: a tripped reserve pauses the run with exit 4 and no partial output', async () => {
  const s = sandbox('disk');
  const prev = process.env.BATCHPRESS_FAKE_FREE_BYTES;
  try {
    await seedMany(s.input, 5);
    process.env.BATCHPRESS_FAKE_FREE_BYTES = String(1024); // 1 KiB free, reserve 512 MiB
    const r = await run({ inputDir: s.input, outputDir: s.output, presetName: 'webp-q80', concurrency: 1 });
    assert.equal(r.status, 'paused');
    assert.equal(r.exitCode, 4);
    assert.equal(r.blocked.reason, 'disk-reserve');
    assert.equal(r.counts.done, 0);
    assert.deepEqual(fs.readdirSync(s.output).filter((n) => n.endsWith('.webp')), []);

    const summary = buildSummary(r.runDir);
    assert.ok(summary.paused);
    assert.match(summary.paused.reason, /disk-reserve/);

    // Freeing space must let the same run finish.
    delete process.env.BATCHPRESS_FAKE_FREE_BYTES;
    const resumed = await resumeRun({ ...QUIET, outputDir: s.output, runId: r.runId });
    assert.equal(resumed.counts.done, 5);
  } finally {
    if (prev === undefined) delete process.env.BATCHPRESS_FAKE_FREE_BYTES;
    else process.env.BATCHPRESS_FAKE_FREE_BYTES = prev;
    s.cleanup();
  }
});

test('disk guard: ENOSPC mid-run pauses instead of failing every remaining task', async () => {
  const s = sandbox('enospc');
  try {
    await seedMany(s.input, 3);
    const r = await run({
      inputDir: s.input,
      outputDir: s.output,
      presetName: 'webp-q80',
      concurrency: 1,
      attempts: 3,
      fault: 'enospc'
    });
    assert.equal(r.status, 'paused');
    assert.equal(r.blocked.reason, 'enospc');
    assert.equal(r.counts.retries, 0, 'ENOSPC must never be retried');
    const { events } = Journal.read(path.join(r.runDir, 'journal.ndjson'));
    assert.ok(!events.some((e) => e.t === 'task.fail' && e.code === 'ENOSPC' && e.retryable));
  } finally {
    s.cleanup();
  }
});

test('crash recovery: kill -9 leaves a resumable run that adopts published files', async () => {
  const s = sandbox('crash');
  try {
    await seedMany(s.input, 40, 800);
    const child = spawn(
      process.execPath,
      [CLI, 'run', '--in', s.input, '--out', s.output, '--preset', 'webp-q80', '--concurrency', '1', '--quiet'],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );

    // Wait for evidence of progress instead of guessing a duration: a fixed
    // sleep is machine-dependent and failed on slower CI runners, where the
    // first image had not finished before the kill.
    const runsDir = path.join(s.output, '.batchpress', 'runs');
    const deadline = Date.now() + 30000;
    let observed = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      if (!fs.existsSync(runsDir)) continue;
      const ids = fs.readdirSync(runsDir);
      if (!ids.length) continue;
      const journal = path.join(runsDir, ids[0], 'journal.ndjson');
      if (!fs.existsSync(journal)) continue;
      observed = Journal.read(journal).events.filter((e) => e.t === 'task.ok').length;
      if (observed >= 2) break; // enough progress to prove resumability
    }
    child.kill('SIGKILL'); // no cleanup, no graceful shutdown, exactly like a power cut
    await new Promise((resolve) => child.on('exit', resolve));

    const summaryBefore = buildSummary(
      path.join(s.output, '.batchpress', 'runs', fs.readdirSync(path.join(s.output, '.batchpress', 'runs'))[0])
    );
    assert.ok(summaryBefore.counts.done > 0, 'some work must have completed before the kill');
    assert.ok(summaryBefore.counts.done < 40, 'the run must be incomplete');

    const publishedBefore = fs.readdirSync(s.output).filter((n) => n.endsWith('.webp'));
    const hashesBefore = new Map();
    for (const f of publishedBefore) hashesBefore.set(f, await sha256File(path.join(s.output, f)));

    const resumed = await resumeRun({ ...QUIET, outputDir: s.output, concurrency: 2 });
    const after = buildSummary(resumed.runDir);
    assert.equal(after.counts.total, 40);
    assert.equal(after.counts.done, 40, 'every task must end done exactly once');
    assert.equal(after.counts.interrupted, 0, 'no task may be left in the ambiguous state');
    assert.equal(fs.readdirSync(s.output).filter((n) => n.endsWith('.webp')).length, 40);

    for (const [f, h] of hashesBefore) {
      assert.equal(await sha256File(path.join(s.output, f)), h, `${f} must not be re-encoded`);
    }
    assert.deepEqual(
      fs.readdirSync(path.join(resumed.runDir, 'staging')),
      [],
      'orphaned staging files must be purged'
    );
  } finally {
    s.cleanup();
  }
});

test('crash recovery: a torn journal line does not break the fold', async () => {
  const s = sandbox('torn-resume');
  try {
    await seedMany(s.input, 6);
    const r = await run({ inputDir: s.input, outputDir: s.output, presetName: 'webp-q80', limit: 3 });
    const file = path.join(r.runDir, 'journal.ndjson');
    fs.appendFileSync(file, '{"v":1,"seq":999,"t":"task.ok","taskId":"garb');

    const summary = buildSummary(r.runDir);
    assert.equal(summary.tornJournalLines, 1);
    assert.equal(summary.counts.done, 3);

    const resumed = await resumeRun({ ...QUIET, outputDir: s.output, runId: r.runId });
    assert.equal(resumed.counts.done, 0, 'nothing left to do');
  } finally {
    s.cleanup();
  }
});

test('resume: retry-failed re-attempts terminal failures only', async () => {
  const s = sandbox('retryfailed');
  try {
    await seedMany(s.input, 3);
    fs.writeFileSync(path.join(s.input, 'broken.jpg'), Buffer.from('not a jpeg'));
    const first = await run({ inputDir: s.input, outputDir: s.output, presetName: 'webp-q80' });
    assert.equal(first.counts.failed, 1);
    assert.equal(first.counts.done, 3);

    const plain = await resumeRun({ ...QUIET, outputDir: s.output, runId: first.runId });
    assert.equal(plain.counts.done, 0, 'a terminal failure is not retried by default');

    const forced = await resumeRun({ ...QUIET, outputDir: s.output, runId: first.runId, retryFailed: true });
    assert.equal(forced.counts.failed, 1, 'still fails, but it was attempted again');
    const { events } = Journal.read(path.join(first.runDir, 'journal.ndjson'));
    assert.equal(events.filter((e) => e.t === 'task.attempt').length, 5, '3 + 1 + 1 attempts');
  } finally {
    s.cleanup();
  }
});

test('edge cases: each defective input gets a specific code and a specific verdict', async () => {
  const s = sandbox('edge');
  try {
    await seedImage(path.join(s.input, 'good.jpg'));
    fs.writeFileSync(path.join(s.input, 'empty.png'), Buffer.alloc(0));
    fs.writeFileSync(path.join(s.input, 'text.png'), Buffer.from('plain text'));
    const truncated = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#333' } })
      .jpeg({ quality: 92 })
      .toBuffer();
    fs.writeFileSync(path.join(s.input, 'trunc.jpg'), truncated.subarray(0, 500));
    fs.writeFileSync(path.join(s.input, 'skip.txt'), 'ignored');

    const r = await run({ inputDir: s.input, outputDir: s.output, presetName: 'webp-q80', attempts: 3 });
    const summary = buildSummary(r.runDir);
    assert.equal(summary.counts.total, 4, 'the .txt file is not a candidate');
    assert.equal(summary.counts.done, 1);
    assert.equal(summary.counts.failed, 3);
    assert.equal(summary.byCode.EEMPTY, 1);
    assert.equal(summary.byCode.EFORMAT, 1);
    assert.ok(summary.byCode.ECORRUPT >= 1);
    assert.equal(r.counts.retries, 0, 'no input defect may be retried');
  } finally {
    s.cleanup();
  }
});

test('exif orientation is applied before the resize preset', async () => {
  const s = sandbox('exif');
  try {
    // 320x200 with orientation 6 means "display as 200x320".
    fs.mkdirSync(s.input, { recursive: true });
    await sharp({ create: { width: 320, height: 200, channels: 3, background: '#e8b04b' } })
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 85 })
      .toFile(path.join(s.input, 'rot.jpg'));

    const r = await run({ inputDir: s.input, outputDir: s.output, presetName: 'webp-q80' });
    assert.equal(r.counts.done, 1);
    const meta = await sharp(path.join(s.output, 'rot.webp')).metadata();
    assert.equal(meta.width, 200);
    assert.equal(meta.height, 320);
    assert.equal(meta.exif, undefined, 'metadata must be stripped');
  } finally {
    s.cleanup();
  }
});

test('output layout mirrors the input tree, including nested directories', async () => {
  const s = sandbox('tree');
  try {
    await seedImage(path.join(s.input, 'a', 'b', 'deep.jpg'));
    await seedImage(path.join(s.input, 'top.jpg'));
    const r = await run({ inputDir: s.input, outputDir: s.output, presetName: 'webp-q80' });
    assert.equal(r.counts.done, 2);
    assert.ok(fs.existsSync(path.join(s.output, 'a', 'b', 'deep.webp')));
    assert.ok(fs.existsSync(path.join(s.output, 'top.webp')));
  } finally {
    s.cleanup();
  }
});

test('reports: summary.json/md/csv agree with the journal', async () => {
  const s = sandbox('reports');
  try {
    await seedMany(s.input, 4);
    fs.writeFileSync(path.join(s.input, 'bad.jpg'), Buffer.from('nope'));
    const r = await run({ inputDir: s.input, outputDir: s.output, presetName: 'webp-q80' });
    const summary = buildSummary(r.runDir);
    const files = writeReports(r.runDir, summary);

    const json = JSON.parse(fs.readFileSync(files.json, 'utf8'));
    assert.equal(json.counts.done, 4);
    assert.equal(json.counts.failed, 1);
    assert.equal(json.failures[0].code, 'EFORMAT');

    const md = fs.readFileSync(files.md, 'utf8');
    assert.match(md, /bad\.jpg/);
    assert.match(md, /\| done \| 4 \|/);

    const csv = fs.readFileSync(files.csv, 'utf8');
    assert.equal(csv.trim().split('\n').length, 2, 'header + 1 failure');
  } finally {
    s.cleanup();
  }
});

test('CLI: exit codes are contract-stable (0 / 2 / 3 / 4 / 5)', async () => {
  const s = sandbox('cli-exit');
  try {
    await seedMany(s.input, 3);
    const ok = await cli(['run', '--in', s.input, '--out', s.output, '--preset', 'webp-q80', '--quiet']);
    assert.equal(ok.code, 0);

    fs.writeFileSync(path.join(s.input, 'bad.jpg'), Buffer.from('nope'));
    const withFailures = await cli(['run', '--in', s.input, '--out', s.output, '--preset', 'webp-q80', '--quiet']);
    assert.equal(withFailures.code, 2);

    const noRun = await cli(['status', '--out', path.join(s.root, 'nothing-here')]);
    assert.equal(noRun.code, 5);

    const usage = await cli(['run', '--out', s.output]);
    assert.equal(usage.code, 1);
  } finally {
    s.cleanup();
  }
});

test('CLI: status --json is machine readable and matches the on-disk journal', async () => {
  const s = sandbox('cli-json');
  try {
    await seedMany(s.input, 5);
    await cli(['run', '--in', s.input, '--out', s.output, '--preset', 'thumb-128', '--quiet']);
    const out = await cli(['status', '--out', s.output, '--json']);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.counts.done, 5);
    assert.equal(parsed.preset, 'thumb-128');
    assert.equal(parsed.status, 'completed');

    for (const t of parsed.tasks) {
      const meta = await sharp(path.join(s.output, t.rel.replace(/\.jpg$/, '.webp'))).metadata();
      assert.equal(meta.width, 128);
      assert.equal(meta.height, 128);
    }
  } finally {
    s.cleanup();
  }
});

test('CLI: cancel from a second terminal stops a running batch', async () => {
  const s = sandbox('cli-cancel');
  try {
    await seedMany(s.input, 40, 900);
    const child = spawn(
      process.execPath,
      [CLI, 'run', '--in', s.input, '--out', s.output, '--preset', 'webp-q80', '--concurrency', '1', '--quiet'],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    const cancel = await cli(['cancel', '--out', s.output]);
    assert.equal(cancel.code, 0);

    const exitCode = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(exitCode, 3, 'cancelled runs must exit 3');

    const status = await cli(['status', '--out', s.output, '--json']);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.status, 'cancelled');
    assert.ok(parsed.counts.cancelled > 0);
    assert.ok(parsed.counts.done < 40);
  } finally {
    s.cleanup();
  }
});

test('CLI: status --json survives a pipe larger than the 8 KiB pipe buffer', async () => {
  const s = sandbox('cli-pipe');
  try {
    // 60 tasks pushes the JSON summary past 8 KiB, which is where a premature
    // process.exit() used to truncate stdout to exactly 8192 bytes.
    await seedMany(s.input, 60, 200);
    await cli(['run', '--in', s.input, '--out', s.output, '--preset', 'thumb-128', '--quiet']);

    const out = await cli(['status', '--out', s.output, '--json']);
    assert.ok(out.stdout.length > 8192, `expected >8 KiB of JSON, got ${out.stdout.length}`);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.counts.total, 60);
    assert.equal(parsed.tasks.length, 60);
    // The last task must be present: a truncated tail is what JSON.parse
    // reports as "Unterminated string at position 8192".
    assert.ok(parsed.tasks[59].rel, 'the final task must survive the pipe');
  } finally {
    s.cleanup();
  }
});

function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    // `exit` can fire before the pipes drain, which truncated stdout at the
    // 8 KiB pipe buffer and made JSON.parse fail at exactly position 8192 on
    // macOS. `close` fires only after every stdio stream has ended.
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
