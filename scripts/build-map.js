/* Bakes the world map into a static asset: country outlines + region pins,
 * both projected with the SAME Mercator so pins land on the geography. The UI
 * pans/zooms purely by moving the SVG viewBox — no d3 ships at runtime, and the
 * whole navigable world stays a single lightweight file (110m, 1-decimal paths).
 * Runs at build time only. */
const fs = require('node:fs');
const path = require('node:path');
const { feature } = require('topojson-client');
const { geoMercator, geoPath } = require('d3-geo');
const worldTopo = require('world-atlas/countries-110m.json');

// Trim path coordinates to 1 decimal — roughly halves the file, no visible loss.
const trim = (d) => d.replace(/-?\d+\.\d+/g, (m) => String(+(+m).toFixed(1)));

const W = 1000;

// EU member states (numeric ISO 3166-1) — highlighted, mirrors flui.landing.
const EU_IDS = new Set([
  '040', '056', '100', '191', '196', '203', '208', '233', '246', '250',
  '276', '300', '348', '372', '380', '428', '440', '442', '470', '528',
  '616', '620', '642', '703', '705', '724', '752',
]);

const world = feature(worldTopo, worldTopo.objects.countries);

// Mercator framed to the inhabited longitudes/latitudes actually covered by the
// provider regions (Seattle → Sydney/Tokyo, Scandinavia → Sydney), cropping the
// empty far-Pacific and Antarctica. We frame from the projected CORNER POINTS
// (not a polygon — its edges would resample along great circles and bulge toward
// the pole, inflating the height). This locks the lat/lng box to exactly [0,0]-
// [W,H] with no empty margins; H is derived so the map fills the canvas, and the
// UI mirrors this aspect via geo.height/width.
const LON = [-132, 156]; // west, east
const LAT = [71, -46]; // north, south
const projection = geoMercator().scale(1).translate([0, 0]);
const nw = projection([LON[0], LAT[0]]);
const se = projection([LON[1], LAT[1]]);
const scale = W / (se[0] - nw[0]);
const H = Math.round((se[1] - nw[1]) * scale);
projection.scale(scale).translate([-nw[0] * scale, -nw[1] * scale]);
const toPath = geoPath(projection);

const countries = world.features
  .map((f) => ({ d: trim(toPath(f) || ''), eu: EU_IDS.has(String(f.id)) }))
  .filter((c) => c.d);

const geo = require(path.join(__dirname, '..', 'src', 'lib', 'region-geo.json'));
const pins = geo.map((r) => {
  const xy = projection([r.lng, r.lat]) || [0, 0];
  return {
    code: r.code, city: r.city, country: r.country, provider: r.provider,
    continent: r.continent,
    xPct: +((xy[0] / W) * 100).toFixed(3), yPct: +((xy[1] / H) * 100).toFixed(3),
  };
});

// Quick-jump viewBoxes, one per pin cluster, padded and locked to the map's
// aspect ratio so a preset never distorts. World = the whole frame.
const ASPECT = W / H;
// Centre the preset on the pin CENTROID (where the cluster actually sits), then
// grow the box just enough to contain every pin plus padding. Centroid-centring
// keeps dense clusters off the edge instead of drifting toward empty ocean.
// `tight` scales the padding around the cluster: 1 = default, <1 zooms in
// (Europe's pins sit in a narrow band, so it defaults too wide — tighten it).
function frameFor(subset, tight = 1) {
  const xs = subset.map((p) => (p.xPct / 100) * W);
  const ys = subset.map((p) => (p.yPct / 100) * H);
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
  const spanX = Math.max(...xs.map((x) => Math.abs(x - cx)));
  const spanY = Math.max(...ys.map((y) => Math.abs(y - cy)));
  const hx = spanX + Math.max(spanX * 0.6, 55) * tight;
  const hy = spanY + Math.max(spanY * 0.6, 55) * tight;
  let w = hx * 2, h = hy * 2;
  if (w / h > ASPECT) h = w / ASPECT; else w = h * ASPECT;
  return {
    x: +(cx - w / 2).toFixed(1), y: +(cy - h / 2).toFixed(1),
    w: +w.toFixed(1), h: +h.toFixed(1),
  };
}

const inContinents = (names) => pins.filter((p) => names.includes(p.continent));
const views = { world: { x: 0, y: 0, w: W, h: H } };
const groups = [
  ['europe', ['Europe'], 0.4], // Europe sits in a narrow band → zoom in tighter
  ['namerica', ['North America'], 1],
  ['asia', ['Asia', 'Oceania'], 1],
];
for (const [id, continents, tight] of groups) {
  const subset = inContinents(continents);
  if (subset.length) views[id] = frameFor(subset, tight);
}

const out = path.join(__dirname, '..', 'src', 'ui', 'world.geo.json');
fs.writeFileSync(out, JSON.stringify({ width: W, height: H, countries, pins, views }));
console.log(
  `world.geo.json: ${countries.length} countries, ${pins.length} pins, ` +
  `views ${Object.keys(views).join('/')}`,
);
