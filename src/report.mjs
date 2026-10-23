import fs from 'node:fs';
import path from 'node:path';
import { Journal, fold } from './journal.mjs';
import { humanBytes, humanMs, percentile, writeFileAtomic } from './util.mjs';

/**
 * Aggregation is a pure function of the journal. It therefore works after the
 * runner has exited (or been killed) and can never disagree with what actually
 * happened on disk.
 */
export function buildSummary(runDir) {
  const journalFile = path.join(runDir, 'journal.ndjson');
  const { events, torn } = Journal.read(journalFile);
  const { run, tasks, counts } = fold(events);
  const list = [...tasks.values()];

  const doneTasks = list.filter((t) => t.status === 'done');
  const inputBytes = doneTasks.reduce((s, t) => s + (t.bytes || 0), 0);
  const outputBytes = doneTasks.reduce((s, t) => s + (t.output?.bytes || 0), 0);
  const durations = doneTasks.map((t) => t.ms || 0).filter((n) => n > 0);
  const failures = list
    .filter((t) => t.status === 'failed' || t.status === 'cancelled')
    .map((t) => ({
      taskId: t.taskId,
      rel: t.rel,
      status: t.status,
      code: t.error?.code ?? (t.status === 'cancelled' ? 'CANCELLED' : 'UNKNOWN'),
      attempts: t.attempts,
      message: t.error?.message ?? ''
    }));

  const byCode = {};
  for (const f of failures) byCode[f.code] = (byCode[f.code] || 0) + 1;

  const startedAt = run.startedAt ? Date.parse(run.startedAt) : null;
  const endedAt = run.endedAt ? Date.parse(run.endedAt) : null;
  const wallMs = startedAt && endedAt ? endedAt - startedAt : null;

  return {
    runId: run.runId ?? path.basename(runDir),
    status: run.status,
    exitCode: run.exitCode,
    preset: run.spec?.presetName ?? null,
    concurrency: run.spec?.concurrency ?? null,
    attempts: run.spec?.attempts ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    wallMs,
    resumes: run.resumes,
    paused: run.paused,
    peakRssBytes: run.peakRssBytes ?? null,
    tornJournalLines: torn,
    counts,
    bytes: {
      input: inputBytes,
      output: outputBytes,
      saved: inputBytes - outputBytes,
      ratio: inputBytes > 0 ? +(outputBytes / inputBytes).toFixed(4) : null
    },
    durations: {
      sumMs: durations.reduce((s, n) => s + n, 0),
      p50Ms: Math.round(percentile(durations, 50)),
      p95Ms: Math.round(percentile(durations, 95)),
      maxMs: durations.length ? Math.round(Math.max(...durations)) : 0,
      samples: durations.length
    },
    throughput: wallMs && doneTasks.length ? +(doneTasks.length / (wallMs / 1000)).toFixed(2) : null,
    failures,
    byCode,
    tasks: list.map((t) => ({
      taskId: t.taskId,
      rel: t.rel,
      status: t.status,
      attempts: t.attempts,
      ms: t.ms,
      inputBytes: t.bytes,
      outputBytes: t.output?.bytes ?? null,
      outputSha256: t.output?.sha256 ?? null,
      error: t.error ? `${t.error.code}: ${t.error.message}` : null
    }))
  };
}

export function toMarkdown(summary) {
  const lines = [];
  const c = summary.counts;
  lines.push(`# batchpress run ${summary.runId}`);
  lines.push('');
  lines.push(`- status: **${summary.status}** (exit ${summary.exitCode ?? 'n/a'})`);
  lines.push(`- preset: \`${summary.preset}\` · concurrency ${summary.concurrency} · max attempts ${summary.attempts}`);
  lines.push(`- window: ${summary.startedAt ?? '?'} → ${summary.endedAt ?? '?'} (${humanMs(summary.wallMs)})`);
  if (summary.resumes) lines.push(`- resumed ${summary.resumes} time(s)`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| tasks | ${c.total} |`);
  lines.push(`| done | ${c.done} |`);
  lines.push(`| skipped | ${c.skipped} |`);
  lines.push(`| failed | ${c.failed} |`);
  lines.push(`| cancelled | ${c.cancelled} |`);
  lines.push(`| interrupted (pending resume) | ${c.interrupted} |`);
  lines.push(`| retries | ${summary.failures.reduce((s, f) => s + Math.max(0, f.attempts - 1), 0)} |`);
  lines.push(`| input bytes | ${humanBytes(summary.bytes.input)} |`);
  lines.push(`| output bytes | ${humanBytes(summary.bytes.output)} |`);
  lines.push(`| output/input | ${summary.bytes.ratio ?? 'n/a'} |`);
  lines.push(`| task p50 / p95 | ${summary.durations.p50Ms} ms / ${summary.durations.p95Ms} ms |`);
  lines.push(`| peak RSS | ${summary.peakRssBytes ? humanBytes(summary.peakRssBytes) : 'n/a'} |`);
  lines.push(`| throughput | ${summary.throughput ?? 'n/a'} tasks/s |`);
  lines.push('');
  if (summary.paused) {
    lines.push('## Paused');
    lines.push('');
    lines.push(
      `Reason \`${summary.paused.reason}\`: free ${humanBytes(summary.paused.freeBytes)}, need ${humanBytes(
        summary.paused.needBytes
      )}. Re-run \`batchpress resume\` after freeing space.`
    );
    lines.push('');
  }
  lines.push('## Failures');
  lines.push('');
  if (!summary.failures.length) {
    lines.push('_none_');
  } else {
    lines.push('| task | code | attempts | message |');
    lines.push('| --- | --- | --- | --- |');
    for (const f of summary.failures) {
      lines.push(`| ${f.rel} | ${f.code} | ${f.attempts} | ${String(f.message).replace(/\|/g, '\\|')} |`);
    }
  }
  lines.push('');
  lines.push('## Per task');
  lines.push('');
  lines.push('| task | status | attempts | in | out | ms |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const t of summary.tasks) {
    lines.push(
      `| ${t.rel} | ${t.status} | ${t.attempts} | ${humanBytes(t.inputBytes)} | ${
        t.outputBytes === null ? '-' : humanBytes(t.outputBytes)
      } | ${t.ms ? Math.round(t.ms) : '-'} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function failuresCsv(summary) {
  const rows = [['taskId', 'path', 'status', 'code', 'attempts', 'message']];
  for (const f of summary.failures) {
    rows.push([f.taskId, f.rel, f.status, f.code, f.attempts, f.message]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function writeReports(runDir, summary) {
  const json = path.join(runDir, 'summary.json');
  const md = path.join(runDir, 'summary.md');
  const csv = path.join(runDir, 'failures.csv');
  writeFileAtomic(json, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileAtomic(md, toMarkdown(summary));
  writeFileAtomic(csv, failuresCsv(summary));
  return { json, md, csv };
}

export function isRunDir(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'journal.ndjson'));
}
