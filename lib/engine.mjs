// Motor de datos: consulta las fuentes abiertas, calcula el estado de cada línea y arma la respuesta.
// Lo usan el servidor local (server.mjs, con sondeo continuo) y las funciones de Vercel (api/, bajo demanda).
// El estado vive en memoria del proceso: en Vercel dura mientras la instancia de la función siga activa.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFeed } from './gtfs-rt.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const UA = { 'user-agent': 'movilidad-bcn/0.1 (datos abiertos)' };

const SRC = {
  renfeVP: 'https://gtfsrt.renfe.com/vehicle_positions.json',
  renfeTU: 'https://gtfsrt.renfe.com/trip_updates.json',
  renfeAL: 'https://gtfsrt.renfe.com/alerts.json',
  ldVP: 'https://gtfsrt.renfe.com/vehicle_positions_LD.json',
  ldTU: 'https://gtfsrt.renfe.com/trip_updates_LD.json',
  fgc: 'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records?limit=100',
  fgcTuRecords: 'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/trip-updates-gtfs_realtime/records?limit=1',
  sct: 'https://www.gencat.cat/transit/opendata/incidenciesGML.xml',
};

// Cadencias. FGC limita a 5.000 peticiones/día por IP sin clave, sumando todos sus conjuntos:
// posiciones cada 30 s (2.880/día) + retrasos cada 60 s (1.440/día) = 4.320/día.
const EVERY = { renfe: 15_000, fgc: 30_000, fgcTu: 60_000, ld: 30_000, alerts: 60_000, sct: 180_000, history: 300_000, static: 24 * 3600_000 };
const ON_TIME_S = 180; // criterio de Renfe: «en hora» con 3 min de retraso o menos
const LD_ON_TIME_S = 300; // AVE y larga distancia: puntual con menos de 5 min
const GRAVE_MEDIAN_S = 15 * 60; // retraso habitual de 15 min o más → Grave
const BIG_DELAY_S = 15 * 60; // umbral para anunciar un tren en «Directo»


const staticFile = path.join(ROOT, 'data', 'static.json');
const fgcSchedFile = path.join(ROOT, 'data', 'fgc-horarios.json');
let STATIC = null;
// Horario de FGC (para calcular retrasos): trips[código] = [[servicio, {parada: segundos}], …]
let FGC_SCHED = null;

// Carga (o recarga, tras regenerarlos) los datos estáticos de data/.
export function loadStatic() {
  if (!fs.existsSync(staticFile)) throw new Error('Faltan los datos estáticos. Ejecuta primero: npm run preparar');
  const s = JSON.parse(fs.readFileSync(staticFile, 'utf8'));
  if (!s.ld) throw new Error('Los datos estáticos son de una versión anterior. Ejecuta: npm run preparar');
  STATIC = s;
  FGC_SCHED = null;
  if (fs.existsSync(fgcSchedFile)) {
    const h = JSON.parse(fs.readFileSync(fgcSchedFile, 'utf8'));
    h.services = Object.fromEntries(Object.entries(h.services).map(([k, v]) => [k, new Set(v)]));
    FGC_SCHED = h;
  }
  return STATIC;
}
loadStatic();
export const staticGeneratedAt = () => STATIC.generatedAt;

const state = {
  renfeTrains: [],
  fgcTrains: [],
  fgcDelays: new Map(), // código de viaje → retraso calculado (s)
  fgcDelaysAt: 0,
  ldTrains: [],
  ldCancelled: [],
  alerts: [],
  roads: [],
  events: [], // «Directo»: hitos recientes generados al detectar cambios
  sources: {
    renfe: { ok: false, receivedAt: null, feedAt: null, count: 0, error: null },
    fgc: { ok: false, receivedAt: null, count: 0, error: null, rateRemaining: null },
    fgcTu: { ok: false, receivedAt: null, count: 0, error: null },
    ld: { ok: false, receivedAt: null, count: 0, cancelled: 0, error: null },
    alerts: { ok: false, receivedAt: null, count: 0, error: null },
    sct: { ok: false, receivedAt: null, count: 0, error: null },
  },
  next: { renfe: 0, fgc: 0, ld: 0 },
};

