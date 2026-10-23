import fs from 'node:fs';
import path from 'node:path';
import { Journal, fold } from './journal.mjs';
import { executeRun, newRunId, resolveRunDir, runsRoot, setLastRun, specOf } from './runner.mjs';
import { planTasks, outputPathFor } from './plan.mjs';
import { resolvePreset } from './presets.mjs';
import { ensureDir, sha256File, writeFileAtomic } from './util.mjs';

export const DEFAULTS = {
  concurrency: Math.max(2, Math.min(4, Math.floor((process.env.NUMBER_OF_PROCESSORS || 8) / 2))),
  attempts: 2,
  taskTimeoutMs: 120000,
  reserveBytes: 512 * 1024 * 1024,
  maxInflightBytes: 256 * 1024 * 1024,
  cancelGraceMs: 3000,
  overwrite: false,
  retryUnknown: false,
  limit: 0
};

function normalize(cfg) {
  return {
    ...DEFAULTS,
    ...cfg,
    concurrency: Math.max(1, Number(cfg.concurrency ?? DEFAULTS.concurrency)),
    attempts: Math.max(1, Number(cfg.attempts ?? DEFAULTS.attempts))
  };
}

function startRssMonitor(intervalMs = 100) {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, intervalMs);
  timer.unref?.();
  return {
    peak: () => peak,
    stop: () => clearInterval(timer)
  };
}

/**
 * Fresh run: plan -> journal run.start -> execute.
 * The plan is journaled for every task *before* any work starts, so a resume
 * after a kill -9 still knows the full task list even if only 2 files were done.
 */
export async function startRun(cfg) {
  const options = normalize(cfg);
  const inputDir = path.resolve(options.inputDir);
  const outputDir = path.resolve(options.outputDir);
  if (!fs.existsSync(inputDir)) {
    const err = new Error(`input directory not found: ${inputDir}`);
    err.code = 'ENOENT';
    throw err;
  }
  ensureDir(outputDir);

  const preset = resolvePreset(options.presetName);
  const { tasks, scanned } = await planTasks({
    inputDir,
    outputDir,
    presetName: options.presetName,
    limit: options.limit
  });

  const runId = options.runId || newRunId();
  const runDir = path.join(runsRoot(outputDir), runId);
  ensureDir(path.join(runDir, 'staging'));

  const spec = {
    ...specOf({ ...options, preset }),
    presetName: options.presetName,
    inputDir,
    outputDir,
    limit: options.limit,
    engine: { sharp: '0.35.5', libvips: '8.18.7' }
  };
  writeFileAtomic(path.join(runDir, 'run.json'), `${JSON.stringify({ runId, spec, createdAt: new Date().toISOString() }, null, 2)}\n`);
  setLastRun(outputDir, runId);

  const journal = Journal.open(path.join(runDir, 'journal.ndjson'));
  const startedAt = new Date().toISOString();
  journal.append({ t: 'run.start', runId, total: tasks.length, scanned, spec, startedAt });

  options.log?.(`planned ${tasks.length} task(s) from ${scanned} candidate file(s)`);

  const result = await executeRun({
    runDir,
    outputDir,
    journal,
    runId,
    preset,
    tasks,
    concurrency: options.concurrency,
    attempts: options.attempts,
    taskTimeoutMs: options.taskTimeoutMs,
    reserveBytes: options.reserveBytes,
    maxInflightBytes: options.maxInflightBytes,
    overwrite: options.overwrite,
    retryUnknown: options.retryUnknown,
    cancelGraceMs: options.cancelGraceMs,
    fault: options.fault || process.env.BATCHPRESS_FAULT || '',
    onProgress: options.onProgress ?? (() => {}),
    log: options.log ?? (() => {}),
    controller: options.controller ?? { cancelled: false, hard: false }
  });
  journal.close();
  return { ...result, runDir, scanned };
}

/**
 * Resume: fold the journal, close the ambiguous window, requeue only the work
 * that is genuinely unfinished.
 */
