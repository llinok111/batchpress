import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only event journal (NDJSON).
 *
 * Why a journal and not a "state.json":
 *  - a rewrite of a whole state file is a read-modify-write race, and a crash
 *    mid-rewrite loses *everything*; an append either lands or it does not
 *  - the last line may be torn by a crash, so the reader tolerates it and the
 *    writer records `seq` so gaps are detectable
 *  - it doubles as an audit trail: the report is derived from it, so totals can
 *    never drift from what actually happened
 *
 * Every append is fsync'd. At ~3 events per task this costs a few ms per task,
 * which is an acceptable price for "kill -9 at any instant is recoverable".
 */
export class Journal {
  constructor(file) {
    this.file = file;
    this.seq = 0;
    this.fd = fs.openSync(file, 'a');
  }

  /** Open for append, continuing the sequence numbers of an existing journal. */
  static open(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { events } = Journal.read(file);
    const journal = new Journal(file);
    journal.seq = events.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0);
    return journal;
  }

  static read(file) {
    if (!fs.existsSync(file)) return { events: [], torn: 0 };
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    const events = [];
    let torn = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        torn += 1; // a partially flushed line from an abrupt kill
      }
    }
    return { events, torn };
  }

  append(event) {
    const rec = { v: 1, seq: ++this.seq, ts: new Date().toISOString(), ...event };
    fs.writeSync(this.fd, `${JSON.stringify(rec)}\n`);
    fs.fsyncSync(this.fd);
    return rec;
  }

  close() {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

const TERMINAL = new Set(['done', 'failed', 'skipped', 'cancelled']);

/**
 * Fold the event log into (run meta, per-task state).
 *
 * `inflight` at the end of a log means the process died between attempt and
 * outcome; the folder surfaces that as `interrupted` so the resume path can
 * treat it explicitly instead of silently forgetting the task.
 */
export function fold(events) {
  const run = {
    runId: null,
    status: 'unknown',
    total: 0,
    spec: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    paused: null,
    resumes: 0,
    peakRssBytes: null
  };
  const tasks = new Map();

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    switch (e.t) {
      case 'run.start':
        run.runId = e.runId;
        run.status = 'running';
        run.total = e.total ?? 0;
        run.spec = e.spec ?? null;
        run.startedAt = e.startedAt ?? e.ts;
        break;
      case 'run.resume':
        run.resumes += 1;
        run.status = 'running';
        break;
      case 'run.paused':
        run.paused = { reason: e.reason, freeBytes: e.freeBytes, needBytes: e.needBytes, at: e.ts };
        break;
      case 'run.end':
        run.status = e.status;
        run.endedAt = e.endedAt ?? e.ts;
        run.exitCode = e.exitCode ?? null;
        run.peakRssBytes = e.peakRssBytes ?? null;
        break;
      case 'task.queued':
        if (!tasks.has(e.taskId)) {
          tasks.set(e.taskId, {
            taskId: e.taskId,
            rel: e.rel,
            outRel: e.outRel,
            bytes: e.bytes ?? 0,
            pixels: e.pixels ?? null,
            status: 'pending',
            attempts: 0,
            ms: 0,
            output: null,
            error: null,
            reason: null
          });
        }
        break;
      case 'task.attempt': {
        const t = tasks.get(e.taskId);
        if (t) {
          t.status = 'inflight';
          t.attempts = e.attempt ?? t.attempts + 1;
          t.startedAt = e.startedAt ?? e.ts;
        }
        break;
      }
      case 'task.ok': {
        const t = tasks.get(e.taskId);
        if (t) {
          t.status = 'done';
          t.output = e.output ?? null;
          t.input = e.input ?? null;
          t.ms = e.ms ?? 0;
          t.attempt = e.attempt ?? t.attempts;
          t.error = null;
        }
        break;
      }
      case 'task.skip': {
        const t = tasks.get(e.taskId);
        if (t) {
          t.status = 'skipped';
          t.reason = e.reason ?? 'skip';
        }
        break;
      }
      case 'task.fail': {
        const t = tasks.get(e.taskId);
        if (t) {
          t.attempts = e.attempt ?? t.attempts;
          t.error = { code: e.code, message: e.message, retryable: !!e.retryable };
          t.status = e.final ? 'failed' : 'retry-pending';
        }
        break;
      }
      case 'task.cancel': {
        const t = tasks.get(e.taskId);
        if (t) t.status = 'cancelled';
        break;
      }
      default:
        break;
    }
  }

  for (const t of tasks.values()) {
    if (t.status === 'inflight') t.status = 'interrupted';
  }

  const counts = {
    total: tasks.size,
    done: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    pending: 0,
    retryPending: 0,
    inflight: 0
  };
  for (const t of tasks.values()) {
    switch (t.status) {
      case 'done':
        counts.done += 1;
        break;
      case 'skipped':
        counts.skipped += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      case 'cancelled':
        counts.cancelled += 1;
        break;
      case 'interrupted':
        counts.interrupted += 1;
        break;
      case 'retry-pending':
        counts.retryPending += 1;
        break;
      case 'pending':
        counts.pending += 1;
        break;
      case 'inflight':
        counts.inflight += 1;
        break;
      default:
        break;
    }
  }

  return { run, tasks, counts, isTerminal: TERMINAL };
}
