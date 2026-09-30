#!/usr/bin/env node
// Visual-QA harness for AXIOM. Drives the engine through window.__axiom (docs/DESIGN.md §5),
// writes screenshots + contact sheets, and exits 1 on any console/page error or failed check.
//
//   node scripts/shots.mjs [--mode grid|sweep|sensors|gate|variants|hero|all] [--desktop] [--v a,b]
//        [--n 65536] [--seed 1] [--frames 180] [--query "k=v&k=v"] [--out dir]
//        [--url base | --port 5172]
//
//   all      = grid, sweep, sensors, gate (any mode list may be comma-separated)
//   variants = matrix sheet, rows = every --v id (required), columns = 7 fixed positions
//   hero     = per --v id, three phone stills at 430x932 @2x plus a triptych (slow;
//              defaults n=262144, frames=300)
//
// Logs go to stderr; the final JSON summary goes to stdout (and <out>/summary.json).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// createRequire rather than `import` so NODE_PATH can supply playwright when node_modules is absent.
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: a } = parseArgs({
  options: {
    url: { type: 'string' },
    port: { type: 'string', default: '5172' },
    out: { type: 'string' },
    v: { type: 'string' },
    n: { type: 'string' },
    seed: { type: 'string', default: '1' },
    frames: { type: 'string' },
    query: { type: 'string' },
    desktop: { type: 'boolean', default: false },
    mode: { type: 'string', default: 'all' },
    sheet: { type: 'string' },
  },
});
const ALL_MODES = ['grid', 'sweep', 'sensors', 'gate'];
const MODE_NAMES = [...ALL_MODES, 'variants', 'hero'];
const modes = a.mode === 'all' ? ALL_MODES : a.mode.split(',');
const die = (msg) => (console.error(msg), process.exit(2));
const badMode = modes.find((m) => !MODE_NAMES.includes(m));
if (badMode) die(`unknown --mode ${badMode} (${MODE_NAMES.join('|')}|all, comma-separated)`);
if (modes.includes('variants') && !a.v) die('--mode variants needs --v id,id,...');
const OPT = {
  seed: Number(a.seed),
  desktop: a.desktop,
  variants: a.v ? a.v.split(',').filter(Boolean) : [null],
  modes,
  out: a.out
    ? resolve(a.out)
    : join(ROOT, 'shots', new Date().toISOString().slice(0, 19).replace(/:/g, '-')),
};

const GPU_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--enable-unsafe-swiftshader',
];
// Without the bundled SwiftShader Vulkan ICD the GPU process cannot create swap-chain shared images
// and canvas.getCurrentTexture() fails with "A valid external Instance reference no longer exists".
const ICD = join(dirname(chromium.executablePath()), 'vk_swiftshader_icd.json');
const GPU_ENV =
  existsSync(ICD) && !process.env.VK_ICD_FILENAMES
    ? { ...process.env, VK_ICD_FILENAMES: ICD }
    : process.env;
// Per-mode defaults; explicit flags always win. `variants` skips the expensive map warm-up.
const MODE_DEFAULTS = {
  hero: { n: 262144, frames: 300 },
  variants: { query: 'mapn=32' },
};
const cfg = (mode) => ({
  n: Number(a.n ?? MODE_DEFAULTS[mode]?.n ?? 65536),
  frames: Number(a.frames ?? MODE_DEFAULTS[mode]?.frames ?? 180),
  query: (a.query ?? MODE_DEFAULTS[mode]?.query ?? '').replace(/^[?&]+/, ''),
});
const sheetWidth = (dflt) => Number(a.sheet ?? dflt);
const PHONE = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
};
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const HERO = {
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};
const REGIMES = ['fixed', 'cycle', 'torus', 'strange', 'labyrinth'];
const STEP_TIMEOUT = 600_000;
const log = (...m) => console.error(...m);
const f2 = (x) =>
  typeof x === 'number' && Number.isFinite(x) ? (Math.abs(x) < 0.005 ? 0 : x).toFixed(2) : '–';
const median = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];

// ---- issue + check bookkeeping ---------------------------------------------------------------
const issues = new Map(); // "mode|kind|text" -> {mode, kind, text, count}
let issueTotal = 0;
const checks = []; // {mode, name, ok, detail}
const warnings = []; // judgement calls for the human: logged and summarised, never fatal

