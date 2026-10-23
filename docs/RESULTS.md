# Recorded results

All numbers below are copied from actual command output. Two kinds of measurement appear, and the distinction matters:

- **Benchmark table** — one sample per configuration, useful for throughput and memory *per preset*, but its wall clock varies up to ~30% between runs on this desktop.
- **Scaling table** — medians of three repetitions per configuration, used for every concurrency claim, because a single sample is not evidence.

## Environment

| item | value |
| --- | --- |
| OS | Windows 10.0.26300, NTFS on `E:` (≈327 GB free) |
| CPU | 16 logical cores |
| RAM | 15.3 GiB |
| Node | v22.22.2 |
| npm | 10.9.7 |
| sharp | 0.35.5 |
| libvips | 8.18.7 |
| date | 2026-10-23 |

## Test suite

```
node --test test/unit.test.mjs          30 tests, 30 pass, 0 fail, 288 ms
node --test test/integration.test.mjs   23 tests, 23 pass, 0 fail, 13.6 s
npm test                                53 tests, 53 pass, 0 fail
```

Run three times consecutively with no flakes (`53/53` each time). The integration suite spawns real child processes, sends a real `SIGKILL`, cancels a running batch from a second process, and trips the disk guard through `BATCHPRESS_FAKE_FREE_BYTES`.

### Coverage by group

| group | tests | covers |
| --- | --- | --- |
| unit | 30 | journal append/read/torn-tail/seq continuation, fold state machine, error classification, backoff, task-id stability and separator normalisation, canonical preset signature, disk estimate floor, percentile/byte formatting, atomic write, directory-walk exclusions, report derivation, CSV escaping |
| integration | 23 | idempotent re-run, cross-run byte determinism, retry success/exhaustion/disable, no staging residue, concurrency ceiling, in-flight byte throttling, cancel (pre-existing, in-flight, from another process), resume after cancel, disk reserve pause + resume, `ENOSPC` pause, `kill -9` + resume with adoption, torn journal, `--retry-failed`, per-defect codes, EXIF orientation, nested output layout, report consistency, CLI exit-code contract, `status --json` |

## Concurrency scaling (median of 3)

`node test/scaling.mjs 3` — corpus: 60 images, 480–1400 px, 270 KB total. Each configuration run three times with a 250 ms pause between samples.

| slots | wall (median) | spread | tasks/s | speed-up vs 1 | peak RSS | RSS per slot |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1778 ms | 1722–1803 ms | 33.8 | 1.00× | 83 MB | 83 MB |
| 2 | 963 ms | 945–979 ms | 62.3 | 1.85× | 101 MB | 51 MB |
| **4** | **627 ms** | 602–644 ms | **95.7** | **2.84×** | 146 MB | 37 MB |
| 8 | 647 ms | 624–658 ms | 92.7 | 2.75× | 213 MB | 27 MB |
| 12 | 732 ms | 704–759 ms | 82.0 | 2.43× | 285 MB | 24 MB |

The spread is ±2–4%, so the shape is reproducible: **throughput peaks at 4 slots and degrades beyond it** (8 → −3%, 12 → −14% versus 4), while peak memory keeps climbing (146 → 285 MB). Marginal bits of gain stop well before the core count, which is why the default is 4 and not `os.cpus().length`.

An earlier single-sample bench run showed 8 slots at 30.5 tasks/s versus 4 slots at 32.5 tasks/s; a later single sample showed 37.9 versus 37.3. That inconsistency is exactly why the median table exists — the claim "4 is the knee" rests on the repeated measurement, not on either sample.

## Benchmark by preset (single sample each)

`node test/bench.mjs` — corpus generated deterministically by `test/fixtures.mjs` (seeded PRNG). Two independent generations produced identical aggregate sha256 `6e14653810bcece6…`, so the corpus is reproducible byte for byte. It contains 24 small (64–320 px), 60 medium (480–1400 px) and 14 large (2000–3200 px) images plus 400 copies of one small file, 102.8 MiB total, with noise-and-band content that does not compress away.

