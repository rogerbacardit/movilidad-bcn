// Descarga los GTFS estáticos oficiales (Renfe Cercanías y FGC) y genera:
//   data/static.json             líneas (color, nombre) y estaciones por operador
//   public/data/vias.geojson     trazado de las líneas para el mapa
//   public/data/estaciones.geojson
// Se ejecuta una vez (npm run preparar) y cuando cambien los horarios.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { openZip } from '../lib/zip.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'cache');
const UA = { 'user-agent': 'movilidad-bcn/0.1 (datos abiertos)' };
const RENFE_GTFS = 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip';
const RENFE_LD_GTFS = 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip';
const FGC_GTFS_FILES = 'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/gtfs_zip/records?limit=20';

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'public', 'data'), { recursive: true });

async function download(url, file) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// CSV mínimo con soporte de comillas. Renfe rellena los campos con espacios: se recortan.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field.trim()); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field.trim()); rows.push(row); }
  const [head, ...body] = rows;
  const keys = head.map((k) => k.replace(/^﻿/, ''));
  return body.map((r) => Object.fromEntries(keys.map((k, j) => [k, r[j] ?? ''])));
}

// Douglas-Peucker en metros (aproximación equirectangular, suficiente a esta escala).
function simplify(points, tolM = 15) {
  if (points.length < 3) return points;
  const k = Math.cos((points[0][1] * Math.PI) / 180) * 111320;
  const xy = points.map(([lon, lat]) => [lon * k, lat * 110540]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / len2));
      const d = Math.hypot(xy[i][0] - (ax + t * dx), xy[i][1] - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]).map(([lon, lat]) => [+lon.toFixed(5), +lat.toFixed(5)]);
}

function buildShapes(shapeRows, wanted) {
  const byId = new Map();
  for (const r of shapeRows) {
    if (!wanted.has(r.shape_id)) continue;
    if (!byId.has(r.shape_id)) byId.set(r.shape_id, []);
    byId.get(r.shape_id).push([+r.shape_pt_sequence, +r.shape_pt_lon, +r.shape_pt_lat]);
  }
  const out = new Map();
  for (const [id, pts] of byId) {
    pts.sort((a, b) => a[0] - b[0]);
    out.set(id, simplify(pts.map(([, lon, lat]) => [lon, lat])));
  }
  return out;
}

// Quita trazados repetidos (ida/vuelta o variantes idénticas).
function dedupe(lines) {
  const seen = new Set();
  return lines.filter((coords) => {
    const key = coords.map((c) => c.join(',')).join(';');
    const rev = [...coords].reverse().map((c) => c.join(',')).join(';');
    if (seen.has(key) || seen.has(rev)) return false;
    seen.add(key);
    return true;
  });
}

const inCatalonia = (lat, lon) => lat > 40.4 && lat < 42.95 && lon > 0.1 && lon < 3.4;

async function renfe() {
  const zip = path.join(CACHE, 'renfe_cercanias_gtfs.zip');
  console.log('Renfe: descargando GTFS de Cercanías (~15 MB)…');
  await download(RENFE_GTFS, zip);
  const z = openZip(zip);
  const read = async (name) => parseCsv(await z.text(name));

  // Rodalies de Catalunya = núcleo 51 (route_id 51T…)
  const routes = (await read('routes.txt')).filter((r) => r.route_id.startsWith('51T'));
  const lines = {};
  const routeLine = new Map();
  for (const r of routes) {
    routeLine.set(r.route_id, r.route_short_name);
    const name = r.route_long_name.replace(/\s+-/g, ' – ').replace(/\s{2,}/g, ' ');
    if (!lines[r.route_short_name]) lines[r.route_short_name] = { color: `#${r.route_color}`, name };
  }

  const shapesByLine = new Map();
  const rodaliesTrips = new Set();
  for (const t of await read('trips.txt')) {
    const line = routeLine.get(t.route_id);
    if (!line) continue;
    rodaliesTrips.add(t.trip_id);
    if (!t.shape_id) continue;
    if (!shapesByLine.has(line)) shapesByLine.set(line, new Set());
    shapesByLine.get(line).add(t.shape_id);
  }

  // Destino de cada viaje = su última parada. stop_times.txt pesa ~270 MB: se lee por streaming.
  const last = new Map();
  for await (const row of readline.createInterface({ input: z.stream('stop_times.txt'), crlfDelay: Infinity })) {
    if (!row.startsWith('51')) continue; // núcleo de Rodalies: descarta el resto sin partir la línea
    const [trip, , , stop, seq] = row.split(',').map((x) => x.trim());
    if (!rodaliesTrips.has(trip)) continue;
    const cur = last.get(trip);
    if (!cur || +seq > cur[0]) last.set(trip, [+seq, stop]);
  }
  const tripDest = Object.fromEntries([...last].map(([trip, [, stop]]) => [trip, stop]));
  const wanted = new Set([...shapesByLine.values()].flatMap((s) => [...s]));
  const shapes = buildShapes(await read('shapes.txt'), wanted);

  const stations = {};
  for (const s of await read('stops.txt')) {
    const lat = +s.stop_lat, lon = +s.stop_lon;
    if (s.stop_id.startsWith('7') && inCatalonia(lat, lon)) stations[s.stop_id] = [s.stop_name, lat, lon];
  }
  console.log(`Renfe: ${Object.keys(lines).length} líneas, ${Object.keys(stations).length} estaciones, ${wanted.size} trazados, ${Object.keys(tripDest).length} viajes con destino`);
  return { lines, stations, tripDest, shapesByLine, shapes };
}