function warn(mode, text) {
  warnings.push(`[${mode}] ${text}`);
  log(`  ** ${text}`);
}

// Only ink-black background lit above threshold in < 0.01 % of pixels: probably a blank frame.
const warnIfBlank = (mode, name, stats) =>
  stats.lit < 1e-4 && warn(mode, `near-blank frame: ${name}`);

function report(mode, kind, text) {
  issueTotal++;
  const key = `${mode}|${kind}|${text}`;
  const hit = issues.get(key);
  if (hit) return void hit.count++;
  issues.set(key, { mode, kind, text: text.slice(0, 500), count: 1 });
  log(`  !! [${mode}] ${kind}: ${text.slice(0, 300)}`);
}

function check(mode, name, ok, detail = '') {
  checks.push({ mode, name, ok: Boolean(ok), detail });
  log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  return ok;
}

// ---- dev server ------------------------------------------------------------------------------
async function startServer() {
  if (a.url) return { base: a.url, stop() {} };
  const child = spawn('npx', ['vite', '--port', a.port, '--strictPort'], {
    cwd: ROOT,
    detached: true, // own process group, so the whole npx -> vite tree can be killed
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  };
  process.on('exit', stop);
  let text = '';
  const base = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`vite not ready after 60 s\n${text}`)), 60_000);
    const onData = (d) => {
      text += String(d).replace(/\x1b\[[0-9;]*m/g, '');
      const m = text.match(/Local:\s+(http:\/\/\S+)/); // honours a non-root `base` in vite config
      if (m) (clearTimeout(timer), ok(m[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', fail);
    child.on(
      'exit',
      (code) => (clearTimeout(timer), fail(new Error(`vite exited (${code})\n${text}`))),
    );
  }).catch((e) => (stop(), Promise.reject(e)));
  for (let i = 0; i < 50; i++) {
    if (
      await fetch(base).then(
        (r) => r.ok,
        () => false,
      )
    )
      return { base, stop };
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
  throw new Error(`${base} never responded`);
}

// ---- browser + page plumbing -----------------------------------------------------------------
const withTimeout = (p, ms, label) => {
  let t;
  const late = new Promise(
    (_, no) => (t = setTimeout(() => no(new Error(`timeout ${ms} ms: ${label}`)), ms)),
  );
  return Promise.race([p, late]).finally(() => clearTimeout(t));
};
const hook = (page, name, ...args) =>
  withTimeout(
    page.evaluate(([n, xs]) => window.__axiom[n](...xs), [name, args]),
    STEP_TIMEOUT,
    `__axiom.${name}`,
  );
const evalT = (page, fn, arg, label) => withTimeout(page.evaluate(fn, arg), STEP_TIMEOUT, label);

const removeGpu = () => {
  delete Navigator.prototype.gpu;
  if ('gpu' in navigator)
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
};

function pageUrl(base, v, { gate, n, query }) {
  const q = [...(gate ? [] : ['skipintro', 'capture']), `n=${n}`, `seed=${OPT.seed}`];
  if (v) q.push(`v=${v}`);
  if (query) q.push(query);
  return new URL(`?${q.join('&')}`, base).href;
}

// Runs fn(page, ctx) in a fresh, instrumented context (phone by default) and always closes it.
// opts: {n, query} from cfg(), plus gate / gpu / ready / device.
async function withPage(browser, base, label, v, opts, fn) {
  const { gpu = true, ready = true, device = OPT.desktop ? DESKTOP : PHONE } = opts;
  const ctx = await browser.newContext(device);
  try {
    if (!gpu) await ctx.addInitScript(removeGpu);
    // Mock every WebSocket (never connected): vite's HMR client would otherwise reload the page
    // whenever someone edits a source file mid-run, destroying the execution context.
    await ctx.routeWebSocket(/.*/, () => {});
    const page = await ctx.newPage();
    let loads = 0;
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame() && ++loads > 1) warn(label, `page navigated again: ${f.url()}`);
    });
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon\.ico/.test(m.location().url ?? ''))
        report(label, 'console.error', m.text());
    });
    let abort;
    const crashed = new Promise((_, no) => (abort = no));
    crashed.catch(() => {}); // only consumed while waiting for `ready`
    page.on('pageerror', (e) => {
      report(label, 'pageerror', e.message);
      abort(new Error(`page error: ${e.message}`));
    });
    page.on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? 'failed';
      if (!why.includes('ERR_ABORTED')) report(label, 'requestfailed', `${r.url()} ${why}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !r.url().endsWith('/favicon.ico'))
        report(label, `http ${r.status()}`, r.url());
    });
    await page.goto(pageUrl(base, v, opts), { waitUntil: 'load' });
    if (ready) {
      const booted = page.waitForFunction(() => window.__axiom?.ready === true, null, {
        timeout: 180_000,
        polling: 250,
      });
      booted.catch(() => {}); // when a page error wins the race below, this one is abandoned
      await Promise.race([booted, crashed]); // fail fast instead of waiting out the timeout
    }
    return await fn(page, ctx);
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ---- image tooling: everything runs in a scratch page, so no Node image dependencies ----------
// For each PNG: mean luma, fraction of lit pixels, and mean |Δ| (0..255 over RGB) vs. the previous.
async function analyze(tool, pngs) {
  return evalT(
    tool,
    async (b64s) => {
      const out = [];
      let prev = null;
      for (const b64 of b64s) {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', {
          willReadFrequently: true,
        });
        g.drawImage(bmp, 0, 0);
        const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
        let luma = 0,
          lit = 0,
          diff = 0;
        for (let i = 0; i < px.length; i += 4) {
          const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          luma += y;
          if (y > 24) lit++;
          if (prev)
            diff +=
              Math.abs(px[i] - prev[i]) +
              Math.abs(px[i + 1] - prev[i + 1]) +
              Math.abs(px[i + 2] - prev[i + 2]);
        }
        const n = px.length / 4;
        out.push({ luma: luma / n / 255, lit: lit / n, diff: prev ? diff / (n * 3) : null });
        prev = px;
      }
      return out;
    },
    pngs.map((b) => b.toString('base64')),
    'analyze',
  );
}

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// cells: [{png: Buffer, label: string, flag?: bool}] laid out row-major in `cols` columns.
// Optional `head` (column labels) and `side` (row labels) turn it into a labelled matrix.
async function contactSheet(
  tool,
  file,
  { title, cols, cells, footer = '', width = 1200, head, side },
) {
  const gap = 10;
  const sideW = side ? 96 : 0;
  const cellW = Math.floor((width - 24 - sideW - (cols - (side ? 0 : 1)) * gap) / cols);
  const fig = (c) =>
    `<figure class="${c.flag ? 'flag' : ''}"><img src="data:image/png;base64,${c.png.toString('base64')}"><figcaption>${esc(c.label)}</figcaption></figure>`;
  const items = head
    ? [...(side ? ['<div></div>'] : []), ...head.map((h) => `<div class="h">${esc(h)}</div>`)]
    : [];
  for (let r = 0; r * cols < cells.length; r++) {
    if (side) items.push(`<div class="h">${esc(side[r])}</div>`);
    items.push(...cells.slice(r * cols, (r + 1) * cols).map(fig));
  }
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:12px;background:#05060a;color:#9aa0b0;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace}
    h1{margin:0 0 10px;font:600 12px/1 system-ui,sans-serif;letter-spacing:.06em;color:#dfe3ee}
    .g{display:grid;grid-template-columns:${side ? `${sideW}px ` : ''}repeat(${cols},${cellW}px);gap:${gap}px}
    figure{margin:0}img{display:block;width:${cellW}px;height:auto;outline:1px solid #1b1e28}
    figcaption{padding:4px 0 0;white-space:pre}.flag figcaption{color:#ff6b5e}svg{display:block;margin-top:12px}
    .h{white-space:pre;color:#dfe3ee;padding-top:2px}
  </style><h1>${esc(title)}</h1><div class="g">${items.join('')}</div>${footer}`;
  await tool.setViewportSize({ width, height: 200 });
  await tool.setContent(html);
  await tool.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  await tool.screenshot({ path: file, fullPage: true });
  return file;
}

