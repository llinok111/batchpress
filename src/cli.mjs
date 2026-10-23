import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRun, resumeRun, requestCancelFile, DEFAULTS } from './run.mjs';
import { buildSummary, writeReports, toMarkdown } from './report.mjs';
import { PRESETS } from './presets.mjs';
import { resolveRunDir, runsRoot } from './runner.mjs';
import { Journal, fold } from './journal.mjs';
import { freeBytes, estimateOutputBytes } from './disk.mjs';
import { humanBytes, humanMs, ensureDir } from './util.mjs';
import { planTasks } from './plan.mjs';

const EXIT = {
  ok: 0,
  usage: 1,
  failures: 2,
  cancelled: 3,
  paused: 4,
  norun: 5
};

const USAGE = `batchpress — crash-safe batch manager for sharp's single-image pipeline

Usage
  batchpress run    --in <dir> --out <dir> [options]
  batchpress resume --out <dir> [--run <id>] [options]
  batchpress status --out <dir> [--run <id>] [--json]
  batchpress report --out <dir> [--run <id>] [--print]
  batchpress cancel --out <dir> [--run <id>]
  batchpress plan   --in <dir> --out <dir> [--preset <name>]
  batchpress presets
  batchpress doctor

Options
  --preset <name>        transform preset (default webp-q80); see \`presets\`
  --concurrency <n>      parallel worker slots (default ${DEFAULTS.concurrency})
  --attempts <n>         total attempts per task, 1 disables retry (default ${DEFAULTS.attempts})
  --timeout <ms>         per-task timeout (default ${DEFAULTS.taskTimeoutMs})
  --reserve <bytes>      free space to keep untouched (default 512 MiB)
  --max-inflight <bytes> input bytes allowed in flight at once (default 256 MiB)
  --limit <n>            only process the first n files (smoke tests)
  --overwrite            re-encode even when the output already exists
  --retry-unknown        also retry errors of unknown class (off by default)
  --retry-failed         resume: retry tasks that already failed terminally
  --fault <kind>         inject a fault for drills: transient | enospc
  --quiet                suppress per-task log lines
  --json                 machine-readable status

Exit codes
  0 ok · 1 usage · 2 completed-with-failures · 3 cancelled · 4 paused (disk) · 5 no run
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

const num = (v, d) => (v === undefined ? d : Number(v));

function cfgFromArgs(args) {
  return {
    inputDir: args.in,
    outputDir: args.out,
    presetName: args.preset ?? 'webp-q80',
    concurrency: num(args.concurrency, DEFAULTS.concurrency),
    attempts: num(args.attempts, DEFAULTS.attempts),
    taskTimeoutMs: num(args.timeout, DEFAULTS.taskTimeoutMs),
    reserveBytes: num(args.reserve, DEFAULTS.reserveBytes),
    maxInflightBytes: num(args['max-inflight'], DEFAULTS.maxInflightBytes),
    limit: num(args.limit, 0),
    overwrite: !!args.overwrite,
    retryUnknown: !!args['retry-unknown'],
    retryFailed: !!args['retry-failed'],
    runId: typeof args.run === 'string' ? args.run : undefined,
    fault: typeof args.fault === 'string' ? args.fault : ''
  };
}

function makeLogger(args) {
  if (args.quiet) return () => {};
  return (msg) => process.stdout.write(`  ${msg}\n`);
}

function progressBar(args) {
  if (args.quiet) return () => {};
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (now - last < 120 && p.done + p.failed + p.cancelled < p.total) return;
    last = now;
    const settled = p.done + p.failed + p.skipped + p.cancelled;
    const pct = p.total ? Math.round((settled / p.total) * 100) : 100;
    const parts = [
      `${settled}/${p.total} (${pct}%)`,
      `ok ${p.done}`,
      `fail ${p.failed}`,
      `skip ${p.skipped}`,
      `retry ${p.retries}`
    ];
    process.stderr.write(`\r${parts.join(' · ')}        `);
    if (settled >= p.total) process.stderr.write('\n');
  };
}

function printSummary(summary, { print = false } = {}) {
  const c = summary.counts;
  process.stdout.write(
    [
      `run ${summary.runId}`,
      `status ${summary.status}${summary.exitCode !== null ? ` (exit ${summary.exitCode})` : ''}`,
      `tasks ${c.total} · done ${c.done} · skipped ${c.skipped} · failed ${c.failed} · cancelled ${c.cancelled}` +
        (c.interrupted ? ` · interrupted ${c.interrupted}` : ''),
      `bytes in ${humanBytes(summary.bytes.input)} → out ${humanBytes(summary.bytes.output)}` +
        (summary.bytes.ratio ? ` (${summary.bytes.ratio}x)` : ''),
      `task p50 ${humanMs(summary.durations.p50Ms)} · p95 ${humanMs(summary.durations.p95Ms)} · wall ${humanMs(
        summary.wallMs
      )}`,
      summary.peakRssBytes ? `peak RSS ${humanBytes(summary.peakRssBytes)}` : null,
      summary.throughput ? `throughput ${summary.throughput} tasks/s` : null,
      summary.paused ? `PAUSED: ${summary.paused.reason}` : null,
      summary.failures.length
        ? `failures: ${summary.failures
            .slice(0, 5)
            .map((f) => `${f.rel} [${f.code}]`)
            .join(', ')}${summary.failures.length > 5 ? ` +${summary.failures.length - 5} more` : ''}`
        : null
    ]
      .filter(Boolean)
      .join('\n') + '\n'
  );
  if (print) process.stdout.write(`\n${toMarkdown(summary)}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || args.help) {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }

  if (cmd === 'presets') {
    process.stdout.write('name            format  resize        bpp   description\n');
    for (const [name, p] of Object.entries(PRESETS)) {
      const r = p.resize ? `${p.resize.width}x${p.resize.height}` : '-';
      process.stdout.write(
        `${name.padEnd(15)} ${p.format.padEnd(7)} ${r.padEnd(13)} ${String(p.bpp).padEnd(5)} ${p.label}\n`
      );
    }
    return EXIT.ok;
  }

  if (cmd === 'doctor') {
    const out = args.out ?? process.cwd();
    const free = freeBytes(out);
    process.stdout.write(
      [
        `node        ${process.version}`,
        `platform    ${process.platform} ${process.arch}`,
        `cwd         ${process.cwd()}`,
        `free space  ${free === null ? 'unknown' : `${humanBytes(free)} on ${path.resolve(out)}`}`,
        `presets     ${Object.keys(PRESETS).length}`
      ].join('\n') + '\n'
    );
    try {
      const sharp = (await import('sharp')).default;
      process.stdout.write(`sharp       ${sharp.versions.sharp} · libvips ${sharp.versions.vips}\n`);
    } catch (err) {
      process.stdout.write(`sharp       MISSING (${err.message})\n`);
      return EXIT.usage;
    }
    return EXIT.ok;
  }

  if (cmd === 'plan') {
    if (!args.in) {
      process.stderr.write('plan requires --in\n');
      return EXIT.usage;
    }
    const cfg = cfgFromArgs(args);
    const { tasks, preset, scanned } = await planTasks({
      inputDir: cfg.inputDir,
      outputDir: cfg.outputDir ?? path.join(cfg.inputDir, '.batchpress-out'),
      presetName: cfg.presetName,
      limit: cfg.limit
    });
    const est = tasks.reduce((s, t) => s + estimateOutputBytes(t, preset), 0);
    process.stdout.write(
      `preset ${cfg.presetName} · candidates ${scanned} · planned ${tasks.length} · estimated output ${humanBytes(
        est
      )}\n`
    );
    for (const t of tasks.slice(0, 20)) {
      process.stdout.write(`  ${t.rel}  ${humanBytes(t.bytes)}${t.pixels ? ` · ${t.pixels}px` : ''}\n`);
    }
    if (tasks.length > 20) process.stdout.write(`  ... ${tasks.length - 20} more\n`);
    return EXIT.ok;
  }

  if (cmd === 'cancel') {
    if (!args.out) {
      process.stderr.write('cancel requires --out\n');
      return EXIT.usage;
    }
    try {
      const dir = requestCancelFile(args.out, typeof args.run === 'string' ? args.run : undefined);
      process.stdout.write(`cancel requested for ${dir}\n`);
      return EXIT.ok;
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.norun;
    }
  }

  if (cmd === 'status' || cmd === 'report') {
    if (!args.out) {
      process.stderr.write(`${cmd} requires --out\n`);
      return EXIT.usage;
    }
    const runDir = resolveRunDir(args.out, typeof args.run === 'string' ? args.run : undefined);
    if (!runDir) {
      process.stderr.write(`no run under ${runsRoot(args.out)}\n`);
      return EXIT.norun;
    }
    const summary = buildSummary(runDir);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return EXIT.ok;
    }
    if (cmd === 'report') {
      const files = writeReports(runDir, summary);
      printSummary(summary, { print: !!args.print });
      process.stdout.write(`\nwrote:\n  ${files.json}\n  ${files.md}\n  ${files.csv}\n`);
      return EXIT.ok;
    }
    printSummary(summary);
    return EXIT.ok;
  }

  if (cmd === 'run' || cmd === 'resume') {
    if (cmd === 'run' && (!args.in || !args.out)) {
      process.stderr.write('run requires --in and --out\n');
      return EXIT.usage;
    }
    if (cmd === 'resume' && !args.out) {
      process.stderr.write('resume requires --out\n');
      return EXIT.usage;
    }
    const cfg = cfgFromArgs(args);
    const log = makeLogger(args);
    const onProgress = progressBar(args);

    const controller = { cancelled: false, hard: false };
    const onSigint = () => {
      if (controller.cancelled) {
        controller.hard = true;
        log('second interrupt: aborting in-flight tasks');
        return;
      }
      controller.cancelled = true;
      log('interrupt: finishing in-flight tasks, press Ctrl-C again to abort them');
    };
    process.on('SIGINT', onSigint);

    try {
      const started = Date.now();
      const result =
        cmd === 'run'
          ? await startRun({ ...cfg, log, onProgress, controller })
          : await resumeRun({ ...cfg, log, onProgress, controller });
      const summary = buildSummary(result.runDir);
      writeReports(result.runDir, summary);
      process.stderr.write('\n');
      printSummary(summary);
      process.stdout.write(`run dir ${result.runDir}\n`);
      return result.exitCode ?? EXIT.ok;
    } catch (err) {
      process.stderr.write(`\nerror: ${err.message}\n`);
      return EXIT.usage;
    } finally {
      process.off('SIGINT', onSigint);
    }
  }

  process.stderr.write(`unknown command "${cmd}"\n\n${USAGE}`);
  return EXIT.usage;
}

/**
 * Exit only after stdout/stderr have actually drained.
 *
 * `process.exit(code)` terminates immediately and silently discards whatever is
 * still buffered. Against a pipe (the normal case: `| jq`, `| node -e`, CI
 * capture) the buffer is 8 KiB, so `status --json` on a run with more than ~40
 * tasks produced exactly 8192 bytes and `JSON.parse` failed with "Unterminated
 * string at position 8192". Redirecting to a file masked it, because a file
 * write is synchronous and never queues.
 *
 * `process.exitCode` plus a natural return lets Node flush before exiting.
 */
function exitWhenFlushed(code) {
  process.exitCode = code;
  // A piped stdout keeps the event loop alive until the last chunk is written;
  // an interactive terminal may not, so nudge it without truncating anything.
  if (process.stdout.writableLength === 0) return;
  process.stdout.once('drain', () => {});
}

main()
  .then((code) => exitWhenFlushed(code))
  .catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    exitWhenFlushed(1);
  });
