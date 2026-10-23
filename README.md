# batchpress

**A crash-safe batch task manager for [sharp](https://github.com/lovell/sharp)'s single-image pipeline.**

`sharp` is deliberately a *single-item* engine: one input buffer in, one output buffer out. It exposes no queue, no progress, no state, no retry, no cancel, no resume and no disk awareness — a `grep` of its `lib/` for `batch`, `resume`, `journal`, `retry`, `cancel` or `disk` returns zero matches. Everything that turns "process one image" into "process 50,000 images overnight without duplication and without waking up to a half-written output tree" is missing, and that is what this project adds.

```
npm install            # sharp is the only runtime dependency
node bin/batchpress.mjs run --in ./photos --out ./out --preset webp-q80
```

---

## 1. What it guarantees

These are contracts, each enforced by a test in `test/integration.test.mjs`.

| # | Guarantee | How it is achieved |
| --- | --- | --- |
| G1 | A destination file only ever appears **complete**. No `.part`, no zero-byte, no half-encoded image. | Each task encodes to `staging/<taskId>.part`, is explicitly `fsync`'d, then published with a single `rename()` on the same volume. |
| G2 | Work already done is **never redone**. A second run over a finished tree re-encodes nothing. | `taskId = sha256(relPath ‖ canonicalPresetSignature)`; the journal records `task.ok`; existing outputs are skipped by default. Measured: 60 tasks → 0 re-encoded, 90 ms. |
| G3 | A retry cannot duplicate a side effect. | Staging file is deleted before every attempt; the destination is untouched until success; a `done` task is never dequeued again. |
| G4 | Identical input + preset ⇒ **byte-identical** output, even across processes. | Verified: three separate `node` processes produce the same sha256; the whole benchmark suite relies on it, so a retry is a content-level no-op. || G5 | `kill -9` at any instant is recoverable, and the recovery does not re-encode published files. | Append-only journal, fsync per event, torn-tail tolerance, and adoption of files that exist but whose `task.ok` never landed (a `rename()` is atomic, so existence implies completeness). |
| G6 | A full disk pauses the queue instead of failing every remaining task. | Free-space check before each dequeue against a configurable reserve, plus `ENOSPC` handling that stops the run with exit 4 and leaves remaining tasks `pending` for a later `resume`. |
| G7 | Concurrency is bounded by **one** number: the slot count. | One worker thread per slot, `sharp.concurrency(1)` and `sharp.cache(false)` inside each worker, so libvips cannot spawn an unbounded thread pool underneath. |
| G8 | Cancel is available from both the same process and another terminal. | `SIGINT` twice (graceful → hard) and a `cancel.request` file polled every 200 ms. |

## 2. Commands

```
batchpress run     --in <dir> --out <dir> [options]
batchpress resume  --out <dir> [--run <id>] [options]
batchpress status  --out <dir> [--run <id>] [--json]
batchpress report  --out <dir> [--run <id>] [--print]
batchpress cancel  --out <dir> [--run <id>]
batchpress plan    --in <dir> --out <dir> [--preset <name>] [--limit <n>]
batchpress presets
batchpress doctor
```

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--preset <name>` | `webp-q80` | Transform to apply. See `batchpress presets`. |
| `--concurrency <n>` | 4 | Parallel worker slots. |
| `--attempts <n>` | 2 | Total attempts per task; `1` disables retry. |
| `--timeout <ms>` | 120000 | Per-task timeout; the slot's thread is terminated and the task is retried. |
| `--reserve <bytes>` | 536870912 (512 MiB) | Free space that must remain untouched. |
| `--max-inflight <bytes>` | 268435456 (256 MiB) | Upper bound on input bytes being processed at once. |
| `--limit <n>` | 0 (all) | Only take the first n candidates (smoke tests). |
| `--overwrite` | off | Re-encode even when the output exists. |
| `--retry-unknown` | off | Also retry errors of unknown class (off by default: see §4). |
| `--retry-failed` | off | `resume`: also re-attempt tasks that failed terminally. |
| `--fault <kind>` | — | Inject `transient` or `enospc` for drills. |
| `--quiet` / `--json` | off | Less output / machine-readable output. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Completed, everything done or intentionally skipped. |
| `1` | Usage error / invalid configuration. |
| `2` | Completed with failures — inspect `failures.csv`. |
| `3` | Cancelled; remaining work is resumable. |
| `4` | Paused on the disk guard or `ENOSPC`; resumable after freeing space. |
| `5` | No run found for `--out` / `--run`. |

These are asserted by tests, so they can be used in shell conditionals and CI.

## 3. Presets

| name | format | resize | note |
| --- | --- | --- | --- |
| `webp-q80` | WebP q80 | — | default; good general-purpose delivery format |
| `jpeg-q82` | JPEG (mozjpeg) | — | maximum compatibility |
| `avif-q55` | AVIF q55 | — | smallest output, ~5× slower than WebP |
| `png-opt` | PNG | — | palette + max compression |
| `avatar-256` | WebP q82 | 256×256 cover | square crop, centre |
| `thumb-128` | WebP q78 | 128×128 cover | square crop, centre |
| `reencode-jpeg` | JPEG q90 (mozjpeg) | — | normalise/strip metadata |

All presets auto-rotate by EXIF orientation **before** resizing and strip EXIF/ICC unless the encoder keeps them natively. Input formats: JPEG, PNG, WebP, AVIF, TIFF, GIF, SVG.

## 4. Failure model

Errors are sorted into two classes, because the distinction is the whole point of a retry policy:

**Retried** (state did not change; a second attempt can plausibly succeed)
`EBUSY` `EAGAIN` `EMFILE` `ETIMEDOUT` `EWORKER_CRASH`

**Not retried** (a property of the input; a retry reproduces the same failure)
`EEMPTY` `EFORMAT` `ECORRUPT` `ENOENT` `EPERM` `ENOSPC`

Rationale: retrying a truncated JPEG five times produces five identical failures, five journal entries and five times the wall clock. Conversely, a disk that is momentarily locked or a worker that died is exactly the case where a retry is correct. Unknown error classes are **not** retried unless `--retry-unknown` is passed — a deliberate fail-fast default.

One classification is non-obvious: libvips reports a truncated JPEG as either `VipsJpeg: premature end of JPEG image` or a bare `Unknown error`, varying between runs on byte-identical input (~3 of 200 measured). Both map to `ECORRUPT`. Letting the second fall through to `EUNKNOWN` would make the code reported for the same file non-deterministic, which is harder to diagnose than a slightly coarser class.

Each failure is recorded with a code, the attempt number, and whether it was final:

```json
{"t":"task.fail","taskId":"6a57bbae5e682400","attempt":2,"code":"ECORRUPT",
 "message":"VipsJpeg: premature end of JPEG image","retryable":false,"final":true}
```

## 5. Where state lives

```
<out>/
  .batchpress/
    last-run                        # pointer to the newest run id
    runs/<runId>/
      run.json                      # spec snapshot (preset, limits, input dir)
      journal.ndjson                # append-only event log, the source of truth
      staging/                      # transient .part files, emptied on clean exit
      cancel.request                # created by `batchpress cancel`
      summary.json|summary.md|failures.csv
  <mirrored input tree>             # the actual outputs
```

Reports are **derived from the journal**, never from in-memory counters, so `batchpress report` works after the process is gone and can never disagree with what happened.

## 6. Typical use

**Convert a library overnight, keep it restartable:**

```bash
batchpress run --in D:/photos --out D:/photos-webp --preset webp-q80 --concurrency 4
# machine reboots at 03:00; next morning:
batchpress resume --out D:/photos-webp
batchpress report --out D:/photos-webp --print
```

**Stop cleanly from another terminal:**

```bash
batchpress cancel --out D:/photos-webp   # in-flight tasks finish, nothing is corrupted
```

**Pre-flight before committing to a big job:**

```bash
batchpress plan --in D:/photos --out D:/photos-webp --preset avatar-256
```

**Triage what failed:**

```bash
column -s, -t < D:/photos-webp/.batchpress/runs/<id>/failures.csv
```

## 7. Tests and measurements

```bash
npm test                       # 54 tests: 31 unit + 23 integration (real images, real kills)
node test/scaling.mjs 3        # concurrency curve, median of 3 per slot count
node test/bench.mjs            # throughput / memory across 10 configurations
node test/drills.mjs           # kill -9, cancel, disk guard, retry accounting
node test/verify-images.mjs    # pixel-level geometry check against an independent resampler
node test/fixtures.mjs <dir>   # regenerate the deterministic corpus
```

Recorded results, including a negative one that changed a design decision (single-sample timings disagreed about whether 8 slots beat 4), are in [`docs/RESULTS.md`](docs/RESULTS.md). Design rationale and the invariant list are in [`docs/DESIGN.md`](docs/DESIGN.md). Upstream attribution is in [`docs/SOURCES.md`](docs/SOURCES.md) and [`NOTICE`](NOTICE).

## 8. Known limits

- Animated GIF/WebP inputs are flattened to their first frame. `sharp` cannot write animations; this is inherited, not introduced.
- `max-inflight` is a byte budget, not a memory budget. Peak RSS is roughly `slots × (decoded bitmap + encoded buffer)`; measured 401 MB at 4 slots on 3200 px inputs.
- The disk estimate is a heuristic with a 1.35× safety factor, not a measurement. It fails closed (over-estimates), so it can pause a job that would in fact have fit.
- Free space is read from `statfs`; on a network share the reported value may lag actual capacity.
- One run writes one output tree. Two concurrent runs against the same `--out` are not coordinated beyond the per-file existence check.
- Timeout granularity is per task; a task that hangs inside libvips is terminated together with its worker thread, losing that thread's warm cache.

## 9. License

MIT for batchpress. `sharp` is Apache-2.0 and `libvips` LGPL-2.1-or-later; both are used unmodified through their public interfaces. See [`NOTICE`](NOTICE).
