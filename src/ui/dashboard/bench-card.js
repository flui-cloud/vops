// PNG social card for a bench run — a stat-tile composition drawn client-side on
// a canvas (no dependencies, no network beyond the cached /bench/runs/:id).
// Renders only from BenchResultV1, so it is structurally free of address/user/port.
const BC_W = 1200, BC_H = 630, BC_M = 56;
const BC_SANS = "-apple-system, system-ui, 'Segoe UI', sans-serif";
const BC_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function bcVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function bcTheme() {
  return {
    bg: bcVar('--panel', '#12141b'),
    text: bcVar('--text', '#eef1f6'),
    dim: bcVar('--text-dim', '#9aa3b2'),
    faint: bcVar('--text-faint', '#69707e'),
    accent: bcVar('--accent', '#4a90f5'),
    warn: bcVar('--warn', '#f5a623'),
    ok: bcVar('--ok', '#34d399'),
    danger: bcVar('--danger', '#ff6b6b'),
    border: bcVar('--border', '#242a36'),
  };
}

function bcCompact(n) {
  return n >= 10000 ? (n / 1000).toFixed(1) + 'K' : Math.round(n).toLocaleString('en-US');
}

function bcText(ctx, text, x, y, font, color, align = 'left') {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
  return ctx.measureText(text).width;
}