function diffChart(diffs, threshold, width) {
  const h = 56;
  const max = Math.max(...diffs, threshold * 1.1, 1e-9);
  const bw = width / diffs.length;
  const bars = diffs
    .map(
      (d, i) =>
        `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - (h * d) / max).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${((h * d) / max).toFixed(1)}" fill="${d > threshold ? '#ff6b5e' : '#5b8def'}"/>`,
    )
    .join('');
  const y = (h - (h * threshold) / max).toFixed(1);
  return `<svg width="${width}" height="${h + 4}"><line x1="0" x2="${width}" y1="${y}" y2="${y}" stroke="#7a8090" stroke-dasharray="4 3"/>${bars}</svg>`;
}

// ---- modes -----------------------------------------------------------------------------------
// The 3x3 grid is laid out like the disk itself: row 0 = v>0, col 2 = u>0.
const DISK = [{ name: 'center', u: 0, v: 0, r: 0, row: 1, col: 1 }];
for (const [r, offset] of [
  [0.45, 0],
  [0.9, 45],
]) {
  for (let k = 0; k < 4; k++) {
    const deg = offset + 90 * k;
    const [c, s] = [Math.cos, Math.sin].map((fn) => fn((deg * Math.PI) / 180));
    const sgn = (x) => Math.sign(Math.round(x * 1e6));
    DISK.push({
      name: `r${r}_a${String(deg).padStart(3, '0')}`,
      u: r * c,
      v: r * s,
      r,
      row: 1 - sgn(s),
      col: 1 + sgn(c),
    });
  }
}