| configuration | files | done | failed | in | out | ratio | wall | p50 | p95 | tasks/s | peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small · webp-q80 · c1 | 24 | 24 | 0 | 779 KB | 186 KB | 0.239 | 379 ms | 7 ms | 9 ms | 63.3 | 76 MB |
| small · webp-q80 · c4 | 24 | 24 | 0 | 779 KB | 186 KB | 0.239 | 299 ms | 8 ms | 15 ms | 80.3 | 124 MB |
| medium · webp-q80 · c1 | 60 | 60 | 0 | 36 MB | 9.8 MB | 0.271 | 7541 ms | 108 ms | 211 ms | 8.0 | 121 MB |
| medium · webp-q80 · c2 | 60 | 60 | 0 | 36 MB | 9.8 MB | 0.271 | 2788 ms | 82 ms | 133 ms | 21.5 | 139 MB |
| medium · webp-q80 · c4 | 60 | 60 | 0 | 36 MB | 9.8 MB | 0.271 | 1609 ms | 89 ms | 133 ms | 37.3 | 188 MB |
| medium · webp-q80 · c8 | 60 | 60 | 0 | 36 MB | 9.8 MB | 0.271 | 1584 ms | 159 ms | 207 ms | 37.9 | 267 MB |
| medium · avatar-256 · c4 | 60 | 60 | 0 | 36 MB | 234 KB | 0.006 | 536 ms | 15 ms | 24 ms | 111.9 | 146 MB |
| medium · avif-q55 · c4 | 60 | 60 | 0 | 36 MB | 6.1 MB | 0.169 | 11712 ms | 723 ms | 1267 ms | 5.1 | 332 MB |
| large · webp-q80 · c4 | 14 | 14 | 0 | 66 MB | 17 MB | 0.261 | 3533 ms | 756 ms | 1064 ms | 4.0 | 404 MB |
| many(400) · thumb-128 · c4 | 400 | 400 | 0 | 3.4 MB | 1.2 MB | 0.352 | 1811 ms | 6 ms | 10 ms | 220.9 | 142 MB |

### Observations

1. **The preset, not the input, decides the output size.** `avatar-256` turns 36 MB into 234 KB (ratio 0.006) because output area is bounded by the target. This is why the disk estimator switches formula when a resize is present instead of scaling by input bytes.
2. **AVIF costs 7.3× the wall clock of WebP** (11712 vs 1609 ms) for 0.62× the bytes (6.1 vs 9.8 MB) and 1.8× the RSS. Legitimate for archival; a poor default for a 40,000-file backfill.
3. **Per-task overhead has a floor of about 4–6 ms.** 400 thumbnails in 1811 ms is 4.5 ms each, against a 6 ms p50 — queue, journal, hash and rename are a small share of it; the rest is decoding.
4. **Peak RSS tracks pixel area × slots, not file count.** 404 MB at 4 slots on 2000–3200 px inputs versus 146 MB at 4 slots when outputs are 256 px.
5. **Wall clock on this machine is noisy.** Medium/c1 measured 5724 ms in one run and 7541 ms in another (1.3×); medium/c4 measured 1846 ms and 1609 ms. Treat absolute times as indicative, ratios as the claim.

### Idempotent second pass

```
second pass over medium · webp-q80 · c4: 0 re-encoded · 60 skipped · 93 ms
first pass:                                        1609 ms
```

Re-running a completed batch costs **5.8%** of the original wall clock and writes zero bytes; the work performed is 60 existence checks plus 60 journal appends.

## Operational drills

`node test/drills.mjs` — 48 images at 900×700, real child processes, real signals.

| drill | observed during the event | final outcome | invariants checked |
| --- | --- | --- | --- |
| `SIGKILL` at 1.1 s, then `resume` | done before kill 14/48 · interrupted 1 · adopted 0 | done 48/48 · attempts 49 · exit 0 | 48 outputs on disk (expected 48) · staging remnants 0 · torn journal lines 0 |
| external `cancel`, then `resume` | cancel exit 3 · done 22 · cancelled 26 · status `cancelled` | resume exit 0 · done 48/48 · status `completed` | 48 outputs on disk · 0 tasks left cancelled |
| disk reserve guard (64 MiB free vs 512 MiB reserve) | exit 4 · status `paused` · reason `disk-reserve` · tasks run 0 | after freeing space: exit 0 · done 48/48 | 0 bytes written while paused |
| injected `EBUSY` on every first attempt, `--attempts 3` | exit 0 · done 48/48 · fail 0 · 48 failures journaled retryable | 96 attempts for 48 tasks (1 fault + 1 success each) | 48 outputs, no duplicates · staging empty |
| corrupt input with `--attempts 5` | exit 2 · failed 1 (`EFORMAT`×1) | 49 attempts for 49 tasks · retries 0 | a corrupt file is attempted exactly once |

