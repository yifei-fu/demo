// Image helpers for shots.mjs. Everything runs in a scratch Chromium page (`tool`), so there are
// no Node image dependencies: PNGs are decoded with createImageBitmap, sheets are HTML screenshots.

// For each PNG: mean luma, fraction of lit pixels, and mean |Δ| (0..255 over RGB) vs. the previous.
export async function analyze(tool, pngs) {
  return tool.evaluate(
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
  );
}

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// cells: [{png: Buffer, label: string, flag?: bool}] laid out row-major in `cols` columns.
// Optional `head` (column labels) and `side` (row labels) turn it into a labelled matrix.
export async function contactSheet(
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

export function diffChart(diffs, threshold, width) {
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