const CAMERAS = [
  { name: 'default', set: null },
  { name: 'dive', set: { dive: 0.7 } },
];

async function grid(ctxs, v, pre) {
  const { browser, base, tool, out } = ctxs;
  const C = cfg('grid');
  return withPage(browser, base, `grid${v ? `[${v}]` : ''}`, v, C, async (page) => {
    const res = { sheets: [], shots: [] };
    for (const cam of CAMERAS) {
      if (cam.set) await hook(page, 'setCamera', cam.set);
      const cells = [];
      for (const p of DISK) {
        await hook(page, 'setBead', p.u, p.v);
        await hook(page, 'step', C.frames);
        const s = await hook(page, 'stats');
        const file = join(out, `${pre}grid_${cam.name}_${p.name}.png`);
        cells.push({ ...p, s, file, png: await page.screenshot({ path: file }) });
        log(
          `  ${cam.name} ${p.name} u=${f2(s.bead?.[0])} v=${f2(s.bead?.[1])} regime=${s.regime} D=${f2(s.dky)}`,
        );
      }
      const an = await analyze(
        tool,
        cells.map((c) => c.png),
      );
      cells.forEach((c, i) => {
        c.stats = { ...an[i], diff: undefined };
        warnIfBlank('grid', `${cam.name} ${c.name}`, an[i]);
      });
      const sorted = [...cells].sort((p, q) => p.row - q.row || p.col - q.col);
      const sheet = await contactSheet(tool, join(out, `${pre}grid_${cam.name}.png`), {
        width: sheetWidth(1200),
        title: `axiom grid · ${cam.name} · n=${C.n} seed=${OPT.seed} frames=${C.frames}${v ? ` · v=${v}` : ''}`,
        cols: 3,
        cells: sorted.map((c) => ({
          png: c.png,
          label: `(u ${f2(c.s.bead?.[0] ?? c.u)}, v ${f2(c.s.bead?.[1] ?? c.v)})  r ${c.r}\n${REGIMES[c.s.regime] ?? '–'}  D ${f2(c.s.dky)}  lum ${f2(c.stats.luma)}`,
        })),
      });
      res.sheets.push(sheet);
      res.shots.push(
        ...cells.map(
          (c) =>
            `${cam.name} ${c.name}: u ${f2(c.s.bead?.[0])} v ${f2(c.s.bead?.[1])} ${REGIMES[c.s.regime] ?? '–'} D ${f2(c.s.dky)} lum ${f2(c.stats.luma)}`,
        ),
      );
    }
    return res;
  });
}

