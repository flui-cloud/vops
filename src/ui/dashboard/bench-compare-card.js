// PNG social card for a run comparison — same canvas/theme discipline as the run
// card (bc* primitives come from bench-card.js in the same bundle). Renders only
// from the already-loaded compare payload (aliases + numbers, never host details).
function bccVal(v) {
  if (v == null) return '—';
  return v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100);
}

function bccDelta(row, th) {
  if (row.deltaPct == null) return { text: '—', color: th.faint };
  const text = (row.deltaPct >= 0 ? '+' : '') + row.deltaPct.toFixed(1) + '%';
  if (Math.abs(row.deltaPct) < 3) return { text: '≈ ' + text, color: th.faint };
  const good = (row.deltaPct > 0) === (row.better === 'up');
  return { text, color: good ? th.ok : th.danger };
}

function bccParty(p) {
  return p.host + ' · ' + p.startedAt.slice(0, 10) + ' · ' + p.profile;
}

function bccTable(ctx, cmp, th) {
  const headFont = '600 14px ' + BC_SANS;
  bcText(ctx, 'METRIC', BC_M, 230, headFont, th.faint);
  bcText(ctx, 'BASELINE', 760, 230, headFont, th.faint, 'right');
  bcText(ctx, 'THIS RUN', 950, 230, headFont, th.faint, 'right');
  bcText(ctx, 'Δ', 1144, 230, headFont, th.faint, 'right');
  cmp.rows.forEach((row, i) => {
    const y = 256 + i * 26;
    bcText(ctx, row.label, BC_M, y, '400 17px ' + BC_SANS, th.dim);
    bcText(ctx, bccVal(row.a), 760, y, '400 17px ' + BC_SANS, th.text, 'right');
    bcText(ctx, bccVal(row.b), 950, y, '400 17px ' + BC_SANS, th.text, 'right');
    const d = bccDelta(row, th);
    bcText(ctx, d.text, 1144, y, '600 17px ' + BC_SANS, d.color, 'right');
  });
}

function bccRender(cmp) {
  const canvas = document.createElement('canvas');
  canvas.width = BC_W * 2;
  canvas.height = BC_H * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);
  const th = bcTheme();
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, BC_W, BC_H);
  ctx.strokeStyle = th.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, BC_W - 2, BC_H - 2);
  ctx.beginPath();
  ctx.arc(BC_M + 5, 70, 5, 0, 2 * Math.PI);
  ctx.fillStyle = th.accent;
  ctx.fill();
  bcText(ctx, 'vops bench compare', BC_M + 20, 77, '600 21px ' + BC_SANS, th.text);
  const w = bcText(ctx, bccParty(cmp.b), BC_M, 120, '600 24px ' + BC_SANS, th.text);
  bcText(ctx, '  vs ' + bccParty(cmp.a), BC_M + w, 120, '400 18px ' + BC_SANS, th.faint);
  const caveatFont = '400 15px ' + BC_SANS;
  cmp.caveats.slice(0, 3).forEach((c, i) => {
    bcText(ctx, bcEllipsize(ctx, '! ' + c, caveatFont, BC_W - 2 * BC_M), BC_M, 150 + i * 22, caveatFont, th.warn);
  });
  bccTable(ctx, cmp, th);
  bcText(ctx, 'vops bench compare · ' + cmp.a.id + ' vs ' + cmp.b.id, BC_M, 574, '400 15px ' + BC_MONO, th.faint);
  return canvas;
}

function bccDownload(blob, cmp) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vops-bench-compare-' + cmp.b.id + '-vs-' + cmp.a.id + '.png';
  a.click();
  URL.revokeObjectURL(a.href);
}

function dashboardBenchCompareCard() {
  return {
    async bhCmpImageBlob() {
      const cmp = this.bench.cmpSel.result;
      if (!cmp) return null;
      const blob = await new Promise((resolve) => bccRender(cmp).toBlob(resolve, 'image/png'));
      if (!blob) { this.notify('Could not render the image', 'error'); return null; }
      return { blob, cmp };
    },
    async bhCmpCopyImage() {
      const out = await this.bhCmpImageBlob();
      if (!out) return;
      if (navigator.clipboard?.write && window.ClipboardItem) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': out.blob })]);
          this.notify('Image copied');
          return;
        } catch { /* clipboard refused — fall back to download */ }
      }
      bccDownload(out.blob, out.cmp);
      this.notify('Clipboard image not supported here — downloaded instead');
    },
    async bhCmpDownloadImage() {
      const out = await this.bhCmpImageBlob();
      if (!out) return;
      bccDownload(out.blob, out.cmp);
      this.notify('Image downloaded');
    },
  };
}