async function fgc() {
  console.log('FGC: descargando GTFS…');
  const res = await fetch(FGC_GTFS_FILES, { headers: UA });
  if (!res.ok) throw new Error(`FGC catálogo → HTTP ${res.status}`);
  const files = Object.fromEntries((await res.json()).results.map((r) => [r.file.filename, r.file.url]));
  const read = async (name) => {
    const r = await fetch(files[name], { headers: UA });
    if (!r.ok) throw new Error(`FGC ${name} → HTTP ${r.status}`);
    return parseCsv(await r.text());
  };

  const lines = {};
  for (const r of await read('routes.txt')) {
    if (r.route_type === '3') continue; // buses sustitutorios
    lines[r.route_short_name] = { color: `#${r.route_color || '666666'}`, name: r.route_long_name };
  }
  const shapesByLine = new Map();
  for (const t of await read('trips.txt')) {
    if (!lines[t.route_id] || !t.shape_id) continue;
    if (!shapesByLine.has(t.route_id)) shapesByLine.set(t.route_id, new Set());
    shapesByLine.get(t.route_id).add(t.shape_id);
  }
  const wanted = new Set([...shapesByLine.values()].flatMap((s) => [...s]));
  const shapes = buildShapes(await read('shapes.txt'), wanted);

  const stations = {};
  for (const s of await read('stops.txt')) {
    if (s.location_type === '1' || !s.parent_station) stations[s.stop_id] = [s.stop_name, +s.stop_lat, +s.stop_lon];
  }

  // Horario de ayer a dentro de 8 días. FGC publica la hora prevista de llegada pero no el retraso:
  // el servidor lo calcula restando la hora programada. En tiempo real el trip_id lleva otro prefijo
  // de servicio, así que se indexa por el código de viaje (lo que va tras «|»).
  const ymd = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(Date.now()).replaceAll('-', '');
  const day0 = Date.UTC(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6, 8));
  const from = ymd(new Date(day0 - 86400_000));
  const to = ymd(new Date(day0 + 8 * 86400_000));
  const services = {};
  for (const c of await read('calendar_dates.txt')) {
    if (c.exception_type !== '1' || c.date < from || c.date > to) continue;
    (services[c.service_id] ??= []).push(c.date);
  }
  const toSec = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
  const byTrip = new Map();
  for (const st of await read('stop_times.txt')) {
    const [svc, code] = st.trip_id.split('|');
    if (!code || !services[svc]) continue;
    let t = byTrip.get(st.trip_id);
    if (!t) { t = [svc, code, {}]; byTrip.set(st.trip_id, t); }
    t[2][st.stop_id] = toSec(st.arrival_time || st.departure_time);
  }
  const trips = {};
  for (const [svc, code, stops] of byTrip.values()) (trips[code] ??= []).push([svc, stops]);

  console.log(`FGC: ${Object.keys(lines).length} líneas, ${Object.keys(stations).length} estaciones, ${wanted.size} trazados, ${byTrip.size} viajes en el horario (${from}–${to})`);
  return { lines, stations, shapesByLine, shapes, horarios: { from, to, services, trips } };
}

