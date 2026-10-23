# Design notes

This document records *why* the implementation looks the way it does, and which claims were verified against the real upstream rather than assumed.

## 1. Verified facts about the upstream

Checked on 2026-10-23 against `sharp@0.35.5` (libvips 8.18.7) and `api.github.com`.

| Question | Answer | How it was checked |
| --- | --- | --- |
| Repository | `lovell/sharp` | REST `/repos/lovell/sharp` |
| License | Apache-2.0 | REST `license.spdx_id`, and `node_modules/sharp/LICENSE` |
| Maturity | 32,783 stars, not archived, last push 2026-10-22 | REST |
| Runtime surface | `sharp()` factory; static knobs `cache`, `concurrency`, `counters`, `simd`, `block`, `unblock` | `Object.keys(require('sharp'))` |
| Batch capability | none | `grep -ril` over `node_modules/sharp/lib` for `batch`, `resume`, `journal`, `retr`, `cancel`, `disk` → 0 files each |
| Input formats | jpeg, png, webp, avif/heif, tiff, gif, svg, jxl, jp2, pdf (conditional on libvips build) | `Object.keys(sharp.format)` |
| Metadata policy | stripped by default; `rotate()` honours EXIF orientation | empirical: output `exif`/`icc` are `undefined`; orientation-6 input comes out 200×320 |
| Byte determinism | identical across separate processes | three `node` runs of the same pipeline → same sha256 |

The last row is load-bearing: G4 in the README ("a retry is a content-level no-op") is only true *because* output bytes are reproducible. If sharp were non-deterministic, a retry would still be safe for correctness but could not be called idempotent. This was measured before it was designed around, not assumed.

## 2. Why a separate package instead of a fork

`sharp` is a library with a large upstream test suite and a stable public API; adding a queue owner, a journal and a CLI to it would (a) change its public surface, (b) require rebasing against a fast-moving native dependency, and (c) put batch semantics in the hands of a project that does not want them. So batchpress consumes sharp as a dependency and adds the layer above it. The dependency is one package, pinned by range, and the boundary is a single call — `toBuffer()` — which is also the point where a future engine could be swapped in.

## 3. Event log instead of a state file

A `state.json` rewrite is a read-modify-write cycle: a crash between read and write loses every task's status, and a crash during the write can leave a truncated file. An append-only log degrades gracefully instead — the worst case is a torn last line, which the reader detects and reports (`tornJournalLines` in the summary).

```
{"v":1,"seq":12,"ts":"…","t":"task.attempt","taskId":"6a57…","attempt":1}
{"v":1,"seq":13,"ts":"…","t":"task.ok","taskId":"6a57…","attempt":1,
 "input":{"bytes":4194304,"sha256":"…"},"output":{"rel":"a/b.webp","bytes":812345,
 "sha256":"…","width":1600,"height":1200},"ms":93}
```

Every event is fsync'd. At three events per task this costs a few milliseconds per task — measurable, and cheaper than losing a night's work. `seq` is continued across `resume` rather than restarted, so gaps are detectable.

The fold is a pure function `events → {run, tasks, counts}`. This is why `report` works on a dead process and why the report cannot disagree with reality: both are the same function of the same bytes.

## 4. Task identity

```
taskId = sha256(normalise(relPath) ‖ "\0" ‖ canonical({format, options, resize})).slice(0,16)
```

Two properties matter:

- **Path-based, not content-based.** Content hashing every file before scheduling would double the read I/O on a large library. Path + preset is stable across runs and machines, which is all resume needs.
- **Canonical serialisation.** `JSON.stringify` preserves insertion order, so `{quality, effort}` and `{effort, quality}` would hash differently — and a preset reordered in a later version would silently produce a different id, making every file look new. The signature therefore sorts keys at every level. This was found by a unit test, not by inspection.

## 5. Publish protocol

```
encode → staging/<taskId>.part → (fsync on close) → rename → <out>/<rel>.<ext>
```

`rename` within one volume is atomic on both NTFS and POSIX: the destination either has the old content or the new content, never a mix. The staging directory lives under `<out>/.batchpress/runs/<id>/staging`, so it is guaranteed to be on the same volume as the destination — a `rename` across volumes would fail with `EXDEV`, and a copy fallback would reintroduce the partial-write window.

On a retry the staging file is removed first. That is what makes `attempt 2` observationally identical to `attempt 1`, and it is why a retry cannot leave two half-written files with the same name.

The one window the protocol cannot close is: `rename` succeeded, then the process died before `task.ok` was written. On resume such a task is `interrupted` with an existing destination. Because existence implies a complete file, resume **adopts** it (records `task.ok` with `recovered: "existing-output-after-crash"`) instead of re-encoding. The drill that kills a run with `SIGKILL` exercises this path.

## 6. Concurrency

Two independent layers exist, and only one of them is ours:

1. libvips has its own worker pool (`sharp.concurrency()`), defaulting to the core count. With 4 slots on a 16-core box that would be 4 × 16 threads — memory and cache behaviour would be unpredictable.
2. batchpress therefore pins every worker to `sharp.concurrency(1)` and `sharp.cache(false)`, making the slot count the single source of concurrency.

Slots are persistent worker threads, not per-task threads: spawning a thread reloads libvips (~30–50 ms), which would dominate a batch of 400 small files. A timeout or a hard cancel terminates *that slot's* thread only; the slot respawns on its next task, so one bad file cannot poison the pool.

