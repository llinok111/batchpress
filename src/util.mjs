import fs from 'node:fs';
import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const nowIso = () => new Date().toISOString();

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Streamed so a 200 MB file does not need a 200 MB buffer. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function humanBytes(n) {
  if (!Number.isFinite(n)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const sign = n < 0 ? '-' : '';
  return `${sign}${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function humanMs(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m${s}s`;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Atomic write for small text files (report/summary). */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