// ── AVE y larga distancia (Renfe AV/LD/MD) ───────────────────────────────────
// Productos que se muestran. MD y regionales quedan fuera: en Catalunya ya son las líneas R1x de Rodalies.
const LD_PRODUCTS = {
  AVE: { color: '#6a2c91', name: 'AVE' },
  'AVE INT': { color: '#3b3b98', name: 'AVE internacional' },
  AVLO: { color: '#d6006e', name: 'Avlo' },
  ALVIA: { color: '#0f7c8c', name: 'Alvia' },
  EUROMED: { color: '#1f6fb2', name: 'Euromed' },
  Intercity: { color: '#6b6b6b', name: 'Intercity' },
  AVANT: { color: '#e2711d', name: 'Avant' },
  'AVANT EXP': { color: '#e2711d', name: 'Avant Exprés' },
};
// Corredores, en orden de prioridad: el primero que encaja con alguna parada del tren.
const LD_CORRIDORS = [
  { id: 'francia', name: 'Barcelona – Francia', re: /Perpi|Narbon|Paris|Lyon|Marseille|Toulouse|Montpellier|N[iî]mes|B[ée]ziers|Avignon|Valence TGV|Aix/i, products: ['AVE INT'] },
  { id: 'andalucia', name: 'Barcelona – Andalucía', re: /Sevilla|M[áa]laga|Granada|C[óo]rdoba|C[áa]diz|Ja[ée]n|Almer[íi]a|Huelva|Algeciras|Antequera/i },
  { id: 'valencia', name: 'Barcelona – València y Alacant', re: /Val[èe]ncia|Valencia|Alacant|Alicante|Castell[óo]|Murcia|Cartagena|Lorca|Elx|Elche/i },
  { id: 'norte', name: 'Barcelona – Norte y Noroeste', re: /Bilbao|Ir[uú]n|Donostia|San Sebasti|Pamplona|Iru[ñn]a|Logro[ñn]o|Vitoria|Gasteiz|Vigo|Coru[ñn]a|Santiago|Ourense|Gij[óo]n|Oviedo|Burgos|Le[óo]n|Valladolid|Salamanca|Santander|Palencia/i },
  { id: 'madrid', name: 'Barcelona – Madrid', re: /^Madrid/i },
  { id: 'avant', name: 'Avant en Catalunya', re: /.*/, products: ['AVANT', 'AVANT EXP'] },
  { id: 'otros', name: 'Otros (Zaragoza, Huesca…)', re: /.*/ },
];
const inCataloniaStrict = (lat, lon) => lat > 40.52 && lat < 42.43 && lon > 0.35 && lon < 3.4;

async function ld() {
  const zip = path.join(CACHE, 'renfe_ld_gtfs.zip');
  console.log('Renfe AV/LD: descargando GTFS (~1 MB)…');
  await download(RENFE_LD_GTFS, zip);
  const z = openZip(zip);
  const read = async (name) => parseCsv(await z.text(name));

  const product = new Map((await read('routes.txt')).map((r) => [r.route_id, r.route_short_name]));
  const stops = new Map((await read('stops.txt')).map((s) => [s.stop_id, s]));
  const catalan = new Set([...stops.values()].filter((s) => inCataloniaStrict(+s.stop_lat, +s.stop_lon)).map((s) => s.stop_id));
  const tripProduct = new Map();
  for (const t of await read('trips.txt')) {
    const p = product.get(t.route_id);
    if (LD_PRODUCTS[p]) tripProduct.set(t.trip_id, p);
  }

  const seq = new Map();
  for (const st of await read('stop_times.txt')) {
    if (!tripProduct.has(st.trip_id)) continue;
    if (!seq.has(st.trip_id)) seq.set(st.trip_id, []);
    seq.get(st.trip_id).push([+st.stop_sequence, st.stop_id]);
  }

  const patterns = [];
  const patternIdx = new Map();
  const trips = {};
  const usedStops = new Set();
  for (const [tripId, rows] of seq) {
    rows.sort((a, b) => a[0] - b[0]);
    const ids = rows.map((r) => r[1]);
    if (!ids.some((id) => catalan.has(id))) continue;
    const p = tripProduct.get(tripId);
    const names = ids.map((id) => stops.get(id)?.stop_name ?? '');
    const corridor = LD_CORRIDORS.find((c) => (!c.products || c.products.includes(p)) && names.some((n) => c.re.test(n))).id;
    const key = ids.join(',');
    if (!patternIdx.has(key)) { patternIdx.set(key, patterns.length); patterns.push(ids); }
    ids.forEach((id) => usedStops.add(id));
    trips[tripId] = [p, patternIdx.get(key), corridor];
  }
  const stations = {};
  for (const id of usedStops) {
    const s = stops.get(id);
    if (s) stations[id] = [s.stop_name, +(+s.stop_lat).toFixed(5), +(+s.stop_lon).toFixed(5)];
  }
  const corridors = Object.fromEntries(LD_CORRIDORS.map((c) => [c.id, { name: c.name }]));
  console.log(`Renfe AV/LD: ${Object.keys(trips).length} trenes que pasan por Catalunya, ${patterns.length} recorridos, ${Object.keys(stations).length} estaciones`);
  return { products: LD_PRODUCTS, corridors, trips, patterns, stations };
}

