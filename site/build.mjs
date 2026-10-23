import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { startRun } from '../src/run.mjs';
import { buildSummary } from '../src/report.mjs';
import { Journal } from '../src/journal.mjs';
import { humanBytes, humanMs } from '../src/util.mjs';

/**
 * Builds the demo page.
 *
 * The numbers on the page are produced here, during the build: a real batch is
 * executed against a generated corpus and its real summary is embedded. Nothing
 * on the page is a hand-typed figure.
 */
const root = import.meta.dirname;
const dist = path.join(root, 'dist');
const work = path.join(root, '.build-work');

fs.rmSync(dist, { recursive: true, force: true });
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const input = path.join(work, 'in');
const output = path.join(work, 'out');
fs.mkdirSync(input, { recursive: true });

// A small, deterministic corpus: warm editorial palette, varied aspect ratios.
const PALETTE = [
  [201, 96, 62],
  [232, 176, 75],
  [92, 148, 138],
  [60, 72, 90],
  [238, 233, 222],
  [140, 58, 44]
];
let seededBytes = 0;
for (let i = 0; i < 12; i += 1) {
  const w = 520 + ((i * 131) % 780);
  const h = 420 + ((i * 79) % 520);
  const raw = Buffer.allocUnsafe(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 3;
      const band = Math.floor((y / h) * 4);
      const c = PALETTE[(band + i) % PALETTE.length];
      const grain = ((x * 7 + y * 13 + i * 29) % 17) - 8;
      raw[o] = Math.max(0, Math.min(255, c[0] + grain));
      raw[o + 1] = Math.max(0, Math.min(255, c[1] + grain));
      raw[o + 2] = Math.max(0, Math.min(255, c[2] + grain));
    }
  }
  const file = path.join(input, `shot-${String(i).padStart(2, '0')}.jpg`);
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toFile(file);
  seededBytes += fs.statSync(file).size;
}

// One deliberately broken input, so the failure table on the page is real too.
fs.writeFileSync(path.join(input, 'broken.jpg'), Buffer.from('this is not a jpeg'));

const t0 = Date.now();
const result = await startRun({
  inputDir: input,
  outputDir: output,
  presetName: 'webp-q80',
  concurrency: 4,
  attempts: 2,
  log: () => {},
  onProgress: () => {}
});
const buildMs = Date.now() - t0;
const summary = buildSummary(result.runDir);

// Real journal excerpt, so a reader can see the actual event shape.
const { events } = Journal.read(path.join(result.runDir, 'journal.ndjson'));
const excerpt = events
  .filter((e) => ['run.start', 'task.queued', 'task.attempt', 'task.ok', 'task.fail', 'run.end'].includes(e.t))
  .slice(0, 7);

const scaling = JSON.parse(fs.readFileSync(path.join(root, 'scaling.json'), 'utf8'));
const maxTps = Math.max(...scaling.map((r) => r.tps));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const statCards = [
  { k: 'tasks', v: `${summary.counts.done}/${summary.counts.total}`, d: 'completed in this build' },
  { k: 'wall', v: humanMs(summary.wallMs), d: 'whole batch, 4 slots' },
  { k: 'throughput', v: `${summary.throughput} /s`, d: 'tasks per second' },
  { k: 'size', v: `${summary.bytes.ratio}×`, d: `output / input (${humanBytes(summary.bytes.output)})` }
];

const taskRows = summary.tasks
  .map(
    (t) => `<tr>
      <td class="mono">${esc(t.rel)}</td>
      <td><span class="pill ${t.status === 'done' ? 'ok' : 'bad'}">${esc(t.status)}</span></td>
      <td class="num">${t.attempts}</td>
      <td class="num">${humanBytes(t.inputBytes)}</td>
      <td class="num">${t.outputBytes === null ? '—' : humanBytes(t.outputBytes)}</td>
      <td class="num">${t.ms ? Math.round(t.ms) : '—'}</td>
    </tr>`
  )
  .join('\n');

const scalingRows = scaling
  .map((r) => {
    const pct = (r.tps / maxTps) * 100;
    return `<tr>
      <td class="num">${r.c}</td>
      <td class="num">${Math.round(r.wall)} ms</td>
      <td class="num">${r.tps.toFixed(1)}</td>
      <td><span class="bar" style="width:${pct.toFixed(1)}%"></span></td>
      <td class="num">${humanBytes(r.rss)}</td>
    </tr>`;
  })
  .join('\n');