// Memoria por tren para confirmar retrasos y para el «en lo que va de día».
const prevDelay = new Map(); // tripId → último retraso bruto
const announced = new Map(); // tripId → retraso ya anunciado en «Directo»
let day = { date: localDate(), renfe: new Map(), fgc: new Map(), ld: new Map() }; // trip → último estado del día

function localDate(t = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(t);
}
function rollDay() {
  const d = localDate();
  if (d !== day.date) {
    day = { date: d, renfe: new Map(), fgc: new Map(), ld: new Map() };
    state.events = [];
    announced.clear();
  }
}

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { body: await res.json(), headers: res.headers };
}

function pushEvent(line, op, text) {
  state.events.unshift({ at: Date.now(), line, op, text });
  state.events.length = Math.min(state.events.length, 60);
}

// ── Renfe (GTFS-RT) ──────────────────────────────────────────────────────────
const RODALIES_LINE = /(R\d+[NS]?|RG\d|RT\d|RL\d)$/;

async function pollRenfe() {
  const src = state.sources.renfe;
  try {
    const [vp, tu] = await Promise.all([getJson(SRC.renfeVP), getJson(SRC.renfeTU)]);
    const delayByTrip = new Map();
    for (const e of tu.body.entity ?? []) {
      const t = e.tripUpdate;
      const d = t?.delay ?? t?.stopTimeUpdate?.[0]?.arrival?.delay ?? t?.stopTimeUpdate?.[0]?.departure?.delay;
      if (t?.trip?.tripId && Number.isFinite(d)) delayByTrip.set(t.trip.tripId, d);
    }
    rollDay();
    const trains = [];
    for (const e of vp.body.entity ?? []) {
      const v = e.vehicle;
      const tripId = v?.trip?.tripId ?? '';
      const line = tripId.startsWith('51') && tripId.match(RODALIES_LINE)?.[1];
      if (!line || !STATIC.renfe.lines[line] || !v.position) continue;
      const raw = delayByTrip.has(tripId) ? delayByTrip.get(tripId) : null;
      // Un retraso solo cuenta si se repite en dos lecturas seguidas.
      const prev = prevDelay.get(tripId);
      let delay = raw;
      if (raw != null && raw > ON_TIME_S && !(prev > ON_TIME_S)) delay = prev ?? 0;
      if (raw != null) prevDelay.set(tripId, raw);
      const stop = STATIC.renfe.stations[v.stopId];
      trains.push({
        id: `renfe-${v.vehicle?.id ?? tripId}`,
        operator: 'renfe',
        line,
        lat: v.position.latitude,
        lon: v.position.longitude,
        label: v.vehicle?.label?.replace(/-PLATF\..*$/, '') ?? tripId,
        platform: v.vehicle?.label?.match(/PLATF\.\((\w+)\)/)?.[1] ?? null,
        status: v.currentStatus ?? null,
        stopId: v.stopId ?? null,
        stopName: stop?.[0] ?? null,
        destination: STATIC.renfe.stations[STATIC.renfe.tripDest?.[tripId]]?.[0] ?? null,
        delaySeconds: delay,
        rawDelaySeconds: raw,
        trip: tripId,
        observedAt: v.timestamp ? Number(v.timestamp) * 1000 : null,
      });
      if (delay != null) {
        day.renfe.set(tripId, { line, delay });
        const done = announced.get(tripId) ?? 0;
        if (delay >= BIG_DELAY_S && delay >= done + 10 * 60) {
          announced.set(tripId, delay);
          pushEvent(line, 'renfe', `un tren lleva ${Math.round(delay / 60)} min de retraso`);
        }
      }
    }
    // Limpieza de trenes que ya no circulan
    const live = new Set(trains.map((t) => t.trip));
    for (const k of prevDelay.keys()) if (!k.startsWith('ld:') && !live.has(k)) prevDelay.delete(k);

    state.renfeTrains = trains;
    Object.assign(src, { ok: true, receivedAt: Date.now(), feedAt: Number(vp.body.header?.timestamp) * 1000 || null, count: trains.length, error: null });
  } catch (err) {
    Object.assign(src, { ok: false, error: String(err.message ?? err) });
  }
  state.next.renfe = Date.now() + EVERY.renfe;
}