async function sweep(ctxs, v, pre) {
  const { browser, base, tool, out } = ctxs;
  const STEPS = 32,
    PER_STEP = 30,
    U0 = -0.95,
    U1 = 0.95;
  const C = cfg('sweep');
  return withPage(browser, base, `sweep${v ? `[${v}]` : ''}`, v, C, async (page) => {
    await hook(page, 'setBead', U0, 0);
    await hook(page, 'step', C.frames); // settle so step 0 is comparable with step 1
    const frames = [];
    for (let i = 0; i < STEPS; i++) {
      const u = U0 + ((U1 - U0) * i) / (STEPS - 1);
      await hook(page, 'setBead', u, 0);
      await hook(page, 'step', PER_STEP);
      const s = await hook(page, 'stats');
      const file = join(out, `${pre}sweep_${String(i).padStart(2, '0')}.png`);
      frames.push({ u, s, png: await page.screenshot({ path: file }) });
      if (i % 8 === 7) log(`  sweep ${i + 1}/${STEPS}`);
    }
    const an = await analyze(
      tool,
      frames.map((f) => f.png),
    );
    const diffs = an.slice(1).map((x) => x.diff);
    const med = median(diffs);
    const threshold = Math.max(3 * med, 0.25); // floor: a near-static scene has a ~0 median
    const flagged = diffs.map((d, i) => (d > threshold ? i + 1 : null)).filter((i) => i !== null);
    log(`  Δ series: ${diffs.map((d) => d.toFixed(2)).join(' ')}`);
    log(
      `  median ${med.toFixed(3)}  max ${Math.max(...diffs).toFixed(3)}  flagged steps: ${flagged.join(', ') || 'none'}`,
    );
    an.forEach((x, i) => warnIfBlank('sweep', `step ${i}`, x));
    if (flagged.length)
      warn('sweep', `POTENTIAL DISCONTINUITY at step(s) ${flagged.join(', ')} (Δ > 3x median)`);
    const filmstrip = await contactSheet(tool, join(out, `${pre}sweep_filmstrip.png`), {
      width: sheetWidth(1200),
      title: `axiom sweep · u ${U0} → ${U1}, v 0 · ${PER_STEP} frames/step · median Δ ${med.toFixed(2)} · red = Δ > 3x median${v ? ` · v=${v}` : ''}`,
      cols: 8,
      cells: frames.map((f, i) => ({
        png: f.png,
        flag: flagged.includes(i),
        label: `#${String(i).padStart(2, '0')} u ${f2(f.u)}\n${i ? `Δ ${diffs[i - 1].toFixed(2)}` : 'Δ –'} ${REGIMES[f.s.regime] ?? ''}`,
      })),
      footer: diffChart(diffs, threshold, sheetWidth(1200) - 24),
    });
    return {
      filmstrip,
      median: +med.toFixed(3),
      max: +Math.max(...diffs).toFixed(3),
      flagged,
      diffs: diffs.map((d) => +d.toFixed(3)),
    };
  });
}

