import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { Journal, fold } from './journal.mjs';
import { hasRoom, estimateOutputBytes, freeBytes } from './disk.mjs';
import { classifyError, backoffMs } from './retry.mjs';
import { ensureDir, sleep, humanBytes } from './util.mjs';
import { outputPathFor } from './plan.mjs';
import { presetSignature } from './presets.mjs';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);

const pad = (n) => String(n).padStart(2, '0');

export function newRunId() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

export function runsRoot(outputDir) {
  return path.join(path.resolve(outputDir), '.batchpress', 'runs');
}

export function resolveRunDir(outputDir, runId) {
  const root = runsRoot(outputDir);
  if (runId) return path.join(root, runId);
  const pointer = path.join(path.resolve(outputDir), '.batchpress', 'last-run');
  if (fs.existsSync(pointer)) {
    const id = fs.readFileSync(pointer, 'utf8').trim();
    if (id && fs.existsSync(path.join(root, id))) return path.join(root, id);
  }
  if (!fs.existsSync(root)) return null;
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return dirs.length ? path.join(root, dirs[dirs.length - 1]) : null;
}

export function setLastRun(outputDir, runId) {
  const dir = path.join(path.resolve(outputDir), '.batchpress');
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'last-run'), runId);
}

/**
 * One persistent worker thread per queue slot.
 *
 * Persistent, not per-task: spawning a thread costs ~30-50 ms and re-loads
 * libvips, which would dominate a batch of small files. Timeout/cancel kill the
 * slot's thread only, and the slot transparently respawns for its next task.
 */
class Slot {
  constructor() {
    this.worker = null;
  }

  spawn() {
    const w = new Worker(WORKER_URL);
    w.on('error', () => {
      /* surfaced per-job; without a listener a stray error would kill the process */
    });
    return w;
  }

  kill() {
    const w = this.worker;
    this.worker = null;
    if (!w) return;
    w.removeAllListeners();
    w.terminate().catch(() => {});
  }

  exec(job, timeoutMs) {
    if (!this.worker) this.worker = this.spawn();
    const w = this.worker;
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onError);
        w.off('exit', onExit);
      };
      const done = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onMessage = (m) => {
        if (m && m.jobId === job.jobId) done(m);
      };
      const onError = (e) => {
        this.kill();
        done({
          jobId: job.jobId,
          ok: false,
          error: { code: 'EWORKER_CRASH', message: String((e && e.message) || e) }
        });
      };
      const onExit = (code) => {
        this.worker = null;
        done({
          jobId: job.jobId,
          ok: false,
          error: { code: 'EWORKER_CRASH', message: `worker exited with code ${code}` }
        });
      };
      timer = setTimeout(() => {
        this.kill();
        done({
          jobId: job.jobId,
          ok: false,
          error: { code: 'ETIMEDOUT', message: `task exceeded ${timeoutMs}ms` }
        });
      }, timeoutMs);
      w.on('message', onMessage);
      w.on('error', onError);
      w.on('exit', onExit);
      w.postMessage(job);
    });
  }
}