### Reading the drills

- **49 attempts for 48 tasks after `SIGKILL` is the correct number.** The task in flight when the process died had its staging file purged and was executed again: exactly one redundant attempt, and it published nothing. `adopted 0` means the kill did not land in the rename→journal window in this particular run; that path is asserted separately by the integration test for crash adoption.
- **26 cancelled tasks later completed by `resume`** is the case that was originally broken (cancelled was treated as terminal, stranding 18 of 20 tasks). The report now says `cancelled 26` at the moment of cancellation and `done 48/48` afterwards; both statements are true.
- **The disk guard wrote 0 bytes** while reserving 512 MiB against 64 MiB free: the check precedes dequeue, so the pause precedes any side effect.
- **`EFORMAT` was attempted once despite `--attempts 5`**, which is the retry policy behaving as designed: a text file named `.jpg` will never decode, so four further attempts would only add journal noise and backoff delay.

## Pixel-level verification

`node test/verify-images.mjs` — the machine this was built on cannot display images, so correctness is proven numerically instead of by eye.

Comparing an output against a reference produced by *sharp itself* would be circular. The harness therefore computes the expected image with a hand-written bilinear resampler over raw pixels: centre-crop to the target aspect (what `fit: cover` means), resample, then compare every channel byte against the published file. A wrong crop window, a wrong aspect or a missing EXIF rotation all produce an MAE an order of magnitude larger than the tolerance.

| preset | file | source (oriented) | output | expected | dims ok | MAE vs independent resample | max | output sd | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| avatar-256 | seed-a.jpg | 300x200 | 256x256 | 256x256 | yes | 1.49 | 73 | 73.8 | pass |
| avatar-256 | seed-b.jpg | 173x311 | 256x256 | 256x256 | yes | 1.49 | 69 | 75.9 | pass |
| avatar-256 | seed-c.jpg | 512x512 | 256x256 | 256x256 | yes | 0.93 | 61 | 68.4 | pass |
| avatar-256 | seed-exif6.jpg | 160x240 | 256x256 | 256x256 | yes | 1.04 | 42 | 62.8 | pass |
| thumb-128 | seed-a.jpg | 300x200 | 128x128 | 128x128 | yes | 2.06 | 81 | 73.1 | pass |
| thumb-128 | seed-b.jpg | 173x311 | 128x128 | 128x128 | yes | 1.68 | 50 | 75.5 | pass |
| thumb-128 | seed-c.jpg | 512x512 | 128x128 | 128x128 | yes | 2.44 | 110 | 67.7 | pass |
| thumb-128 | seed-exif6.jpg | 160x240 | 128x128 | 128x128 | yes | 1.03 | 16 | 62.7 | pass |
| webp-q80 | seed-a.jpg | 300x200 | 300x200 | 300x200 | yes | 0.90 | 42 | 73.6 | pass |
| webp-q80 | seed-b.jpg | 173x311 | 173x311 | 173x311 | yes | 0.79 | 29 | 71.1 | pass |
| webp-q80 | seed-c.jpg | 512x512 | 512x512 | 512x512 | yes | 0.54 | 34 | 68.6 | pass |
| webp-q80 | seed-exif6.jpg | 160x240 | 160x240 | 160x240 | yes | 0.95 | 18 | 62.9 | pass |

**12/12 pass.** MAE of 0.5–2.4 comes from lanczos3 (libvips) versus bilinear (reference) ringing on the hard edges of the synthetic seeds; the `max` column shows exactly that, single-edge pixels. The `seed-exif6.jpg` row is the important one: it is stored as 240×160 with orientation 6 and every output is 160×240 or a square crop derived from 160×240 — the rotation is applied before the crop, which is the documented order. `output sd` between 62 and 76 confirms no frame is blank or uniformly filled.

## Reproduction

```bash
npm install
npm test
node test/scaling.mjs 3        # ~1 min; medians of 3 per slot count
node test/bench.mjs            # ~3 min; writes .bench/bench.md
node test/drills.mjs           # ~15 s; writes .drills/drills.md
node test/verify-images.mjs    # ~1 s; pixel-level geometry check
```

Every harness builds its own corpus, so no fixtures ship with this package and nothing depends on files outside it. Absolute numbers will differ on other hardware; the claims the design rests on are the orderings — 4 slots at the knee, AVIF several times slower than WebP, a second pass at a few percent of the first, one redundant attempt after a hard kill.