async function sensors(ctxs, v, pre) {
  const { browser, base, out } = ctxs;
  const label = `sensors${v ? `[${v}]` : ''}`;
  return withPage(browser, base, label, v, cfg('sensors'), async (page, ctx) => {
    const bead = async () => (await hook(page, 'stats')).bead;
    const shot = (name) => page.screenshot({ path: join(out, `${pre}sensors_${name}.png`) });
    // One deviceorientation event per frame, as a real device would deliver.
    const orient = (beta, gamma, frames) =>
      evalT(
        page,
        async ([b, g, n]) => {
          for (let i = 0; i < n; i++) {
            window.dispatchEvent(
              new DeviceOrientationEvent('deviceorientation', {
                alpha: 0,
                beta: b,
                gamma: g,
                absolute: false,
              }),
            );
            await window.__axiom.step(1);
          }
        },
        [beta, gamma, frames],
        'orientation',
      );
    const noNewIssues = async (name, fn) => {
      const before = issueTotal;
      await fn();
      const s = await hook(page, 'stats');
      return check(
        label,
        name,
        issueTotal === before && s.particles > 0 && s.bead.every(Number.isFinite),
        `${issueTotal - before} new errors`,
      );
    };

    await hook(page, 'setBead', 0, 0);
    await orient(40, 0, 20); // rest pose
    const b0 = await bead();
    await orient(40, 20, 120); // right edge tilted down
    const b1 = await bead();
    await shot('tilt_gamma');
    check(label, 'gamma +20 moves bead +u', b1[0] > b0[0], `u ${f2(b0[0])} -> ${f2(b1[0])}`);

    await hook(page, 'setBead', 0, 0);
    await orient(40, 0, 40); // back to rest
    const b2 = await bead();
    await orient(25, 0, 120); // top tilted away
    const b3 = await bead();
    await shot('tilt_beta');
    check(label, 'beta 40->25 moves bead +v', b3[1] > b2[1], `v ${f2(b2[1])} -> ${f2(b3[1])}`);

    await orient(40, 0, 20);
    await noNewIssues('devicemotion shake burst', async () => {
      await evalT(
        page,
        async () => {
          for (let i = 0; i < 8; i++) {
            const s = i % 2 ? -1 : 1;
            window.dispatchEvent(
              new DeviceMotionEvent('devicemotion', {
                acceleration: { x: 25 * s, y: 0, z: 0 },
                accelerationIncludingGravity: { x: 25 * s, y: 0, z: 9.81 },
                rotationRate: { alpha: 0, beta: 0, gamma: 0 },
                interval: 16,
              }),
            );
            await window.__axiom.step(1);
          }
          await window.__axiom.step(8);
        },
        null,
        'shake',
      );
      await shot('shake');
    });

    // Touch through CDP so pointer/touch events take the same path as a real finger.
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
      });
    const { width: w, height: h } = page.viewportSize();

    await noNewIssues('touch hold >= 400 ms (dive)', async () => {
      await touch('touchStart', w / 2, h / 2);
      const t0 = Date.now();
      for (let f = 0; Date.now() - t0 < 900 || f < 60; f += 6) await hook(page, 'step', 6);
      await shot('hold');
      await touch('touchEnd');
      await hook(page, 'step', 30);
    });

    await noNewIssues('touch drag (stir)', async () => {
      await touch('touchStart', w * 0.3, h * 0.5);
      for (let i = 1; i <= 14; i++) {
        await touch('touchMove', w * (0.3 + (0.4 * i) / 14), h * (0.5 + 0.08 * Math.sin(i / 2)));
        await hook(page, 'step', 4);
        if (i === 8) await shot('drag');
      }
      await touch('touchEnd');
      await hook(page, 'step', 20);
    });
    return { bead: { rest: b0, gamma: b1, restAgain: b2, beta: b3 } };
  });
}

async function gate(ctxs, v, pre) {
  const { browser, base, out } = ctxs;
  const label = `gate${v ? `[${v}]` : ''}`;
  const C = cfg('gate');
  const settle = (page) => page.waitForTimeout(1500);
  const text = (page) => page.evaluate(() => document.body.innerText.trim());
  const start = await withPage(
    browser,
    base,
    label,
    v,
    { ...C, gate: true, ready: false },
    async (page) => {
      await settle(page);
      const file = join(out, `${pre}gate_start.png`);
      await page.screenshot({ path: file });
      const t = await text(page);
      check(label, 'start gate shows text', t.length > 0, JSON.stringify(t.slice(0, 60)));
      return file;
    },
  );
  const fallback = await withPage(
    browser,
    base,
    label,
    v,
    { ...C, gate: true, gpu: false, ready: false },
    async (page) => {
      await settle(page);
      const file = join(out, `${pre}gate_nowebgpu.png`);
      await page.screenshot({ path: file });
      const t = await text(page);
      check(
        label,
        'no-WebGPU fallback mentions WebGPU',
        /webgpu/i.test(t),
        JSON.stringify(t.slice(0, 80)),
      );
      return file;
    },
  );
  return { start, fallback };
}

// One place for the named spots on the disk used by `variants` and `hero`.
const SPOTS = {
  centre: { label: 'centre r=0', u: 0, v: 0 },
  hopf: { label: 'Hopf / cycle', u: 0, v: 0.45 },
  torus: { label: 'torus', u: -0.46, v: 0 },
  lorenz: { label: 'Lorenz strange', u: 0.64, v: 0.64 },
  rossler: { label: 'Rössler', u: -0.9, v: 0 },
  thomas: { label: 'Thomas labyrinth', u: 0.64, v: -0.64 },
  dive: { label: 'Lorenz, dive 0.7', u: 0.64, v: 0.64, dive: 0.7 },
};
const regimeLine = (s) => `${REGIMES[s.regime] ?? '–'}  D ${f2(s.dky)}`;
const spotLabel = (k) => `${SPOTS[k].label}\n(${f2(SPOTS[k].u)}, ${f2(SPOTS[k].v)})`;