function bcEllipsize(ctx, text, font, maxW) {
  ctx.font = font;
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function bcChip(ctx, label, x, midY, th) {
  const font = '600 15px ' + BC_SANS;
  ctx.font = font;
  const w = ctx.measureText(label).width + 24;
  const h = 26, r = 13, y = midY - h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.strokeStyle = th.border;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  bcText(ctx, label, x + w / 2, midY + 5, font, th.dim, 'center');
  return x + w + 10;
}

function bcMetrics(r, id) {
  const p = r.probes.find((x) => x.id === id);
  return p?.status === 'done' ? p.metrics : null;
}

function bcSeqValue(r) {
  const rd = bcMetrics(r, 'disk.sr1m');
  const wr = bcMetrics(r, 'disk.sw1m');
  if (!rd && !wr) return null;
  const one = (m) => (m ? Math.round(m.mbps).toLocaleString('en-US') : '—');
  return one(rd) + ' / ' + one(wr) + ' MB/s';
}

function bcCryptoKey(m) {
  return Object.keys(m).find((k) => k.toLowerCase().includes('aes')) || Object.keys(m)[0];
}

function bcCryptoValue(r) {
  const m = bcMetrics(r, 'cpu.crypto');
  if (!m) return null;
  const key = bcCryptoKey(m);
  return key ? (m[key] / 1e9).toFixed(2) + ' GB/s' : null;
}

function bcSpreadPct(r, id, key) {
  const s = r.probes.find((x) => x.id === id)?.spread?.[key];
  return s ? '±' + s.spreadPct + '%' : '';
}

function bcJoin(...parts) { return parts.filter(Boolean).join(' · '); }

function bcTiles(r, bands) {
  const single = bcMetrics(r, 'cpu.single');
  const mem = bcMetrics(r, 'mem.bw');
  const crypto = bcMetrics(r, 'cpu.crypto');
  const rr = bcMetrics(r, 'disk.rr4k');
  const rw = bcMetrics(r, 'disk.rw4k');
  const b = bands || {};
  return [
    { label: 'CPU, single core', value: single ? bcCompact(single.mips) + ' MIPS' : null, suffix: bcSpreadPct(r, 'cpu.single', 'mips'), band: b['cpu.single'] || null },
    { label: 'Memory bandwidth', value: mem ? bcCompact(mem.mibps) + ' MiB/s' : null, suffix: bcSpreadPct(r, 'mem.bw', 'mibps'), band: b['mem.bw'] || null },
    { label: 'AES-256 crypto', value: bcCryptoValue(r), suffix: crypto ? bcSpreadPct(r, 'cpu.crypto', bcCryptoKey(crypto)) : '', band: b['cpu.crypto'] || null },
    { label: 'Disk 4k read', value: rr ? bcCompact(rr.iops) + ' IOPS' : null, suffix: bcJoin(rr && 'p99 ' + rr.p99ms.toFixed(1) + ' ms', bcSpreadPct(r, 'disk.rr4k', 'iops')), band: b['disk.rr4k'] || null },
    { label: 'Disk 4k write', value: rw ? bcCompact(rw.iops) + ' IOPS' : null, suffix: bcJoin(rw && 'p99 ' + rw.p99ms.toFixed(1) + ' ms', bcSpreadPct(r, 'disk.rw4k', 'iops')), band: b['disk.rw4k'] || null },
    { label: 'Disk sequential', value: bcSeqValue(r), suffix: bcSpreadPct(r, 'disk.sr1m', 'mbps') || bcSpreadPct(r, 'disk.sw1m', 'mbps'), band: b['disk.sr1m'] || b['disk.sw1m'] || null },
  ];
}

function bcDownsample(a, n) {
  if (a.length <= n) return a;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(a[Math.floor((i * a.length) / n)]);
  return out;
}

function bcHeader(ctx, r, th) {
  ctx.beginPath();
  ctx.arc(BC_M + 5, 70, 5, 0, 2 * Math.PI);
  ctx.fillStyle = th.accent;
  ctx.fill();
  bcText(ctx, 'vops bench', BC_M + 20, 77, '600 21px ' + BC_SANS, th.text);
  bcText(ctx, r.startedAt.slice(0, 10), BC_W - BC_M, 77, '400 18px ' + BC_SANS, th.dim, 'right');
}

function bcHost(ctx, r, th) {
  const aliasFont = '600 34px ' + BC_SANS;
  const alias = bcEllipsize(ctx, r.host.name, aliasFont, 700);
  const w = bcText(ctx, alias, BC_M, 124, aliasFont, th.text);
  let x = BC_M + w + 18;
  x = bcChip(ctx, r.profile + ' · v' + r.profileVersion, x, 112, th);
  bcChip(ctx, r.mode, x, 112, th);
  const m = r.meta;
  const hw = [m.cpuModel, m.cores + ' cores', m.memGb + ' GB RAM', m.virt, m.osPretty].join(' · ');
  const hwFont = '400 16.5px ' + BC_SANS;
  bcText(ctx, bcEllipsize(ctx, hw, hwFont, BC_W - 2 * BC_M), BC_M, 154, hwFont, th.dim);
}

function bcHero(ctx, r, th) {
  bcText(ctx, 'CPU, all cores', BC_M, 200, '400 19px ' + BC_SANS, th.dim);
  const m = bcMetrics(r, 'cpu.multi');
  if (!m) {
    const w = bcText(ctx, '—', BC_M, 272, '600 84px ' + BC_SANS, th.text);
    bcText(ctx, 'skipped', BC_M + w + 16, 272, '400 20px ' + BC_SANS, th.faint);
    return;
  }
  const w = bcText(ctx, bcCompact(m.mips), BC_M, 272, '600 84px ' + BC_SANS, th.text);
  bcText(ctx, 'MIPS', BC_M + w + 14, 272, '600 28px ' + BC_SANS, th.dim);
}

function bcTilesPaint(ctx, r, th, bands) {
  const colW = (BC_W - 2 * BC_M) / 3;
  bcTiles(r, bands).forEach((tile, i) => {
    const x = BC_M + (i % 3) * colW;
    const labelY = i < 3 ? 322 : 402;
    bcText(ctx, tile.label, x, labelY, '400 19px ' + BC_SANS, th.dim);
    if (tile.value == null) {
      const w = bcText(ctx, '—', x, labelY + 34, '600 32px ' + BC_SANS, th.text);
      bcText(ctx, 'skipped', x + w + 10, labelY + 34, '400 16px ' + BC_SANS, th.faint);
      return;
    }
    const w = bcText(ctx, tile.value, x, labelY + 34, '600 32px ' + BC_SANS, th.text);
    if (tile.suffix) bcText(ctx, tile.suffix, x + w + 10, labelY + 34, '400 16px ' + BC_SANS, th.faint);
    if (tile.band) {
      const bandFont = '400 13px ' + BC_SANS;
      bcText(ctx, bcEllipsize(ctx, tile.band, bandFont, colW - 20), x, labelY + 52, bandFont, th.faint);
    }
  });
}

function bcSparkPaint(ctx, r, th) {
  if (!r.samples?.length) return;
  const label = 'CPU steal during run · avg ' + r.steal.avg + '% · max ' + r.steal.max + '%';
  bcText(ctx, label, BC_M, 480, '400 15px ' + BC_SANS, th.dim);
  const top = 490, h = 40, wArea = BC_W - 2 * BC_M;
  ctx.strokeStyle = th.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(BC_M, top + h);
  ctx.lineTo(BC_M + wArea, top + h);
  ctx.stroke();
  const vals = bcDownsample(r.samples.map((s) => s.steal), 64);
  if (vals.length < 2) return;
  const max = Math.max(...vals, 1);
  ctx.strokeStyle = th.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = BC_M + (i / (vals.length - 1)) * wArea;
    const y = top + h - (v / max) * (h - 4);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function bcFooter(ctx, r, th, reading) {
  if (r.mode === 'in-vivo') {
    const caveat = 'Measured on a live host (baseline load1 ' + r.baseline.load1 + ') — treat as a floor.';
    bcText(ctx, caveat, BC_M, 552, '400 16px ' + BC_SANS, th.warn);
  }
  const runsNote = (r.runs || 1) > 1 ? ' · median of ' + r.runs + ' runs' : '';
  const line = 'Reproduce: vops bench host ' + r.host.name + ' --profile ' + r.profile +
    '   ·   vops bench profile v' + r.profileVersion + ' · bands v' + (reading?.bandsVersion || 1) + runsNote;
  bcText(ctx, line, BC_M, BC_H - BC_M, '400 15px ' + BC_MONO, th.faint);
}

function bcRenderCard(r, reading) {
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
  bcHeader(ctx, r, th);
  bcHost(ctx, r, th);
  bcHero(ctx, r, th);
  bcTilesPaint(ctx, r, th, reading?.bands);
  bcSparkPaint(ctx, r, th);
  bcFooter(ctx, r, th, reading);
  return canvas;
}

function bcDownload(blob, r) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'vops-bench-' + r.host.name + '-' + r.startedAt.slice(0, 10) + '.png';
  a.click();
  URL.revokeObjectURL(a.href);
}

function dashboardBenchCard() {
  return {
    // Alpine-facing wrappers — markup never calls bc* module functions directly.
    bhCardTiles(r, reading) { return bcTiles(r, reading?.bands); },
    bhCardHero(r) {
      const m = bcMetrics(r, 'cpu.multi');
      return m ? bcCompact(m.mips) : null;
    },
    async bhImageBlob(id) {
      const r = await this.bhEnsureDetail(id);
      if (!r) return null;
      const reading = await this.bhEnsureReading(id);
      const blob = await new Promise((resolve) => bcRenderCard(r, reading).toBlob(resolve, 'image/png'));
      if (!blob) { this.notify('Could not render the image', 'error'); return null; }
      return { blob, r };
    },
    async bhCopyImage(id) {
      const out = await this.bhImageBlob(id);
      if (!out) return;
      if (navigator.clipboard?.write && window.ClipboardItem) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': out.blob })]);
          this.notify('Image copied');
          return;
        } catch { /* clipboard refused — fall back to download */ }
      }
      bcDownload(out.blob, out.r);
      this.notify('Clipboard image not supported here — downloaded instead');
    },
    async bhDownloadImage(id) {
      const out = await this.bhImageBlob(id);
      if (!out) return;
      bcDownload(out.blob, out.r);
      this.notify('Image downloaded');
    },
  };
}
