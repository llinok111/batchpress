import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { INPUT_EXTS, resolvePreset, taskIdOf } from './presets.mjs';

/**
 * Recursive scan. Output directory and the manager's own state directory are
 * excluded so a run can never eat its own output.
 */
export function walkInputs(inputDir, outputDir) {
  const outAbs = path.resolve(outputDir);
  const results = [];
  const stack = [path.resolve(inputDir)];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.batchpress') continue;
        if (path.resolve(abs) === outAbs) continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!INPUT_EXTS.has(ext)) continue;
      results.push(abs);
    }
  }
  results.sort();
  return results;
}

/**
 * Reads only the image header for width/height; failures are non-fatal because
 * the estimator can fall back to input size. A corrupt file is therefore still
 * *planned* and later fails inside the worker with a recorded error, which is
 * exactly what a batch operator wants to see in the failure list.
 */
async function probePixels(file) {
  try {
    const meta = await sharp(file, { failOn: 'none', limitInputPixels: false }).metadata();
    if (meta.width && meta.height) return meta.width * meta.height;
  } catch {
    /* header unreadable */
  }
  return null;
}

export async function planTasks({ inputDir, outputDir, presetName, limit = 0 }) {
  const preset = resolvePreset(presetName);
  const files = walkInputs(inputDir, outputDir);
  const selected = limit > 0 ? files.slice(0, limit) : files;

  const tasks = [];
  for (const abs of selected) {
    const rel = path.relative(path.resolve(inputDir), abs).split(path.sep).join('/');
    const ext = path.extname(rel).toLowerCase();
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    tasks.push({
      taskId: taskIdOf(rel, preset),
      rel,
      outRel: `${rel.slice(0, rel.length - ext.length)}.${preset.ext}`,
      srcAbs: abs,
      bytes: stat.size,
      pixels: await probePixels(abs)
    });
  }
  return { preset, tasks, scanned: files.length };
}

export function outputPathFor(outputDir, task) {
  return path.join(path.resolve(outputDir), ...task.outRel.split('/'));
}