// Renders each spot: teleport, settle, screenshot. `dive` spots go last (the camera stays dived).
async function shootSpots(page, C, keys, fileFor) {
  const shots = [];
  for (const key of keys) {
    const { u, v, dive } = SPOTS[key];
    if (dive) await hook(page, 'setCamera', { dive });
    await hook(page, 'setBead', u, v);
    await hook(page, 'step', C.frames);
    const s = await hook(page, 'stats');
    const file = fileFor(key);
    shots.push({ key, s, file, png: await page.screenshot({ path: file }) });
    log(`  ${key} ${s.variant} regime=${s.regime} D=${f2(s.dky)} scale=${f2(s.scale)}`);
  }
  return shots;
}

// Rows = every --v id, columns = 7 spots; plus one row of start-gate shots.
async function variants(ctxs) {
  const { browser, base, tool, out } = ctxs;
  const C = cfg('variants');
  const keys = Object.keys(SPOTS);
  const rows = [];
  for (const id of OPT.variants) {
    const label = `variants[${id}]`;
    log(`  -- ${id}`);
    const gate = await withPage(
      browser,
      base,
      label,
      id,
      { ...C, gate: true, ready: false },
      async (page) => {
        await page.waitForSelector('nav.variants', { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(1500);
        const name = await page.evaluate(
          () => document.querySelector('nav.variants .on')?.textContent ?? null,
        );
        return { name, png: await page.screenshot({ path: join(out, `variants_${id}_gate.png`) }) };
      },
    );
    const shots = await withPage(browser, base, label, id, C, (page) =>
      shootSpots(page, C, keys, (k) => join(out, `variants_${id}_${k}.png`)),
    );
    check(
      label,
      'engine loaded the requested variant',
      shots.every((x) => x.s.variant === id),
      shots[0].s.variant,
    );
    const an = await analyze(
      tool,
      shots.map((x) => x.png),
    );
    an.forEach((x, i) => warnIfBlank(label, `${id} ${keys[i]}`, x));
    rows.push({ id, gate, shots });
  }
  const width = sheetWidth(1800);
  const suffix = `n=${C.n} frames=${C.frames} seed=${OPT.seed}${C.query ? ` ${C.query}` : ''}`;
  const matrix = await contactSheet(tool, join(out, 'variants_matrix.png'), {
    title: `axiom variants · ${suffix}`,
    cols: keys.length,
    width,
    head: keys.map(spotLabel),
    side: rows.map((r) =>
      r.gate.name && r.gate.name !== r.id ? `${r.gate.name}\n(${r.id})` : r.id,
    ),
    cells: rows.flatMap((r) => r.shots.map((x) => ({ png: x.png, label: regimeLine(x.s) }))),
  });
  const gates = await contactSheet(tool, join(out, 'variants_gates.png'), {
    title: `axiom start gates · ${suffix}`,
    cols: rows.length,
    width: Math.min(width, 24 + rows.length * 370), // keep a lone gate from blowing up to full width
    cells: rows.map((r) => ({ png: r.gate.png, label: r.gate.name ?? r.id })),
  });
  return {
    matrix,
    gates,
    rows: rows.map(
      (r) => `${r.id}: ${r.shots.map((x) => `${x.key} ${regimeLine(x.s)}`).join(' | ')}`,
    ),
  };
}

// Presentation stills: 3 spots at 430x932 @2x, full-resolution PNGs + a triptych per variant.
async function hero(ctxs, v, pre) {
  const { browser, base, tool, out } = ctxs;
  const C = cfg('hero');
  const label = `hero${v ? `[${v}]` : ''}`;
  const keys = ['hopf', 'lorenz', 'thomas'];
  const shots = await withPage(browser, base, label, v, { ...C, device: HERO }, (page) =>
    shootSpots(page, C, keys, (k) => join(out, `${pre}hero_${k}.png`)),
  );
  if (v)
    check(
      label,
      'engine loaded the requested variant',
      shots.every((x) => x.s.variant === v),
      shots[0].s.variant,
    );
  shots.forEach(
    (x) => x.s.scale < 1 && warn(label, `${x.key} rendered at resolution scale ${f2(x.s.scale)}`),
  );
  const an = await analyze(
    tool,
    shots.map((x) => x.png),
  );
  an.forEach((x, i) => warnIfBlank(label, keys[i], x));
  const triptych = await contactSheet(tool, join(out, `${pre}hero_triptych.png`), {
    title: `axiom hero · ${shots[0].s.variant} · n=${C.n} frames=${C.frames} seed=${OPT.seed}`,
    cols: 3,
    width: sheetWidth(1800),
    cells: shots.map((x) => ({ png: x.png, label: `${SPOTS[x.key].label}  ${regimeLine(x.s)}` })),
  });
  return { triptych, stills: shots.map((x) => x.file), pixels: '860x1864' };
}

// ---- main ------------------------------------------------------------------------------------
const MODES = { grid, sweep, sensors, gate, variants, hero };
const ONCE = new Set(['variants']); // modes that consume every --v id in a single run
let server, browser;
const cleanup = async () => {
  await browser?.close().catch(() => {});
  server?.stop();
};
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => cleanup().finally(() => process.exit(130)));
}

