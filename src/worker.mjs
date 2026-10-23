import fs from 'node:fs';
import crypto from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';

/**
 * Worker = exactly one job at a time, one image at a time.
 *
 * sharp/libvips keeps a thread pool of its own. Pinning it to 1 here and
 * disabling the operation cache is what makes our queue length the *only*
 * source of concurrency: without this, N workers can still spawn N x cores
 * libvips threads and the memory ceiling becomes unpredictable.
 */
sharp.concurrency(1);
sharp.cache(false);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function classifyLocal(err) {
  const code = err && err.code ? String(err.code) : '';
  return { code: code || null, message: String((err && err.message) || err || 'unknown') };
}

parentPort.on('message', async (job) => {
  const t0 = process.hrtime.bigint();
  try {
    // Fault injection hook, used by the test suite to prove retry semantics.
    if (job.fault === 'transient') {
      const e = new Error('injected transient fault (EBUSY)');
      e.code = 'EBUSY';
      throw e;
    }
    if (job.fault === 'enospc') {
      const e = new Error('injected ENOSPC');
      e.code = 'ENOSPC';
      throw e;
    }

    // Single read: hash and decode from the same buffer, so retries and
    // idempotency records never cost a second pass over the file.
    const input = fs.readFileSync(job.inputPath);
    const inputSha256 = sha256(input);

    let pipeline = sharp(input, { failOn: 'truncated', limitInputPixels: 268402689 });
    pipeline = pipeline.rotate(); // honour EXIF orientation, then strip metadata
    if (job.preset.resize) pipeline = pipeline.resize(job.preset.resize);
    pipeline = pipeline.toFormat(job.preset.format, job.preset.options);

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    // Staging write: the destination path is never touched until the parent
    // process has the full, valid byte stream in hand.
    //
    // fsync before close is not paranoia: rename() is only atomic with respect
    // to *metadata*. Without flushing the data first, a power loss right after
    // the publish can leave a correctly named file with unwritten content on
    // filesystems that reorder data and metadata writes.
    const fd = fs.openSync(job.stagingPath, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    parentPort.postMessage({
      jobId: job.jobId,
      ok: true,
      outputBytes: data.length,
      outputSha256: sha256(data),
      inputSha256,
      width: info.width,
      height: info.height,
      ms: Number(process.hrtime.bigint() - t0) / 1e6
    });
  } catch (err) {
    parentPort.postMessage({ jobId: job.jobId, ok: false, error: classifyLocal(err) });
  }
});