async function pollAlerts() {
  const src = state.sources.alerts;
  try {
    const { body } = await getJson(SRC.renfeAL);
    const now = Date.now();
    const alerts = [];
    for (const e of body.entity ?? []) {
      const a = e.alert;
      const routes = (a?.informedEntity ?? []).map((i) => (i.routeId ?? '').trim()).filter((r) => r.startsWith('51T'));
      if (!routes.length) continue;
      const lines = [...new Set(routes.map((r) => r.replace(/^51T\d{4}/, '')))].filter((l) => STATIC.renfe.lines[l]);
      const tr = a.descriptionText?.translation ?? [];
      // El feed marca ambas traducciones como «es»: la primera es castellano y la segunda catalán.
      const periods = (a.activePeriod ?? []).map((p) => ({ from: p.start ? Number(p.start) * 1000 : null, to: p.end ? Number(p.end) * 1000 : null }));
      const active = periods.length === 0 || periods.some((p) => (!p.from || p.from <= now) && (!p.to || p.to > now));
      const upcoming = !active && periods.some((p) => p.from && p.from > now);
      alerts.push({
        id: `renfe-${e.id}`,
        operator: 'renfe',
        lines,
        description: tr[0]?.text ?? '',
        descriptionCa: tr[1]?.text ?? tr[0]?.text ?? '',
        from: periods[0]?.from ?? null,
        to: periods[0]?.to ?? null,
        active,
        upcoming,
      });
    }
    alerts.sort((x, y) => (y.from ?? 0) - (x.from ?? 0));
    state.alerts = alerts;
    Object.assign(src, { ok: true, receivedAt: Date.now(), count: alerts.length, error: null });
  } catch (err) {
    Object.assign(src, { ok: false, error: String(err.message ?? err) });
  }
}

// ── FGC (Geotren, datos abiertos) ────────────────────────────────────────────
function fgcStation(code) {
  return STATIC.fgc.stations[code]?.[0] ?? code;
}

// Medianoche (hora de Madrid) de un día de servicio AAAAMMDD, en segundos epoch.
function madridMidnight(day) {
  const y = +day.slice(0, 4), m = +day.slice(4, 6) - 1, d = +day.slice(6, 8);
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(Date.UTC(y, m, d, 12)));
  return Date.UTC(y, m, d) / 1000 - (h - 12) * 3600;
}

// Retraso de un viaje = hora prevista (tiempo real) − hora programada (horario), en su próxima parada.
// Si el código de viaje existe en varios servicios del día, se queda el más cercano a la previsión.
function fgcDelayFor(tu) {
  const code = (tu.trip?.tripId ?? '').split('|')[1];
  const cands = FGC_SCHED?.trips[code];
  if (!cands) return null;
  const day = tu.trip.startDate || localDate().replaceAll('-', '');
  const base = madridMidnight(day);
  let best = null;
  for (const [svc, stops] of cands) {
    if (!FGC_SCHED.services[svc]?.has(day)) continue;
    const u = tu.stopTimeUpdate.find((x) => stops[x.stopId] != null && (x.arrival?.time || x.departure?.time));
    if (!u) continue;
    const d = (u.arrival?.time ?? u.departure?.time) - (base + stops[u.stopId]);
    if (best == null || Math.abs(d) < Math.abs(best)) best = d;
  }
  return best != null && Math.abs(best) < 3 * 3600 ? best : null;
}

// El fichero .pb tiene una URL de descarga que puede cambiar: se resuelve al empezar y si da 404.
let fgcTuUrl = null;
async function resolveFgcTuUrl() {
  const { body } = await getJson(SRC.fgcTuRecords);
  fgcTuUrl = body.results?.[0]?.file?.url ?? null;
  if (!fgcTuUrl) throw new Error('sin fichero de trip updates');
}