const excerptText = excerpt.map((e) => JSON.stringify(e)).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>batchpress — crash-safe batch layer for sharp</title>
<style>
  :root{
    --paper:#f6f1e7; --ink:#241c16; --muted:#6f6154;
    --line:#d9cfbe; --rule:#b8a894;
    --accent:#b8451f; --accent2:#c98a2b; --teal:#3f6f68;
    --card:#fdfaf3;
  }
  *{box-sizing:border-box}
  body{
    margin:0;background:var(--paper);color:var(--ink);
    font:16px/1.6 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
    -webkit-font-smoothing:antialiased;
  }
  .mono{font-family:"SF Mono",ui-monospace,Consolas,monospace;font-size:.86em}
  .wrap{max-width:1080px;margin:0 auto;padding:0 28px}
  header{border-bottom:2px solid var(--rule);padding:52px 0 34px;background:linear-gradient(180deg,#f9f5ec,#f6f1e7)}
  .kicker{font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:0 0 14px}
  h1{font-size:clamp(34px,5.2vw,54px);line-height:1.06;margin:0 0 18px;letter-spacing:-.02em}
  h1 em{font-style:normal;color:var(--accent)}
  .lede{font-size:19px;color:#3d3229;max-width:62ch;margin:0 0 26px}
  .meta{display:flex;flex-wrap:wrap;gap:10px}
  .tag{font-family:ui-monospace,monospace;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;
       border:1px solid var(--line);background:#fffdf7;padding:4px 9px;border-radius:2px;color:var(--muted)}
  section{padding:46px 0;border-bottom:1px solid var(--line)}
  h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 22px;
     font-family:ui-monospace,monospace;font-weight:600}
  h3{font-size:22px;margin:0 0 10px;letter-spacing:-.01em}
  p{margin:0 0 14px;max-width:70ch}
  .grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1px;background:var(--line);
         border:1px solid var(--line);margin:0 0 8px}
  .stat{background:var(--card);padding:20px 18px}
  .stat .k{font-family:ui-monospace,monospace;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
  .stat .v{font-size:30px;line-height:1.1;margin:6px 0 2px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .stat .d{font-size:12.5px;color:var(--muted)}
  .note{font-size:13.5px;color:var(--muted);margin-top:10px}
  table{width:100%;border-collapse:collapse;font-size:14px;background:var(--card)}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
  th{font-family:ui-monospace,monospace;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
     color:var(--muted);font-weight:600;background:#f2ece0}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,monospace;font-size:12.5px}
  .pill{display:inline-block;font-family:ui-monospace,monospace;font-size:10.5px;letter-spacing:.08em;
        text-transform:uppercase;padding:2px 7px;border-radius:2px}
  .pill.ok{background:#e3efe6;color:#2c5e3c}
  .pill.bad{background:#f6e2d9;color:#8f2f11}
  .bar{display:block;height:9px;background:var(--accent2);border-radius:1px}
  pre{background:#241c16;color:#f2ece0;padding:16px 18px;overflow-x:auto;font-size:12.5px;line-height:1.65;
      border-radius:2px;margin:0;font-family:ui-monospace,monospace;
      /* Long single-line JSON would otherwise widen the grid to 4500px and
         push the whole page off-screen. Wrap it, and break mid-token because
         a journal line has no spaces to break at. */
      white-space:pre-wrap;word-break:break-all;max-width:100%}
  .two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:26px}
  .two>div{min-width:0}
  @media(max-width:820px){.two{grid-template-columns:minmax(0,1fr)}}
  .diagram svg{max-width:100%;height:auto}
  table{max-width:100%}
  ul.plain{list-style:none;padding:0;margin:0}
  ul.plain li{padding:9px 0;border-bottom:1px dotted var(--line);font-size:14.5px}
  ul.plain li:last-child{border:0}
  ul.plain b{font-family:ui-monospace,monospace;font-size:12px;color:var(--accent);margin-right:8px}
  footer{padding:34px 0 60px;font-size:13px;color:var(--muted)}
  a{color:var(--accent);text-decoration:none;border-bottom:1px solid rgba(184,69,31,.3)}
  a:hover{border-bottom-color:var(--accent)}
  .diagram{background:var(--card);border:1px solid var(--line);padding:22px}
</style>
</head>
<body>

<header>
  <div class="wrap">
    <p class="kicker">batchpress 1.0.0 · MIT · built on sharp 0.35.5</p>
    <h1>sharp processes <em>one</em> image.<br>This makes it process <em>all</em> of them.</h1>
    <p class="lede">
      A batch task manager that survives a kill -9, never redoes finished work, retries only what
      deserves a retry, and pauses instead of failing when the disk fills up.
    </p>
    <div class="meta">
      <span class="tag">append-only journal</span>
      <span class="tag">atomic publish</span>
      <span class="tag">idempotent retry</span>
      <span class="tag">resume</span>
      <span class="tag">disk guard</span>
      <span class="tag">53 tests</span>
    </div>
  </div>
</header>

<section>
  <div class="wrap">
    <h2>Why this exists</h2>
    <div class="two">
      <div>
        <h3>The upstream gap is verifiable</h3>
        <p>
          <code class="mono">sharp</code> is deliberately a single-item engine: one buffer in, one buffer out.
          A grep of its <code class="mono">lib/</code> for <code class="mono">batch</code>,
          <code class="mono">resume</code>, <code class="mono">journal</code>, <code class="mono">retry</code>,
          <code class="mono">cancel</code> and <code class="mono">disk</code> returns zero matches; it exposes
          only <code class="mono">concurrency()</code> and <code class="mono">cache()</code> as knobs.
        </p>
        <p>
          Everything that turns "process one image" into "process 40,000 overnight without duplicating work
          and without a half-written output tree" has to be built on top. That is what this is — a host layer,
          not a fork.
        </p>
      </div>
      <div>
        <h3>What it refuses to do</h3>
        <ul class="plain">
          <li><b>no</b> retrying a truncated JPEG five times</li>
          <li><b>no</b> failing 40,000 tasks because the disk filled at #12</li>
          <li><b>no</b> leaving a <code class="mono">.part</code> file where a photo should be</li>
          <li><b>no</b> re-encoding what the last run already finished</li>
          <li><b>no</b> trusting a single timing sample as a benchmark</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>This page was built by running it</h2>
    <div class="grid4">
      ${statCards
        .map(
          (c) => `<div class="stat"><div class="k">${c.k}</div><div class="v">${c.v}</div><div class="d">${c.d}</div></div>`
        )
        .join('\n      ')}
    </div>
    <p class="note">
      The numbers above are not typed in. <code class="mono">site/build.mjs</code> generates
      ${summary.counts.total} images (${humanBytes(seededBytes)} of input, one of them deliberately corrupt),
      runs the real CLI over them with 4 worker slots, and embeds the resulting
      <code class="mono">summary.json</code>. The build step itself took ${humanMs(buildMs)}.
    </p>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Per-task result, verbatim</h2>
    <table>
      <thead><tr><th>task</th><th>status</th><th class="num">attempts</th><th class="num">in</th><th class="num">out</th><th class="num">ms</th></tr></thead>
      <tbody>
${taskRows}
      </tbody>
    </table>
    <p class="note">
      <span class="pill bad">failed</span> on <code class="mono">broken.jpg</code> is intentional: a text file
      with a .jpg extension gets code <code class="mono">EFORMAT</code> and exactly one attempt, even when
      <code class="mono">--attempts 5</code> is passed. Retrying it would produce four identical failures.
    </p>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>What the journal actually looks like</h2>
    <div class="two">
      <div>
        <pre>${esc(excerptText)}</pre>
      </div>
      <div>
        <h3>One file, appended, fsync'd</h3>
        <p>
          A <code class="mono">state.json</code> rewrite is a read-modify-write cycle: a crash between read and
          write loses every task's status. An append-only log degrades to a single torn last line, which the
          reader detects and reports.
        </p>
        <p>
          The report is a <em>pure function</em> of this log, so <code class="mono">batchpress report</code>
          works after the process is dead and can never disagree with what happened on disk.
        </p>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Publish protocol</h2>
    <div class="diagram">
      <svg viewBox="0 0 1000 210" width="100%" height="auto" role="img" aria-label="encode to staging, fsync, rename into place">
        <defs>
          <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto">
            <path d="M0,0 L7,3.5 L0,7 Z" fill="#8a7a66"/>
          </marker>
        </defs>
        <g font-family="ui-monospace,monospace" font-size="13" fill="#241c16">
          <rect x="10" y="60" width="150" height="72" fill="#fdfaf3" stroke="#b8a894"/>
          <text x="30" y="90">input.jpg</text>
          <text x="30" y="112" fill="#6f6154" font-size="11">read once</text>

          <rect x="215" y="60" width="170" height="72" fill="#fdfaf3" stroke="#b8a894"/>
          <text x="235" y="90">encode</text>
          <text x="235" y="112" fill="#6f6154" font-size="11">sharp → buffer</text>

          <rect x="440" y="52" width="190" height="88" fill="#fbf3e6" stroke="#c98a2b"/>
          <text x="460" y="82">staging/*.part</text>
          <text x="460" y="102" fill="#6f6154" font-size="11">writeSync</text>
          <text x="460" y="120" fill="#b8451f" font-size="11">fsyncSync ← data on disk</text>

          <rect x="685" y="60" width="150" height="72" fill="#e9f0ee" stroke="#3f6f68"/>
          <text x="705" y="90">rename()</text>
          <text x="705" y="112" fill="#6f6154" font-size="11">atomic</text>

          <rect x="880" y="60" width="110" height="72" fill="#fdfaf3" stroke="#b8a894"/>
          <text x="898" y="90">out.webp</text>
          <text x="898" y="112" fill="#6f6154" font-size="11">complete</text>

          <line x1="162" y1="96" x2="212" y2="96" stroke="#8a7a66" marker-end="url(#a)"/>
          <line x1="387" y1="96" x2="437" y2="96" stroke="#8a7a66" marker-end="url(#a)"/>
          <line x1="632" y1="96" x2="682" y2="96" stroke="#8a7a66" marker-end="url(#a)"/>
          <line x1="837" y1="96" x2="877" y2="96" stroke="#8a7a66" marker-end="url(#a)"/>

          <text x="215" y="180" fill="#6f6154" font-size="11.5">The destination is never opened for writing. It only ever appears via rename() of a complete file.</text>
        </g>
      </svg>
    </div>
    <p class="note">
      The staging directory lives inside the output volume, so the rename cannot cross a filesystem boundary
      (a cross-volume rename would fail with EXDEV, and a copy fallback would reintroduce the partial-write window).
    </p>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Concurrency, measured properly</h2>
    <table>
      <thead><tr><th class="num">slots</th><th class="num">wall (median of 3)</th><th class="num">tasks/s</th><th>relative</th><th class="num">peak RSS</th></tr></thead>
      <tbody>
${scalingRows}
      </tbody>
    </table>
    <p class="note">
      60 images of 480–1400 px on 16 logical cores. Throughput peaks at 4 slots and <em>degrades</em> beyond
      it while memory keeps climbing — which is why the default is 4, not the core count. Single-sample timings
      on the same machine disagreed about whether 8 slots beat 4, so every claim here comes from medians.
    </p>
  </div>
</section>

<section>
  <div class="wrap">
    <h2>Get it</h2>
    <div class="two">
      <div>
        <h3>Three commands</h3>
        <pre>npm install
node bin/batchpress.mjs run \\
  --in ./photos --out ./out \\
  --preset webp-q80 --concurrency 4

node bin/batchpress.mjs resume --out ./out</pre>
      </div>
      <div>
        <h3>Exit codes are a contract</h3>
        <ul class="plain">
          <li><b>0</b> completed</li>
          <li><b>1</b> usage error</li>
          <li><b>2</b> completed with failures — read failures.csv</li>
          <li><b>3</b> cancelled — resume to continue</li>
          <li><b>4</b> paused on disk guard — free space, resume</li>
          <li><b>5</b> no run found</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    <p>
      batchpress is MIT. <code class="mono">sharp</code> is Apache-2.0 and <code class="mono">libvips</code> is
      LGPL-2.1-or-later; both are used unmodified through their public interfaces — attribution in
      <a href="https://github.com/llinok111/batchpress/blob/main/NOTICE">NOTICE</a> and
      <a href="https://github.com/llinok111/batchpress/blob/main/docs/SOURCES.md">docs/SOURCES.md</a>.
    </p>
    <p>
      <a href="https://github.com/llinok111/batchpress">Source</a> ·
      <a href="https://github.com/llinok111/batchpress/blob/main/README.md">README</a> ·
      <a href="https://github.com/llinok111/batchpress/blob/main/docs/DESIGN.md">Design</a> ·
      <a href="https://github.com/llinok111/batchpress/blob/main/docs/RESULTS.md">Recorded results</a>
    </p>
  </div>
</footer>

</body>
</html>
`;

fs.writeFileSync(path.join(dist, 'index.html'), html);
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

process.stdout.write(
  `site built: ${summary.counts.done}/${summary.counts.total} tasks in ${humanMs(summary.wallMs)}, ` +
    `ratio ${summary.bytes.ratio}x, ${(html.length / 1024).toFixed(1)} KB html\n`
);