function purgeStaging(stagingDir) {
  if (!fs.existsSync(stagingDir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(stagingDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.part')) {
      try {
        fs.rmSync(path.join(stagingDir, entry.name), { force: true });
        n += 1;
      } catch {
        /* locked file: it will be retried/overwritten next attempt */
      }
    }
  }
  return n;
}

/**
 * Executes `tasks` against `preset`.
 *
 * Invariants that make retry safe (each is asserted by the test suite):
 *  I1  destination files only ever appear via rename() of a complete staging file
 *  I2  a task with a terminal `done` event is never executed again
 *  I3  staging files are removed before every attempt, so a retry starts clean
 *  I4  the same input + preset produces byte-identical output (verified cross-process)
 *  I5  every state transition is journaled *before* the action it describes is
 *      considered committed, so a crash leaves at most one ambiguous task
 */
export async function executeRun(options) {
  const {
    runDir,
    outputDir,
    journal,
    runId,
    preset,
    tasks,
    concurrency,
    attempts,
    taskTimeoutMs,
    reserveBytes,
    maxInflightBytes,
    overwrite,
    retryUnknown = false,
    fault = '',
    onProgress = () => {},
    log = () => {},
    controller = { cancelled: false, hard: false }
  } = options;

  const stagingDir = path.join(runDir, 'staging');
  ensureDir(stagingDir);
  const purged = purgeStaging(stagingDir);
  if (purged) log(`cleaned ${purged} orphaned staging file(s) from a previous attempt`);

  // RSS is sampled, not averaged: the number an operator cares about is the
  // peak, because that is what gets an OOM-killed container killed.
  let peakRss = process.memoryUsage().rss;
  const rssTimer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }, 100);
  rssTimer.unref?.();

  const cancelFile = path.join(runDir, 'cancel.request');
  try {
    fs.rmSync(cancelFile, { force: true });
  } catch {}

  const state = {
    cursor: 0,
    inflightBytes: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    retries: 0,
    blocked: null,
    cancelRequested: false,
    hardCancel: false,
    handedOut: new Set()
  };

  // Cross-process cancel: `batchpress cancel` only touches this file, which is
  // why cancellation works even when the runner is in a different terminal.
  const cancelPoll = setInterval(() => {
    if (state.cancelRequested) return;
    if (fs.existsSync(cancelFile)) {
      state.cancelRequested = true;
      log('cancel requested (external file); finishing in-flight tasks');
      if (typeof controller.onCancel === 'function') controller.onCancel();
      setTimeout(() => {
        state.hardCancel = true;
      }, options.cancelGraceMs ?? 3000).unref?.();
    }
  }, 200);
  cancelPoll.unref?.();

  const pending = [];
  for (const task of tasks) {
    // queued must precede any terminal event for the same task, otherwise the
    // folder would see a terminal state for a task it has never heard of.
    journal.append({
      t: 'task.queued',
      taskId: task.taskId,
      rel: task.rel,
      outRel: task.outRel,
      bytes: task.bytes,
      pixels: task.pixels
    });
    const target = outputPathFor(outputDir, task);
    if (!overwrite && fs.existsSync(target)) {
      journal.append({ t: 'task.skip', taskId: task.taskId, reason: 'output-exists' });
      state.skipped += 1;
      continue;
    }
    pending.push(task);
  }

  const total = pending.length + state.skipped;
  const progress = () =>
    onProgress({
      done: state.done,
      failed: state.failed,
      skipped: state.skipped,
      cancelled: state.cancelled,
      retries: state.retries,
      total,
      inflight: state.inflightBytes
    });

  const isCancelled = () => state.cancelRequested || controller.cancelled || controller.hard;

  function takeNext() {
    if (state.cursor >= pending.length) return null;
    if (state.blocked) return null;
    const task = pending[state.cursor];
    if (state.inflightBytes > 0 && state.inflightBytes + task.bytes > maxInflightBytes) {
      return null; // wait for a slot to release memory budget
    }
    const room = hasRoom(outputDir, task, preset, reserveBytes);
    if (!room.ok) {
      state.blocked = {
        reason: 'disk-reserve',
        freeBytes: room.free,
        needBytes: room.need,
        reserveBytes,
        taskId: task.taskId
      };
      journal.append({
        t: 'run.paused',
        reason: 'disk-reserve',
        freeBytes: room.free,
        needBytes: room.need,
        reserveBytes,
        taskId: task.taskId
      });
      log(
        `disk guard tripped: free ${humanBytes(room.free)}, need ${humanBytes(
          room.need
        )}, reserve ${humanBytes(reserveBytes)}`
      );
      return null;
    }
    state.cursor += 1;
    state.inflightBytes += task.bytes;
    state.handedOut.add(task.taskId);
    return task;
  }

  async function handle(task, slot) {
    let attempt = task.priorAttempts ?? 0;
    try {
      for (;;) {
        if (isCancelled()) {
          journal.append({ t: 'task.cancel', taskId: task.taskId, attempt });
          state.cancelled += 1;
          return;
        }
        attempt += 1;
        const staging = path.join(stagingDir, `${task.taskId}.part`);
        try {
          fs.rmSync(staging, { force: true });
        } catch {}

        journal.append({
          t: 'task.attempt',
          taskId: task.taskId,
          rel: task.rel,
          attempt,
          startedAt: new Date().toISOString()
        });

        const job = {
          jobId: `${task.taskId}:${attempt}`,
          inputPath: task.srcAbs,
          stagingPath: staging,
          preset: {
            format: preset.format,
            options: preset.options,
            resize: preset.resize ?? null
          }
        };
        if (fault === 'transient' && attempt === 1) job.fault = 'transient';
        if (fault === 'enospc' && attempt === 1) job.fault = 'enospc';

        const result = await slot.exec(job, taskTimeoutMs);

        if (result.ok) {
          const target = outputPathFor(outputDir, task);
          if (!overwrite && fs.existsSync(target)) {
            fs.rmSync(staging, { force: true });
            journal.append({ t: 'task.skip', taskId: task.taskId, reason: 'output-exists' });
            state.skipped += 1;
            return;
          }
          ensureDir(path.dirname(target));
          const outBytes = fs.statSync(staging).size;
          fs.renameSync(staging, target); // I1: atomic publish
          journal.append({
            t: 'task.ok',
            taskId: task.taskId,
            attempt,
            input: { bytes: task.bytes, sha256: result.inputSha256 },
            output: {
              rel: task.outRel,
              bytes: outBytes,
              sha256: result.outputSha256,
              width: result.width,
              height: result.height
            },
            ms: Math.round(result.ms)
          });
          state.done += 1;
          progress();
          return;
        }

        const cls = classifyError(result.error, { retryUnknown });
        const willRetry = cls.retryable && attempt < attempts;
        journal.append({
          t: 'task.fail',
          taskId: task.taskId,
          attempt,
          code: cls.code,
          message: cls.message,
          retryable: cls.retryable,
          final: !willRetry
        });

        if (cls.code === 'ENOSPC') {
          state.blocked = { reason: 'enospc', freeBytes: freeBytes(outputDir), needBytes: 0 };
          journal.append({
            t: 'run.paused',
            reason: 'enospc',
            freeBytes: freeBytes(outputDir)
          });
          log('write failed with ENOSPC; pausing the queue instead of failing every task');
          return;
        }
        if (!willRetry) {
          state.failed += 1;
          progress();
          return;
        }
        state.retries += 1;
        const wait = backoffMs(attempt);
        log(`retry ${task.rel} #${attempt}/${attempts} after ${cls.code}, waiting ${wait}ms`);
        progress();
        await sleep(wait);
      }
    } finally {
      state.inflightBytes -= task.bytes;
    }
  }

  async function slotLoop() {
    const slot = new Slot();
    try {
      for (;;) {
        if (isCancelled() || state.blocked) return;
        const task = takeNext();
        if (!task) {
          if (state.cursor >= pending.length || state.blocked) return;
          await sleep(25); // memory budget saturated, wait for a release
          continue;
        }
        await handle(task, slot);
      }
    } finally {
      slot.kill();
    }
  }

  const loops = Array.from({ length: Math.max(1, concurrency) }, () => slotLoop());
  await Promise.all(loops);
  clearInterval(cancelPoll);
  clearInterval(rssTimer);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  // Anything still inflight at this point was aborted by cancel/timeout.
  if (state.hardCancel || controller.hard) {
    const folded = fold(Journal.read(journal.file).events);
    for (const t of folded.tasks.values()) {
      if (t.status === 'interrupted') {
        journal.append({ t: 'task.cancel', taskId: t.taskId, attempt: t.attempts, reason: 'hard-cancel' });
        state.cancelled += 1;
      }
    }
    purgeStaging(stagingDir);
  }

  // Tasks that were never handed out must be recorded as cancelled too.
  // Without this the summary would claim status=cancelled while every task
  // still read as `pending`, which is exactly the kind of report/reality
  // mismatch that makes an operator distrust the tool.
  // On a disk pause we deliberately leave them `pending` so resume picks them up.
  if (isCancelled() && !state.blocked) {
    for (let i = state.cursor; i < pending.length; i += 1) {
      const task = pending[i];
      if (state.handedOut.has(task.taskId)) continue;
      journal.append({
        t: 'task.cancel',
        taskId: task.taskId,
        attempt: 0,
        reason: state.cancelRequested ? 'cancel-requested' : 'cancel-requested-in-process'
      });
      state.cancelled += 1;
    }
  }

  let status = 'completed';
  let exitCode = 0;
  if (state.blocked) {
    status = 'paused';
    exitCode = 4;
  } else if (isCancelled()) {
    status = 'cancelled';
    exitCode = 3;
  } else if (state.failed > 0) {
    status = 'completed-with-failures';
    exitCode = 2;
  }

  journal.append({
    t: 'run.end',
    runId,
    status,
    exitCode,
    endedAt: new Date().toISOString(),
    peakRssBytes: peakRss,
    counts: {
      done: state.done,
      failed: state.failed,
      skipped: state.skipped,
      cancelled: state.cancelled,
      retries: state.retries
    },
    blocked: state.blocked
  });

  return {
    runId,
    status,
    exitCode,
    counts: {
      done: state.done,
      failed: state.failed,
      skipped: state.skipped,
      cancelled: state.cancelled,
      retries: state.retries,
      total
    },
    blocked: state.blocked
  };
}

export function specOf({ presetName, preset, concurrency, attempts, taskTimeoutMs, reserveBytes, maxInflightBytes, overwrite }) {
  return {
    presetName,
    presetSignature: presetSignature(preset),
    concurrency,
    attempts,
    taskTimeoutMs,
    reserveBytes,
    maxInflightBytes,
    overwrite
  };
}