export async function resumeRun(cfg) {
  const options = normalize(cfg);
  const outputDir = path.resolve(options.outputDir);
  const runDir = resolveRunDir(outputDir, options.runId);
  if (!runDir) {
    const err = new Error(`no run found under ${runsRoot(outputDir)}`);
    err.code = 'ENORUN';
    throw err;
  }
  const journalFile = path.join(runDir, 'journal.ndjson');
  const runMeta = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const { run, tasks } = fold(Journal.read(journalFile).events);
  const spec = run.spec ?? runMeta.spec;
  const preset = resolvePreset(spec.presetName);

  const journal = Journal.open(journalFile);
  const requeue = [];
  let recovered = 0;
  let skippedNow = 0;

  for (const task of tasks.values()) {
    // Ambiguous window: the process died between rename() and the journal write.
    // The destination can only exist as a complete file (rename is atomic), so
    // adopt it instead of re-encoding - and record the adoption explicitly.
    if (task.status === 'interrupted') {
      const target = outputPathFor(outputDir, task);
      if (fs.existsSync(target)) {
        const stat = fs.statSync(target);
        const sha = await sha256File(target);
        journal.append({
          t: 'task.ok',
          taskId: task.taskId,
          attempt: task.attempts || 1,
          recovered: 'existing-output-after-crash',
          output: { rel: task.outRel, bytes: stat.size, sha256: sha },
          input: null,
          ms: 0
        });
        recovered += 1;
        continue;
      }
    }

    // `cancelled` is a decision about the *run*, not a verdict about the task:
    // the work was never attempted (or was aborted mid-flight), so a resume must
    // pick it up again. Treating it as terminal would strand work forever.
    const unfinished =
      task.status === 'pending' ||
      task.status === 'retry-pending' ||
      task.status === 'interrupted' ||
      task.status === 'cancelled';
    const retryableFailure = options.retryFailed && task.status === 'failed';
    if (!unfinished && !retryableFailure) continue;

    const target = outputPathFor(outputDir, task);
    if (!options.overwrite && fs.existsSync(target)) {
      journal.append({ t: 'task.skip', taskId: task.taskId, reason: 'output-exists-on-resume' });
      skippedNow += 1;
      continue;
    }

    requeue.push({
      taskId: task.taskId,
      rel: task.rel,
      outRel: task.outRel,
      srcAbs: path.join(spec.inputDir, ...task.rel.split('/')),
      bytes: task.bytes,
      pixels: task.pixels,
      priorAttempts: 0
    });
  }

  journal.append({
    t: 'run.resume',
    runId: runMeta.runId,
    requeued: requeue.length,
    recovered,
    skippedNow
  });

  options.log?.(
    `resume ${runMeta.runId}: ${requeue.length} to run, ${recovered} adopted as already-complete, ${skippedNow} skipped`
  );

  const result = await executeRun({
    runDir,
    outputDir,
    journal,
    runId: runMeta.runId,
    preset,
    tasks: requeue,
    concurrency: options.concurrency,
    attempts: options.attempts,
    taskTimeoutMs: options.taskTimeoutMs,
    reserveBytes: options.reserveBytes,
    maxInflightBytes: options.maxInflightBytes,
    overwrite: options.overwrite,
    retryUnknown: options.retryUnknown,
    cancelGraceMs: options.cancelGraceMs,
    fault: options.fault || process.env.BATCHPRESS_FAULT || '',
    onProgress: options.onProgress ?? (() => {}),
    log: options.log ?? (() => {}),
    controller: options.controller ?? { cancelled: false, hard: false }
  });
  journal.close();
  return { ...result, runDir, recovered, skippedNow };
}

export function requestCancelFile(outputDir, runId) {
  const runDir = resolveRunDir(path.resolve(outputDir), runId);
  if (!runDir) {
    const err = new Error('no run found to cancel');
    err.code = 'ENORUN';
    throw err;
  }
  fs.writeFileSync(path.join(runDir, 'cancel.request'), new Date().toISOString());
  return runDir;
}