const results = {};
let crashed = false;
try {
  mkdirSync(OPT.out, { recursive: true });
  server = await startServer();
  log(
    `server ${server.base}  out ${OPT.out}  ${OPT.desktop ? 'desktop 1440x900' : 'phone 393x852'}`,
  );
  browser = await chromium.launch({
    headless: true,
    args: GPU_FLAGS,
    env: GPU_ENV,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const tool = await (await browser.newContext()).newPage(); // scratch page for image decoding + sheets
  const ctxs = { browser, base: server.base, tool, out: OPT.out };
  for (const mode of OPT.modes) {
    for (const v of ONCE.has(mode) ? [null] : OPT.variants) {
      const key = v ? `${mode}:${v}` : mode;
      const { n, frames, query } = cfg(mode);
      log(`\n== ${key}  n=${n} frames=${frames}${query ? ` query=${query}` : ''}`);
      try {
        results[key] = await MODES[mode](ctxs, v, v ? `${v}_` : '');
      } catch (e) {
        crashed = true;
        results[key] = { error: String(e?.message ?? e) };
        log(`  !! ${key} crashed: ${e?.stack ?? e}`);
      }
    }
  }
} catch (e) {
  crashed = true;
  log(`fatal: ${e?.stack ?? e}`);
  results.fatal = String(e?.message ?? e);
} finally {
  await cleanup();
}

const errors = [...issues.values()];
const failedChecks = checks.filter((c) => !c.ok);
const ok = !crashed && errors.length === 0 && failedChecks.length === 0;
const summary = {
  ok,
  out: OPT.out,
  device: OPT.desktop ? 'desktop 1440x900' : 'phone 393x852',
  params: {
    seed: OPT.seed,
    variants: OPT.variants.filter(Boolean),
    config: Object.fromEntries(OPT.modes.map((m) => [m, cfg(m)])),
  },
  modes: results,
  warnings,
  checks: checks.map(
    (c) => `${c.ok ? 'PASS' : 'FAIL'} [${c.mode}] ${c.name}${c.detail ? ` (${c.detail})` : ''}`,
  ),
  errors,
};
try {
  writeFileSync(join(OPT.out, 'summary.json'), JSON.stringify(summary, null, 2));
} catch {}
// Pretty-print, but keep flat numeric arrays on one line.
console.log(
  JSON.stringify(summary, null, 2).replace(
    /\[\s+(-?[\d.e-]+(?:,\s+-?[\d.e-]+)*)\s+\]/g,
    (_, xs) => `[${xs.replace(/\s+/g, ' ')}]`,
  ),
);
log(
  ok
    ? '\nOK'
    : `\nFAILED: ${errors.length} distinct errors, ${failedChecks.length} failed checks${crashed ? ', crashed' : ''}`,
);
process.exit(ok ? 0 : 1);