Measured scaling, median of three runs per configuration, 60 images of 480–1400 px on 16 logical CPUs (full table in [`RESULTS.md`](RESULTS.md)):

| slots | wall (median) | speed-up | peak RSS |
| --- | --- | --- | --- |
| 1 | 1778 ms | 1.00× | 83 MB |
| 2 | 963 ms | 1.85× | 101 MB |
| 4 | 627 ms | 2.84× | 146 MB |
| 8 | 647 ms | 2.75× | 213 MB |
| 12 | 732 ms | 2.43× | 285 MB |

Throughput peaks at 4 slots and *degrades* beyond it while memory keeps climbing. Past that point the work is bound by memory bandwidth and the shared output volume, not by CPU; extra threads only add contention and RSS. This is why the default is 4 rather than "all cores".

A note on how this number was obtained, because the first attempt was wrong: single-sample timings on this desktop vary by up to 30%, and two consecutive bench runs disagreed on whether 8 slots beat 4. A claim about the knee therefore requires repeated samples and medians; the single-sample table in `RESULTS.md` is kept for per-preset throughput, not for concurrency conclusions.

## 7. Disk guard arithmetic

```
estimate(task) = target_pixels × bpp × 1.35          (resize presets)
               = source_pixels × bpp × 1.35          (other presets, pixels known)
               = input_bytes   × 1.35                (pixels unknown)
need = Σ estimate  … but checked per task, one at a time:
write only if  free_bytes − estimate(task) ≥ reserve_bytes
```

Three decisions are deliberate:

- **Per task, not up front.** A single up-front sum would refuse to start a job that could never fit, even when the caller intends to move files away mid-run. Checking before each dequeue lets a long job coexist with a busy disk and pause exactly when it must.
- **Over-estimate.** `bpp` values are conservative and everything is multiplied by 1.35. The failure mode of an over-estimate is "paused when it would have fit"; the failure mode of an under-estimate is `ENOSPC` mid-encode, which is a partial write in the worst case. Prefer the former.
- **Pause, don't fail.** `ENOSPC` is not a per-task error. Failing 40,000 tasks because the disk filled at task 12 would produce 40,000 misleading failure records. Instead the run is marked `paused`, remaining tasks stay `pending`, and the exit code is 4. `resume` re-checks space and continues.

`free_bytes` comes from `fs.statfsSync` (`bsize × bavail`), which on Windows/NTFS returns real values — verified — and `BATCHPRESS_FAKE_FREE_BYTES` exists so this logic can be tested without filling a disk.

## 8. Cancel semantics

Cancellation is a property of the run, not a verdict about the task. Three consequences:

1. In-flight tasks are allowed to finish (graceful) until `--cancel-grace` expires, then their threads are terminated (hard).
2. Tasks never dequeued are journaled as `task.cancel` — otherwise the summary would claim `status: cancelled` while every task still read `pending`, a report/reality mismatch that makes the tool untrustworthy.
3. `resume` treats `cancelled` as unfinished work. An earlier version did not, and a cancel followed by a resume silently stranded 18 of 20 tasks; the integration test caught it.

Cross-process cancel uses a file (`cancel.request`) instead of a signal because a signal needs the pid, and the pid is not always available (detached process, container, another user). A 200 ms poll is cheap enough and works everywhere.

## 9. Failure classification

The retry policy encodes one judgement: *can a second attempt plausibly succeed?*

| class | codes | retried | reason |
| --- | --- | --- | --- |
| contention / timing | `EBUSY` `EAGAIN` `EMFILE` `ETIMEDOUT` `EWORKER_CRASH` | yes | external state, may change |
| input defect | `EEMPTY` `EFORMAT` `ECORRUPT` | no | deterministic; five retries = five identical failures |
| environment defect | `ENOENT` `EPERM` | no | needs an operator, not a retry |
| capacity | `ENOSPC` | no | retrying cannot free a disk; the run is paused instead |
| unknown | `EUNKNOWN` | no (opt-in) | fail fast and let a human look |

Backoff is exponential with jitter, capped at 3 s: `min(3000, 150 × 2^(n-1)) × U(0.75, 1.25)`.

## 10. Resume

```
fold(journal) → tasks
for each task:
  interrupted + destination exists → adopt as done (crash between rename and journal)
  pending | retry-pending | interrupted | cancelled → requeue
  failed → requeue only with --retry-failed
purge orphaned staging/*.part
execute
```

`priorAttempts` is reset on resume: a resume is a new session with a fresh retry budget, and the historical attempts stay in the journal. Without `--retry-failed`, a task that exhausted its budget stays failed — resuming should not quietly re-burn time on a file that is known to be undecodable.

## 11. Trade-offs not hidden

| Decision | Cost | Why accepted |
| --- | --- | --- |
| Read each input fully into memory in the worker | RSS proportional to the largest input; bounded by `--max-inflight` | It gives input-hash and encode from a single read, and lets a retry avoid a second pass |
| fsync every journal event | ~1–3 ms per event, 3 events per task | Losing a night's progress is worse |
| `toBuffer()` then write | peak memory = decoded bitmap + encoded buffer | `toFile()` cannot return a digest without re-reading the file |
| Terminate the worker on timeout | loses that thread's warm state | The only reliable way to interrupt libvips |
| Estimate rather than measure output size | may pause a job that would fit | Over-estimating is recoverable, `ENOSPC` mid-encode is not |
| One run per output tree | two concurrent runs are not coordinated | Writes are atomic per file, so the worst case is duplicated work, not corruption |
