#!/usr/bin/env node
// Visual-QA harness for AXIOM. Drives the engine through window.__axiom (docs/DESIGN.md §5),
// writes screenshots + contact sheets, and exits 1 on any console/page error or failed check.
//
//   node scripts/shots.mjs [--mode grid|sweep|sensors|gate|all] [--desktop] [--v a,b]
//        [--n 65536] [--seed 1] [--frames 180] [--out dir] [--url base | --port 5172]
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
    n: { type: 'string', default: '65536' },
    seed: { type: 'string', default: '1' },
    frames: { type: 'string', default: '180' },
    desktop: { type: 'boolean', default: false },
    mode: { type: 'string', default: 'all' },
    sheet: { type: 'string', default: '1200' },
  },
});
const ALL_MODES = ['grid', 'sweep', 'sensors', 'gate'];
const modes = a.mode === 'all' ? ALL_MODES : a.mode.split(',');
const badMode = modes.find((m) => !ALL_MODES.includes(m));
if (badMode)
  (console.error(`unknown --mode ${badMode} (grid|sweep|sensors|gate|all, comma-separated)`),
    process.exit(2));
const OPT = {
  n: Number(a.n),
  seed: Number(a.seed),
  frames: Number(a.frames),
  sheet: Number(a.sheet),
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
const REGIMES = ['fixed', 'cycle', 'torus', 'strange', 'labyrinth'];
const STEP_TIMEOUT = 240_000;
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

function pageUrl(base, v, gate) {
  const q = [...(gate ? [] : ['skipintro', 'capture']), `n=${OPT.n}`, `seed=${OPT.seed}`];
  if (v) q.push(`v=${v}`);
  return new URL(`?${q.join('&')}`, base).href;
}

// Runs fn(page, ctx) in a fresh, instrumented context (phone by default) and always closes it.
async function withPage(browser, base, label, v, { gate = false, gpu = true, ready = true }, fn) {
  const ctx = await browser.newContext(
    OPT.desktop
      ? { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }
      : {
          viewport: { width: 393, height: 852 },
          deviceScaleFactor: 1,
          isMobile: true,
          hasTouch: true,
        },
  );
  try {
    if (!gpu) await ctx.addInitScript(removeGpu);
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon\.ico/.test(m.location().url ?? ''))
        report(label, 'console.error', m.text());
    });
    page.on('pageerror', (e) => report(label, 'pageerror', e.message));
    page.on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? 'failed';
      if (!why.includes('ERR_ABORTED')) report(label, 'requestfailed', `${r.url()} ${why}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !r.url().endsWith('/favicon.ico'))
        report(label, `http ${r.status()}`, r.url());
    });
    await page.goto(pageUrl(base, v, gate), { waitUntil: 'load' });
    if (ready) {
      await page.waitForFunction(() => window.__axiom?.ready === true, null, {
        timeout: 90_000,
        polling: 250,
      });
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
async function contactSheet(tool, file, { title, cols, cells, footer = '' }) {
  const gap = 10;
  const cellW = Math.floor((OPT.sheet - 24 - (cols - 1) * gap) / cols);
  const figs = cells
    .map(
      (c) =>
        `<figure class="${c.flag ? 'flag' : ''}"><img src="data:image/png;base64,${c.png.toString('base64')}"><figcaption>${esc(c.label)}</figcaption></figure>`,
    )
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:12px;background:#05060a;color:#9aa0b0;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace}
    h1{margin:0 0 10px;font:600 12px/1 system-ui,sans-serif;letter-spacing:.06em;color:#dfe3ee}
    .g{display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:${gap}px}
    figure{margin:0}img{display:block;width:${cellW}px;height:auto;outline:1px solid #1b1e28}
    figcaption{padding:4px 0 0;white-space:pre}.flag figcaption{color:#ff6b5e}svg{display:block;margin-top:12px}
  </style><h1>${esc(title)}</h1><div class="g">${figs}</div>${footer}`;
  await tool.setViewportSize({ width: OPT.sheet, height: 200 });
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
  return withPage(browser, base, `grid${v ? `[${v}]` : ''}`, v, {}, async (page) => {
    const res = { sheets: [], shots: [] };
    for (const cam of CAMERAS) {
      if (cam.set) await hook(page, 'setCamera', cam.set);
      const cells = [];
      for (const p of DISK) {
        await hook(page, 'setBead', p.u, p.v);
        await hook(page, 'step', OPT.frames);
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
        title: `axiom grid · ${cam.name} · n=${OPT.n} seed=${OPT.seed} frames=${OPT.frames}${v ? ` · v=${v}` : ''}`,
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
  return withPage(browser, base, `sweep${v ? `[${v}]` : ''}`, v, {}, async (page) => {
    await hook(page, 'setBead', U0, 0);
    await hook(page, 'step', OPT.frames); // settle so step 0 is comparable with step 1
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
      title: `axiom sweep · u ${U0} → ${U1}, v 0 · ${PER_STEP} frames/step · median Δ ${med.toFixed(2)} · red = Δ > 3x median${v ? ` · v=${v}` : ''}`,
      cols: 8,
      cells: frames.map((f, i) => ({
        png: f.png,
        flag: flagged.includes(i),
        label: `#${String(i).padStart(2, '0')} u ${f2(f.u)}\n${i ? `Δ ${diffs[i - 1].toFixed(2)}` : 'Δ –'} ${REGIMES[f.s.regime] ?? ''}`,
      })),
      footer: diffChart(diffs, threshold, OPT.sheet - 24),
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
  return withPage(browser, base, label, v, {}, async (page, ctx) => {
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
  const settle = (page) => page.waitForTimeout(1500);
  const text = (page) => page.evaluate(() => document.body.innerText.trim());
  const start = await withPage(
    browser,
    base,
    label,
    v,
    { gate: true, ready: false },
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
    { gate: true, gpu: false, ready: false },
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

// ---- main ------------------------------------------------------------------------------------
const MODES = { grid, sweep, sensors, gate };
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
  for (const v of OPT.variants) {
    for (const mode of OPT.modes) {
      const key = v ? `${mode}:${v}` : mode;
      log(`\n== ${key}`);
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
  params: { n: OPT.n, seed: OPT.seed, frames: OPT.frames, variants: OPT.variants.filter(Boolean) },
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