// ── TRAM (Trambaix y Trambesòs, opendata.tram.cat) ───────────────────────────
// Todas las líneas usan el verde corporativo del TRAM. Cada parada tiene un código por sentido
// (outboundCode / returnCode), que es el que aparece en los tiempos de paso.
const TRAM_API = 'https://opendata.tram.cat/api/v1';
const TRAM_COLOR = '#008d78';
async function tram() {
  console.log('TRAM: descargando líneas y paradas…');
  const get = async (p) => {
    const r = await fetch(`${TRAM_API}/${p}`, { headers: UA });
    if (!r.ok) throw new Error(`TRAM ${p} → HTTP ${r.status}`);
    return r.json();
  };
  const lines = {};
  const stations = {};
  const shapesByLine = new Map();
  const shapes = new Map();
  for (const l of await get('lines')) {
    // page=0 devuelve todas las paradas de la línea (las demás páginas van de 10 en 10)
    const stops = (await get(`lines/${l.id}/stops?page=0`)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const s of stops) s.name = String(s.name).replace(/\s*\|\s*/g, ' | '); // «Ciutadella|V.O.» → «Ciutadella | V.O.»
    if (!stops.length) continue;
    lines[l.name] = {
      color: TRAM_COLOR,
      name: `${stops[0].name} – ${stops.at(-1).name}`,
      network: l.network?.name ?? null,
      stops: stops.map((s) => [s.name, +(+s.latitude).toFixed(6), +(+s.longitude).toFixed(6), s.outboundCode, s.returnCode]),
    };
    for (const s of stops) stations[s.gtfsCode ?? s.id] = [s.name, +s.latitude, +s.longitude];
    // Trazado aproximado: las paradas unidas en orden (el TRAM no publica la geometría de la vía)
    shapesByLine.set(l.name, new Set([`tram-${l.name}`]));
    shapes.set(`tram-${l.name}`, stops.map((s) => [+(+s.longitude).toFixed(5), +(+s.latitude).toFixed(5)]));
  }
  console.log(`TRAM: ${Object.keys(lines).length} líneas, ${Object.keys(stations).length} paradas`);
  return { lines, stations, shapesByLine, shapes };
}

const ops = { renfe: await renfe(), fgc: await fgc(), tram: await tram() };
const ldData = await ld();

const vias = { type: 'FeatureCollection', features: [] };
const estaciones = { type: 'FeatureCollection', features: [] };
for (const [op, d] of Object.entries(ops)) {
  for (const [line, ids] of d.shapesByLine) {
    const coords = dedupe([...ids].map((id) => d.shapes.get(id)).filter((c) => c && c.length > 1));
    if (!coords.length) continue;
    vias.features.push({
      type: 'Feature',
      properties: { op, line, color: d.lines[line]?.color ?? '#888888' },
      geometry: { type: 'MultiLineString', coordinates: coords },
    });
  }
  for (const [id, [name, lat, lon]] of Object.entries(d.stations)) {
    estaciones.features.push({
      type: 'Feature',
      properties: { op, id, name },
      geometry: { type: 'Point', coordinates: [+lon.toFixed(5), +lat.toFixed(5)] },
    });
  }
}

const staticData = {
  generatedAt: new Date().toISOString(),
  renfe: { lines: ops.renfe.lines, stations: ops.renfe.stations, tripDest: ops.renfe.tripDest },
  fgc: { lines: ops.fgc.lines, stations: ops.fgc.stations },
  tram: { lines: ops.tram.lines },
  ld: ldData,
};
fs.writeFileSync(path.join(ROOT, 'data', 'static.json'), JSON.stringify(staticData));
fs.writeFileSync(path.join(ROOT, 'data', 'fgc-horarios.json'), JSON.stringify({ generatedAt: staticData.generatedAt, ...ops.fgc.horarios }));
fs.writeFileSync(path.join(ROOT, 'public', 'data', 'vias.geojson'), JSON.stringify(vias));
fs.writeFileSync(path.join(ROOT, 'public', 'data', 'estaciones.geojson'), JSON.stringify(estaciones));
const kb = (f) => (fs.statSync(path.join(ROOT, f)).size / 1024).toFixed(0) + ' KB';
console.log(`Listo: data/static.json (${kb('data/static.json')}), fgc-horarios.json (${kb('data/fgc-horarios.json')}), vias.geojson (${kb('public/data/vias.geojson')}), estaciones.geojson (${kb('public/data/estaciones.geojson')})`);
