function dashboardMap() {
  return {
    jumpTo(id) {
      const v = this.geo.views?.[id];
      if (!v) return;
      this.mapZone = id;
      this.mapView = { x: v.x, y: v.y, w: v.w, h: v.h };
    },
    clampView(v) {
      const maxW = this.geo.width, maxH = this.geo.height;
      v.w = Math.min(Math.max(v.w, maxW * 0.06), maxW);
      v.h = v.w * (maxH / maxW);
      v.x = Math.min(Math.max(v.x, 0), maxW - v.w);
      v.y = Math.min(Math.max(v.y, 0), maxH - v.h);
      return v;
    },
    zoomAt(factor, cx, cy) {
      const v = this.mapView;
      const nw = v.w / factor, nh = v.h / factor;
      const nx = cx - (cx - v.x) * (nw / v.w);
      const ny = cy - (cy - v.y) * (nh / v.h);
      this.mapView = this.clampView({ x: nx, y: ny, w: nw, h: nh });
      this.mapZone = '';
    },
    zoomBy(factor) { this.zoomAt(factor, this.mapView.x + this.mapView.w / 2, this.mapView.y + this.mapView.h / 2); },
    svgPoint(e) {
      const rect = this.$refs.map.getBoundingClientRect();
      return {
        x: this.mapView.x + ((e.clientX - rect.left) / rect.width) * this.mapView.w,
        y: this.mapView.y + ((e.clientY - rect.top) / rect.height) * this.mapView.h,
      };
    },
    onWheel(e) { const p = this.svgPoint(e); this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y); },
    panStart(e) {
      const r = this.$refs.map.getBoundingClientRect();
      this.mapDrag = { cx: e.clientX, cy: e.clientY, vx: this.mapView.x, vy: this.mapView.y, rw: r.width, rh: r.height };
    },
    panMove(e) {
      const d = this.mapDrag;
      if (!d) return;
      const dvx = ((e.clientX - d.cx) / d.rw) * this.mapView.w;
      const dvy = ((e.clientY - d.cy) / d.rh) * this.mapView.h;
      const c = this.clampView({ x: d.vx - dvx, y: d.vy - dvy, w: this.mapView.w, h: this.mapView.h });
      this.mapView.x = c.x; this.mapView.y = c.y;
      this.mapZone = '';
    },
    panEnd() { this.mapDrag = null; },
    onPinHover(e) {
      if (this.mapDrag) return;
      const g = e.target.closest('[data-code]');
      this.hoverCode = g ? g.dataset.code : '';
    },
    hoverPin() { return (this.geo.pins || []).find(p => p.code === this.hoverCode) || {}; },
    pinScreen() {
      const p = this.hoverPin();
      if (!p.code) return null;
      const px = (p.xPct / 100) * this.geo.width, py = (p.yPct / 100) * this.geo.height;
      return { left: (px - this.mapView.x) / this.mapView.w * 100, top: (py - this.mapView.y) / this.mapView.h * 100 };
    },
    pinOnScreen() {
      const s = this.pinScreen();
      return !!s && s.left >= 0 && s.left <= 100 && s.top >= 0 && s.top <= 100;
    },
    tooltipStyle() {
      const s = this.pinScreen();
      return s ? 'left:' + s.left + '%; top:' + s.top + '%; margin-top:-10px' : 'display:none';
    },
    pinColor(provider) { return this.providerColors[provider] || 'var(--text-faint)'; },
  };
}