async function pollFgcDelays() {
  const src = state.sources.fgcTu;
  try {
    if (!FGC_SCHED) throw new Error('falta data/fgc-horarios.json (npm run preparar)');
    if (!fgcTuUrl) await resolveFgcTuUrl();
    const get = () => fetch(fgcTuUrl, { headers: UA, signal: AbortSignal.timeout(12_000) });
    let res = await get();
    if (res.status === 404) { await resolveFgcTuUrl(); res = await get(); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feed = decodeFeed(Buffer.from(await res.arrayBuffer()));
    const delays = new Map();
    for (const e of feed.entity) {
      if (!e.tripUpdate?.trip?.tripId) continue;
      const d = fgcDelayFor(e.tripUpdate);
      if (d != null) delays.set(e.tripUpdate.trip.tripId.split('|')[1], d);
    }
    state.fgcDelays = delays;
    state.fgcDelaysAt = Date.now();
    Object.assign(src, { ok: true, receivedAt: Date.now(), count: delays.size, error: null });
  } catch (err) {
    Object.assign(src, { ok: false, error: String(err.message ?? err) });
  }
}

// Un tren de FGC va con retraso si lleva más de 3 min (como Rodalies); sin minutos, se usa el «en hora» oficial.
const fgcLate = (t) => (t.delaySeconds != null ? t.delaySeconds > ON_TIME_S : !t.onTime);

async function pollFgc() {
  const src = state.sources.fgc;
  try {
    const { body, headers } = await getJson(SRC.fgc);
    rollDay();
    const trains = [];
    for (const r of body.results ?? []) {
      if (!r.geo_point_2d) continue;
      const next = [...String(r.properes_parades ?? '').matchAll(/"parada":\s*"(\w+)"/g)].map((m) => m[1]);
      const onTime = String(r.en_hora).toLowerCase() === 'true';
      const code = String(r.id ?? '').split('|')[1];
      const fresh = Date.now() - state.fgcDelaysAt < 5 * 60_000;
      const delay = fresh && state.fgcDelays.has(code) ? Math.max(0, state.fgcDelays.get(code)) : null;
      // Ocupación por coche (MI, RI, M1, M2). Muchos trenes no la publican: un campo vacío no cuenta como 0 %.
      const occ = ['mi', 'ri', 'm1', 'm2'].map((k) => r[`ocupacio_${k}_percent`]).filter((v) => v != null && v !== '').map(Number).filter(Number.isFinite);
      trains.push({
        id: `fgc-${r.ut ?? r.id}`,
        operator: 'fgc',
        line: r.lin,
        lat: r.geo_point_2d.lat,
        lon: r.geo_point_2d.lon,
        label: `${r.lin} ${fgcStation(r.origen)} → ${fgcStation(r.desti)}`,
        onTime,
        delaySeconds: delay,
        origin: fgcStation(r.origen),
        destination: fgcStation(r.desti),
        nextStops: next.map(fgcStation),
        parkedAt: r.estacionat_a ? fgcStation(r.estacionat_a) : null,
        occupancyPct: occ.length ? Math.round(occ.reduce((a, b) => a + b, 0) / occ.length) : null,
        trip: r.id,
      });
      day.fgc.set(r.id, { line: r.lin, onTime: !fgcLate(trains.at(-1)) });
    }
    state.fgcTrains = trains;
    Object.assign(src, { ok: true, receivedAt: Date.now(), count: trains.length, error: null, rateRemaining: Number(headers.get('x-ratelimit-remaining')) || null });
  } catch (err) {
    Object.assign(src, { ok: false, error: String(err.message ?? err) });
  }
  state.next.fgc = Date.now() + EVERY.fgc;
}

// ── AVE y larga distancia (Renfe GTFS-RT LD) ─────────────────────────────────
// Solo los trenes que paran en alguna estación de Catalunya (filtrados al preparar los datos).
async function pollLd() {
  const src = state.sources.ld;
  try {
    const L = STATIC.ld;
    const [vp, tu] = await Promise.all([getJson(SRC.ldVP), getJson(SRC.ldTU)]);
    const delayByTrip = new Map();
    const cancelled = [];
    for (const e of tu.body.entity ?? []) {
      const t = e.tripUpdate;
      const id = t?.trip?.tripId;
      if (!id || !L.trips[id]) continue;
      if (t.trip.scheduleRelationship === 'CANCELED') { cancelled.push(id); continue; }
      const d = t.delay ?? t.stopTimeUpdate?.[0]?.arrival?.delay ?? t.stopTimeUpdate?.[0]?.departure?.delay;
      if (Number.isFinite(d)) delayByTrip.set(id, d);
    }
    rollDay();
    // Nombres largos de Renfe → ciudad («Madrid-Puerta de Atocha-Almudena Grandes» → «Madrid»)
    const name = (sid) => {
      const n = L.stations[sid]?.[0];
      if (!n) return null;
      return n.length > 22 ? n.split(/[-/]/)[0].trim() : n;
    };
    const stopsOf = (id) => L.patterns[L.trips[id][1]].length;
    // Renfe publica un mismo tren una vez por cada variante de recorrido (trip_id = número de 5 cifras
    // + dígito de variante + fecha). Se queda la variante con más paradas: el recorrido completo.
    const best = new Map();
    for (const e of vp.body.entity ?? []) {
      const v = e.vehicle;
      const id = v?.trip?.tripId;
      if (!id || !L.trips[id] || !v.position) continue;
      const k = v.vehicle?.id ?? id.slice(0, 5);
      const cur = best.get(k);
      if (!cur || stopsOf(id) > stopsOf(cur.vehicle.trip.tripId)) best.set(k, e);
    }
    const trains = [];
    const live = new Set();
    for (const [vehicleKey, e] of best) {
      const v = e.vehicle;
      const id = v.trip.tripId;
      const [product, pat, corridor] = L.trips[id];
      const seq = L.patterns[pat];
      const raw = delayByTrip.has(id) ? delayByTrip.get(id) : null;
      const key = `ld:${vehicleKey}`;
      live.add(key);
      const prev = prevDelay.get(key);
      let delay = raw;
      if (raw != null && raw > LD_ON_TIME_S && !(prev > LD_ON_TIME_S)) delay = prev ?? 0;
      if (raw != null) prevDelay.set(key, raw);
      const t = {
        id: `ld-${vehicleKey}`,
        operator: 'ld',
        line: product,
        product,
        productName: L.products[product]?.name ?? product,
        corridor,
        lat: v.position.latitude,
        lon: v.position.longitude,
        number: v.vehicle?.label ?? null,
        origin: name(seq[0]),
        destination: name(seq.at(-1)),
        // Recorrido por sus estaciones (Renfe no publica el trazado de larga distancia)
        route: seq.map((sid) => L.stations[sid]).filter(Boolean).map(([, lat, lon]) => [lon, lat]),
        stopName: name(v.stopId),
        status: v.currentStatus ?? null,
        delaySeconds: delay,
        rawDelaySeconds: raw,
        trip: id,
      };
      trains.push(t);
      if (delay != null) {
        day.ld.set(vehicleKey, { corridor, delay });
        const done = announced.get(key) ?? 0;
        if (delay >= BIG_DELAY_S && delay >= done + 10 * 60) {
          announced.set(key, delay);
          pushEvent(product, 'ld', `${t.origin} → ${t.destination}: ${Math.round(delay / 60)} min de retraso`);
        }
      }
    }
    for (const k of prevDelay.keys()) if (k.startsWith('ld:') && !live.has(k)) prevDelay.delete(k);
    // Cancelaciones: también una por variante; se agrupan por número de tren y fecha.
    const cancelledBest = new Map();
    for (const id of cancelled) {
      const k = id.slice(0, 5) + id.slice(6);
      const cur = cancelledBest.get(k);
      if (!cur || stopsOf(id) > stopsOf(cur)) cancelledBest.set(k, id);
    }
    state.ldTrains = trains;
    state.ldCancelled = [...cancelledBest.values()];
    // La cabecera del feed de posiciones LD va una hora por detrás (zona horaria): se guarda la hora de recepción.
    Object.assign(src, { ok: true, receivedAt: Date.now(), count: trains.length, cancelled: state.ldCancelled.length, error: null });
  } catch (err) {
    Object.assign(src, { ok: false, error: String(err.message ?? err) });
  }
  state.next.ld = Date.now() + EVERY.ld;
}

// ── Carreteras (Servei Català de Trànsit) ────────────────────────────────────
const CA_ES = {
  'Calçada restringida': 'Calzada restringida',
  'Calçada tallada': 'Calzada cortada',
  'Circulació amb retencions': 'Circulación con retenciones',
  'Circulació amb congestió': 'Circulación con congestión',
  'Circulació intensa': 'Circulación intensa',
  'Desviaments': 'Desvíos',
  Boira: 'Niebla',
  Obres: 'Obras',
  Retenció: 'Retención',
  Meterologia: 'Meteorología',
  'Ambdos sentits': 'Ambos sentidos',
  Creixent: 'Creciente',
  Decreixent: 'Decreciente',
  Circulació: 'Circulación',
  Accident: 'Accidente',
  Avaria: 'Avería',
  Manifestació: 'Manifestación',
  Neteja: 'Limpieza',
  'Treballs de manteniment': 'Trabajos de mantenimiento',
  'Obres en general': 'Obras en general',
  'Grans obres': 'Grandes obras',
  Esllavissada: 'Desprendimiento',
};
const tr = (s) => s.split('. ').map((p) => CA_ES[p] ?? p).join('. ');

async function pollSct() {
  const src = state.sources.sct;
  try {
    const res = await fetch(SRC.sct, { headers: UA, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const field = (blk, k) => blk.match(new RegExp(`<cite:${k}>([\\s\\S]*?)</cite:${k}>`))?.[1]?.trim() ?? null;
    const roads = [];
    for (const [, blk] of xml.matchAll(/<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g)) {
      const [lon, lat] = (blk.match(/<gml:coordinates[^>]*>([^<]+)</)?.[1] ?? '').split(',').map(Number);
      const desc = field(blk, 'descripcio') ?? '';
      roads.push({
        id: field(blk, 'identificador'),
        road: field(blk, 'carretera'),
        pkFrom: Number(field(blk, 'pk_inici')),
        pkTo: Number(field(blk, 'pk_fi')),
        towards: field(blk, 'cap_a'),
        direction: tr(field(blk, 'sentit') ?? ''),
        type: tr(field(blk, 'descripcio_tipus') ?? ''),
        cause: tr(field(blk, 'causa') ?? ''),
        description: tr(desc),
        descriptionCa: desc,
        level: Number(field(blk, 'nivell')),
        at: Date.parse(field(blk, 'data') ?? '') || null,
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
      });
    }
    // Primero retenciones y cortes, después por nivel de afectación
    const rank = (r) => (r.type === 'Retención' ? 0 : /cortada/i.test(r.description) ? 1 : 2);
    roads.sort((a, b) => rank(a) - rank(b) || b.level - a.level || (b.at ?? 0) - (a.at ?? 0));
    state.roads = roads;
    Object.assign(src, { ok: true, receivedAt: Date.now(), count: roads.length, error: null });
  } catch (err) {
    Object.assign(src, { ok: false, error: String(err.message ?? err) });
  }
}

// ── Estado de las líneas ─────────────────────────────────────────────────────
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function renfeService() {
  const out = {};
  const alerted = new Set(state.alerts.filter((a) => a.active).flatMap((a) => a.lines));
  const dayBy = new Map();
  for (const { line, delay } of day.renfe.values()) {
    const d = dayBy.get(line) ?? { trips: 0, onTime: 0 };
    d.trips++;
    if (delay <= ON_TIME_S) d.onTime++;
    dayBy.set(line, d);
  }
  for (const [line, info] of Object.entries(STATIC.renfe.lines)) {
    const trains = state.renfeTrains.filter((t) => t.line === line);
    const delays = trains.map((t) => t.delaySeconds).filter((d) => d != null);
    const med = median(delays);
    const max = delays.length ? Math.max(...delays) : null;
    const onTime = delays.filter((d) => d <= ON_TIME_S).length;
    let status = 'sin-trenes';
    if (trains.length) {
      if (med != null && med >= GRAVE_MEDIAN_S) status = 'grave';
      else if ((med != null && med > ON_TIME_S) || (max != null && max >= GRAVE_MEDIAN_S)) status = 'retrasos';
      else status = alerted.has(line) ? 'aviso' : 'normal';
    } else if (alerted.has(line)) status = 'aviso';
    const d = dayBy.get(line);
    out[line] = {
      color: info.color,
      name: info.name,
      status,
      trains: trains.length,
      withDelayData: delays.length,
      onTime,
      medianDelaySeconds: med,
      maxDelaySeconds: max,
      alert: alerted.has(line),
      today: d ? { trips: d.trips, onTimePct: Math.round((100 * d.onTime) / d.trips) } : null,
    };
  }
  return out;
}

function fgcService() {
  const out = {};
  const dayBy = new Map();
  for (const { line, onTime } of day.fgc.values()) {
    const d = dayBy.get(line) ?? { trips: 0, onTime: 0 };
    d.trips++;
    if (onTime) d.onTime++;
    dayBy.set(line, d);
  }
  for (const [line, info] of Object.entries(STATIC.fgc.lines)) {
    const trains = state.fgcTrains.filter((t) => t.line === line);
    const late = trains.filter(fgcLate).length;
    const delays = trains.map((t) => t.delaySeconds).filter((d) => d != null);
    const med = median(delays);
    const max = delays.length ? Math.max(...delays) : null;
    let status = 'sin-trenes';
    if (trains.length) {
      if ((med != null && med >= GRAVE_MEDIAN_S) || (trains.length >= 2 && late / trains.length >= 0.5)) status = 'grave';
      else if (late > 0 || (max != null && max >= GRAVE_MEDIAN_S)) status = 'retrasos';
      else status = 'normal';
    }
    const d = dayBy.get(line);
    out[line] = {
      color: info.color,
      name: info.name,
      status,
      trains: trains.length,
      withDelayData: delays.length,
      onTime: trains.length - late,
      medianDelaySeconds: med,
      maxDelaySeconds: max,
      today: d ? { trips: d.trips, onTimePct: Math.round((100 * d.onTime) / d.trips) } : null,
    };
  }
  return out;
}

function ldService() {
  const L = STATIC.ld;
  const out = {};
  const dayBy = new Map();
  for (const { corridor, delay } of day.ld.values()) {
    const d = dayBy.get(corridor) ?? { trips: 0, onTime: 0 };
    d.trips++;
    if (delay <= LD_ON_TIME_S) d.onTime++;
    dayBy.set(corridor, d);
  }
  const cancelledBy = new Map();
  for (const id of state.ldCancelled) {
    const c = L.trips[id]?.[2];
    if (c) cancelledBy.set(c, (cancelledBy.get(c) ?? 0) + 1);
  }
  for (const [id, info] of Object.entries(L.corridors)) {
    const trains = state.ldTrains.filter((t) => t.corridor === id);
    const delays = trains.map((t) => t.delaySeconds).filter((d) => d != null);
    const med = median(delays);
    const late15 = delays.filter((d) => d >= BIG_DELAY_S).length;
    const cancelled = cancelledBy.get(id) ?? 0;
    let status = 'sin-trenes';
    if (trains.length) {
      if ((med != null && med >= GRAVE_MEDIAN_S) || (trains.length >= 2 && late15 / trains.length >= 0.5)) status = 'grave';
      else if ((med != null && med > LD_ON_TIME_S) || late15 > 0) status = 'retrasos';
      else status = cancelled ? 'aviso' : 'normal';
    } else if (cancelled) status = 'aviso';
    const d = dayBy.get(id);
    out[id] = {
      name: info.name,
      status,
      trains: trains.length,
      withDelayData: delays.length,
      onTime: delays.filter((x) => x <= LD_ON_TIME_S).length,
      late15,
      medianDelaySeconds: med,
      maxDelaySeconds: delays.length ? Math.max(...delays) : null,
      cancelled,
      worst: trains.filter((t) => t.delaySeconds > LD_ON_TIME_S).sort((a, b) => b.delaySeconds - a.delaySeconds).slice(0, 3)
        .map((t) => ({ id: t.id, product: t.product, productName: t.productName, origin: t.origin, destination: t.destination, nextStop: t.stopName, delayMin: Math.round(t.delaySeconds / 60) })),
      today: d ? { trips: d.trips, onTimePct: Math.round((100 * d.onTime) / d.trips) } : null,
    };
  }
  return out;
}

function buildLive() {
  return {
    queriedAt: Date.now(),
    trains: [...state.renfeTrains, ...state.fgcTrains, ...state.ldTrains],
    alerts: state.alerts,
    railService: { renfe: renfeService(), fgc: fgcService(), ld: ldService() },
    ldProducts: STATIC.ld.products,
    events: state.events,
    sources: state.sources,
  };
}

// ── Refresco bajo demanda ────────────────────────────────────────────────────
// Cada fuente se vuelve a pedir solo si sus datos tienen más de EVERY[fuente]; las peticiones
// simultáneas comparten la misma consulta. FGC: primero los retrasos y luego las posiciones.
const POLLERS = { renfe: pollRenfe, fgcTu: pollFgcDelays, fgc: pollFgc, ld: pollLd, alerts: pollAlerts, sct: pollSct };
export const SOURCES = Object.keys(POLLERS);
const lastRun = Object.fromEntries(SOURCES.map((k) => [k, 0]));
const inflight = {};
function run(kind) {
  inflight[kind] ??= POLLERS[kind]().finally(() => { lastRun[kind] = Date.now(); inflight[kind] = null; });
  return inflight[kind];
}
const due = (k) => Date.now() - lastRun[k] >= EVERY[k];
export async function ensureFresh(kinds = SOURCES) {
  if (kinds.includes('fgcTu') && (due('fgcTu') || inflight.fgcTu)) await run('fgcTu');
  await Promise.all(kinds.filter((k) => k !== 'fgcTu' && (due(k) || inflight[k])).map(run));
}

// Segundos hasta que haya datos nuevos de trenes (cabecera x-data-next, como en la web original).
export function nextHintSeconds() {
  return Math.max(0, Math.min(state.next.renfe, state.next.fgc, state.next.ld) - Date.now()) / 1000;
}

export function roadsPayload() {
  return { queriedAt: Date.now(), source: state.sources.sct, incidents: state.roads };
}

// Fila del historial (el servidor local la guarda cada 5 minutos).
export function historyRow() {
  const live = buildLive();
  const pick = (svc) => Object.fromEntries(Object.entries(svc).filter(([, v]) => v.trains).map(([k, v]) => [k, { n: v.trains, ok: v.onTime, s: v.status }]));
  return { t: live.queriedAt, renfe: pick(live.railService.renfe), fgc: pick(live.railService.fgc), ld: pick(live.railService.ld) };
}

export function summary() {
  const s = state.sources;
  return `Rodalies: ${s.renfe.ok ? s.renfe.count + ' trenes' : 'error ' + s.renfe.error} · FGC: ${s.fgc.ok ? s.fgc.count + ' trenes' : 'error ' + s.fgc.error} (retrasos: ${s.fgcTu.ok ? s.fgcTu.count + ' viajes' : 'error ' + s.fgcTu.error}) · AVE/LD: ${s.ld.ok ? `${s.ld.count} trenes, ${s.ld.cancelled} cancelados` : 'error ' + s.ld.error} · Avisos: ${s.alerts.count} · Carreteras: ${s.sct.count}`;
}

export { EVERY, buildLive };
