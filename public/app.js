// Cliente: sondea /api/live (como la web original), anima los trenes y pinta cada compañía en su pestaña.
'use strict';

const POLL_MS = 10_000;
const MIN_MS = 2_000;
const MAX_MS = 12_000;
const LAG_MS = 700;
const ANIM_MS = 2_500;
const STALE_MS = 45_000;
const MAX_DOTS = 24;

// Pestaña → operador de los trenes, encuadre del mapa y umbral de puntualidad (s).
const TABS = {
  rodalies: { op: 'renfe', bounds: [[1.2, 40.95], [3.0, 42.1]] },
  fgc: { op: 'fgc', bounds: [[1.55, 41.25], [2.3, 41.85]] },
  tram: { op: 'tram', bounds: [[2.03, 41.355], [2.235, 41.43]] },
  ave: { op: 'ld', bounds: [[-9.4, 36.0], [5.6, 45.9]] },
  bus: { op: null, bounds: [[1.85, 41.25], [3.3, 42.1]] },
  carreteras: { op: null, bounds: [[0.15, 40.5], [3.35, 42.9]] },
};
const ON_TIME = { renfe: 180, fgc: 180, tram: 180, ld: 300 };

// focus: línea, corredor o tren seleccionado → { op, kind: 'line' | 'corridor', id, trainId? }
const S = { live: null, roads: [], anim: new Map(), tab: 'rodalies', open: new Set(), focus: null, timer: null, mapReady: false };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hhmm = (t) => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
const min = (s) => Math.round(s / 60);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const badge = (line, color) => `<span class="badge" style="background:${esc(color)}">${esc(line)}</span>`;
const STATUS = { normal: 'Normal', retrasos: 'Retrasos', grave: 'Grave', aviso: 'Aviso', 'sin-trenes': 'Sin trenes' };
const RANK = { grave: 3, retrasos: 2, aviso: 1, normal: 0, 'sin-trenes': -1 };

function lineOrder(a, b) {
  const k = (l) => {
    const m = l.match(/^([A-Z]+)(\d+)?([A-Z]*)$/) ?? [];
    const group = { R: 0, S: 1, L: 2 }[m[1]] ?? (m[1]?.length > 1 ? 3 : 4);
    return [group, m[1] ?? l, Number(m[2] ?? 0), m[3] ?? ''];
  };
  const [x, y] = [k(a), k(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function colorOf(t) {
  if (t.operator === 'ld') return S.live?.ldProducts?.[t.product]?.color ?? '#6a2c91';
  return S.live?.railService?.[t.operator]?.[t.line]?.color ?? '#777';
}
// Gravedad de un tren: 0 en hora, 1 retraso, 2 ≥ 15 min, 'u' sin dato.
// FGC: con minutos (calculados con su horario) como Rodalies; sin ellos, su «en hora» oficial.
function sev(t) {
  if (t.operator === 'fgc' && t.delaySeconds == null) return t.onTime ? 0 : 1;
  if (t.delaySeconds == null) return 'u';
  return t.delaySeconds >= 900 ? 2 : t.delaySeconds > ON_TIME[t.operator] ? 1 : 0;
}
const sevRank = (t) => ({ 2: 3, 1: 2, 0: 0, u: 1 })[sev(t)];
const byWorst = (a, b) => sevRank(b) - sevRank(a) || (b.delaySeconds ?? 0) - (a.delaySeconds ?? 0);
function worstStatus(svc) {
  return Object.values(svc ?? {}).reduce((w, v) => (RANK[v.status] > RANK[w] ? v.status : w), 'sin-trenes');
}

// ── Mapa ─────────────────────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  bounds: TABS.rodalies.bounds,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');

const empty = { type: 'FeatureCollection', features: [] };
const SEV_COLOR = ['match', ['get', 'sev'], '2', '#d23b2f', '1', '#e08a00', 'u', '#9a9a9a', '#ffffff'];
const GREY = '#bdbdbd';

map.on('load', () => {
  map.addSource('vias', { type: 'geojson', data: 'data/vias.geojson' });
  map.addSource('estaciones', { type: 'geojson', data: 'data/estaciones.geojson' });
  map.addSource('trenes', { type: 'geojson', data: empty });
  map.addSource('carreteras', { type: 'geojson', data: empty });
  map.addSource('ruta', { type: 'geojson', data: empty });
  map.addSource('bus-ruta', { type: 'geojson', data: empty });
  map.addSource('bus-paradas', { type: 'geojson', data: empty });

  map.addLayer({ id: 'vias', type: 'line', source: 'vias', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 13, 4], 'line-opacity': 0.7 } });
  map.addLayer({ id: 'estaciones', type: 'circle', source: 'estaciones', minzoom: 11, paint: { 'circle-radius': 3, 'circle-color': '#fff', 'circle-stroke-color': '#777', 'circle-stroke-width': 1 } });
  map.addLayer({ id: 'estaciones-nombre', type: 'symbol', source: 'estaciones', minzoom: 13, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1], 'text-anchor': 'top' }, paint: { 'text-color': '#555', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
  map.addLayer({ id: 'carreteras', type: 'circle', source: 'carreteras', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'level'], 2, 4, 5, 8], 'circle-color': ['case', ['==', ['get', 'type'], 'Retención'], '#d23b2f', '#555'], 'circle-opacity': 0.8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  // Bus Moventis: recorrido y paradas de la línea abierta
  map.addLayer({ id: 'bus-ruta', type: 'line', source: 'bus-ruta', layout: { 'line-join': 'round', 'line-cap': 'round', visibility: 'none' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'bus-paradas', type: 'circle', source: 'bus-paradas', layout: { visibility: 'none' }, paint: { 'circle-radius': ['case', ['get', 'sel'], 8, 5], 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': ['case', ['get', 'sel'], 4, 2.5] } });
  // Recorrido del AVE seleccionado y halo del tren seleccionado
  map.addLayer({ id: 'ruta', type: 'line', source: 'ruta', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': 0.85, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'tren-sel', type: 'circle', source: 'trenes', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 12, 13, 19], 'circle-color': ['get', 'color'], 'circle-opacity': 0.25, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2 } });
  map.addLayer({
    id: 'trenes', type: 'circle', source: 'trenes',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4.5, 13, 8],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 2, 13, 3],
      'circle-stroke-color': SEV_COLOR,
    },
  });
  // Minutos de retraso junto al tren; si se solapan, se priorizan los de más retraso
  map.addLayer({
    id: 'trenes-retraso', type: 'symbol', source: 'trenes', filter: ['>', ['get', 'mins'], 0],
    layout: { 'text-field': ['concat', '+', ['to-string', ['get', 'mins']], ' min'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10.5, 13, 12.5], 'text-offset': [0.95, 0], 'text-anchor': 'left', 'symbol-sort-key': ['-', 0, ['get', 'mins']] },
    paint: { 'text-color': ['match', ['get', 'sev'], '2', '#c62f24', '#b86e00'], 'text-halo-color': '#ffffff', 'text-halo-width': 1.8 },
  });
  map.addLayer({ id: 'trenes-linea', type: 'symbol', source: 'trenes', minzoom: 11, layout: { 'text-field': ['get', 'line'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, -1.4], 'text-allow-overlap': true }, paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });

  for (const id of ['trenes', 'carreteras']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', 'trenes', (e) => selectTrain(e.features[0].properties.id, { fly: false, lngLat: e.lngLat }));
  map.on('click', 'carreteras', (e) => popupRoad(e.features[0], e.lngLat));
  map.on('click', 'bus-paradas', (e) => openBusStop(e.features[0].properties.id));
  for (const id of ['bus-paradas']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
  // Pulsar el mapa fuera de un tren quita la selección
  map.on('click', (e) => {
    if (S.focus && !map.queryRenderedFeatures(e.point, { layers: ['trenes'] }).length) clearFocus();
  });

  S.mapReady = true;
  // En móvil la atribución empieza plegada en su botón «i» para no tapar la leyenda
  if (matchMedia('(max-width: 860px)').matches) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  applyMapTab(false);
  if (S.live) setTrains(S.live.trains);
  drawRoads();
});

// Capas visibles según la pestaña: cada compañía con sus vías y sus trenes.
function railFilter(op) {
  return ['==', ['get', 'op'], op];
}
function applyMapTab(animate = true) {
  if (!S.mapReady) return;
  const { op, bounds } = TABS[S.tab];
  const show = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const railOp = ['renfe', 'fgc', 'tram'].includes(op) ? op : null;
  for (const id of ['vias', 'estaciones', 'estaciones-nombre']) {
    show(id, !!railOp);
    if (railOp) map.setFilter(id, railFilter(railOp));
  }
  show('trenes', !!op);
  show('trenes-linea', !!op);
  show('trenes-retraso', !!op);
  show('carreteras', S.tab === 'carreteras');
  show('bus-ruta', S.tab === 'bus');
  show('bus-paradas', S.tab === 'bus');
  $('#legend').hidden = !op;
  map.fitBounds(bounds, { padding: 30, duration: animate ? 900 : 0 });
  applyFocus();
  frame();
}

// ── Selección: la línea elegida en color, el resto en gris ───────────────────
function focusMatch(f) {
  return f.kind === 'corridor' ? ['==', ['get', 'corridor'], f.id] : ['==', ['get', 'line'], f.id];
}
function applyFocus() {
  if (!S.mapReady) return;
  const f = S.focus;
  const m = f ? focusMatch(f) : null;
  const pick = (on, off) => (m ? ['case', m, on, off] : on);
  map.setPaintProperty('vias', 'line-color', pick(['get', 'color'], GREY));
  map.setPaintProperty('vias', 'line-opacity', pick(m ? 0.95 : 0.7, 0.45));
  map.setPaintProperty('vias', 'line-width', ['interpolate', ['linear'], ['zoom'], 8, pick(m ? 3.5 : 1.5, 1.2), 13, pick(m ? 7 : 4, 2.5)]);
  map.setLayoutProperty('vias', 'line-sort-key', pick(1, 0));
  map.setPaintProperty('trenes', 'circle-color', pick(['get', 'color'], GREY));
  map.setPaintProperty('trenes', 'circle-opacity', pick(1, 0.5));
  map.setPaintProperty('trenes', 'circle-stroke-opacity', pick(1, 0.5));
  map.setPaintProperty('trenes', 'circle-radius', ['interpolate', ['linear'], ['zoom'], 5, pick(m ? 5.5 : 4.5, 3.5), 13, pick(m ? 9.5 : 8, 6)]);
  map.setLayoutProperty('trenes', 'circle-sort-key', pick(1, 0));
  map.setPaintProperty('trenes-linea', 'text-opacity', pick(1, 0));
  map.setPaintProperty('trenes-retraso', 'text-opacity', pick(1, 0));
  map.setFilter('tren-sel', ['==', ['get', 'id'], f?.trainId ?? '']);
  // AVE: recorrido por sus estaciones del tren (o de todo el corredor) seleccionado
  const routes = f?.op !== 'ld' ? [] : [...S.anim.values()].map((a) => a.train)
    .filter((t) => t.operator === 'ld' && (f.trainId ? t.id === f.trainId : t.corridor === f.id) && t.route?.length > 1)
    .map((t) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.route }, properties: { color: colorOf(t) } }));
  map.getSource('ruta').setData({ type: 'FeatureCollection', features: routes });
  renderFocusChip();
}

function renderFocusChip() {
  const el = $('#focus');
  const f = S.focus;
  if (!f || !S.live) { el.hidden = true; return; }
  let label;
  if (f.op === 'ld') {
    const t = f.trainId && S.anim.get(f.trainId)?.train;
    label = t ? `${badge(t.productName, colorOf(t))}<span>${trainTitle(t, true)}</span>` : `<span>${esc(S.live.railService.ld[f.id]?.name ?? f.id)}</span>`;
  } else {
    const v = S.live.railService[f.op]?.[f.id];
    label = `${badge(f.id, v?.color ?? '#777')}<span>${esc(v?.name ?? '')}</span>`;
  }
  el.querySelector('.focus-label').innerHTML = label;
  el.hidden = false;
}

function setFocus(f) {
  S.focus = f;
  applyFocus();
  if (S.live) renderGroups(S.live);
}
function clearFocus() {
  if (!S.focus) return;
  S.popup?.remove();
  setFocus(null);
}

// Cada tren se desliza desde donde está pintado hasta su nueva posición.
function setTrains(trains) {
  const now = performance.now();
  const seen = new Set();
  for (const t of trains) {
    seen.add(t.id);
    const a = S.anim.get(t.id);
    const cur = a ? position(a, now) : [t.lon, t.lat];
    S.anim.set(t.id, { from: cur, to: [t.lon, t.lat], t0: now, train: t });
  }
  for (const id of S.anim.keys()) if (!seen.has(id)) S.anim.delete(id);
  requestAnimationFrame(frame);
}
function position(a, now) {
  const k = Math.min(1, (now - a.t0) / ANIM_MS);
  const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  return [a.from[0] + (a.to[0] - a.from[0]) * e, a.from[1] + (a.to[1] - a.from[1]) * e];
}
function frame() {
  if (!S.mapReady) return;
  const op = TABS[S.tab].op;
  const now = performance.now();
  let moving = false;
  const features = [];
  for (const [id, a] of S.anim) {
    const t = a.train;
    if (t.operator !== op) continue;
    if (now - a.t0 < ANIM_MS) moving = true;
    const s = sev(t);
    const mins = (s === 1 || s === 2) && t.delaySeconds != null ? min(t.delaySeconds) : 0;
    features.push({ type: 'Feature', id, geometry: { type: 'Point', coordinates: position(a, now) }, properties: { id, line: t.line, corridor: t.corridor ?? '', color: colorOf(t), sev: String(s), mins } });
  }
  map.getSource('trenes')?.setData({ type: 'FeatureCollection', features });
  if (moving) requestAnimationFrame(frame);
}

// ── Textos de un tren (compartidos por la lista desplegada y el popup) ───────
// Destino como en un panel de salidas: bloque negro «TO» + estación
const TO = '<span class="to">TO</span>';
// En la lista, «TO + destino» va siempre junto en su propia línea; inline = una sola línea (ficha, etiqueta).
function trainTitle(t, inline = false) {
  const dest = (name) => `<span class="dest">${TO} ${esc(name)}</span>`;
  if (t.operator === 'ld') return inline ? `${esc(t.origin)} ${TO} ${esc(t.destination)}` : `${esc(t.origin)}${dest(t.destination)}`;
  if (t.destination) return inline ? `${TO} ${esc(t.destination)}` : dest(t.destination);
  return `Tren ${esc(t.label ?? '')}`;
}
function trainWhere(t) {
  if (t.operator === 'fgc') return t.parkedAt ? `Parado en ${t.parkedAt}` : t.nextStops?.length ? `Próxima: ${t.nextStops[0]}` : '';
  if (!t.stopName) return '';
  return `${t.status === 'STOPPED_AT' ? 'En' : 'Hacia'} ${t.stopName}${t.platform ? ` · vía ${t.platform}` : ''}`;
}
// Ocupación en una barra de 5 tramos (20 % cada uno). Naranja a partir de 4 tramos: tren lleno.
const PERSON = '<svg class="occ-ico" viewBox="0 0 10 12" aria-hidden="true"><circle cx="5" cy="2.6" r="2.3"/><path d="M0.6 12c0-3.1 2-5.2 4.4-5.2S9.4 8.9 9.4 12z"/></svg>';
function occBar(p) {
  if (p == null) return '';
  const n = Math.min(5, Math.ceil(p / 20));
  const segs = Array.from({ length: 5 }, (_, i) => `<i${i < n ? ' class="on"' : ''}></i>`).join('');
  return `<span class="occ${n >= 4 ? ' is-high' : ''}" role="img" aria-label="Ocupación ${p} %" title="Ocupación ${p} %">${PERSON}${segs}</span>`;
}

// Único indicador de estado del tren, al estilo de los paneles de aeropuerto.
function boardText(t) {
  if (t.operator === 'fgc' && t.delaySeconds == null) return t.onTime ? 'ON TIME' : 'DELAYED';
  if (t.delaySeconds == null) return 'NO DATA';
  if (t.delaySeconds <= ON_TIME[t.operator]) return 'ON TIME';
  return `DELAYED ${min(t.delaySeconds)} MIN`;
}
const board = (t) => `<span class="board s${sev(t)}">${boardText(t)}</span>`;

function popupTrain(id, lngLat) {
  const t = S.anim.get(id)?.train;
  if (!t) return;
  const head = t.operator === 'ld' ? badge(t.productName, colorOf(t)) : badge(t.line, colorOf(t));
  const where = trainWhere(t);
  S.popup?.remove();
  S.popup = new maplibregl.Popup({ offset: 10, maxWidth: '290px' }).setLngLat(lngLat)
    .setHTML(`<div class="pop"><h4>${head}<span>${trainTitle(t)}</span></h4><p>${board(t)}</p>${where ? `<p>${esc(where)}</p>` : ''}${t.occupancyPct != null ? `<p class="pop-occ">Ocupación ${occBar(t.occupancyPct)}<span>${t.occupancyPct} %</span></p>` : ''}</div>`)
    .addTo(map);
}
// Etiqueta de carretera con el código de color de la señalización española (hito kilométrico).
// El SCT no indica el tipo de vía: se deduce del código. Las autovías catalanas son una lista fija (aproximada).
const AUTOVIAS_CAT = new Set(['C-16', 'C-17', 'C-25', 'C-31', 'C-32', 'C-33', 'C-58', 'C-60', 'B-10', 'B-20', 'B-23', 'B-30', 'B-40', 'T-11']);
const ROAD_KIND = { auto: 'Autopista o autovía', n: 'Red del Estado', r1: 'Red autonómica básica (1.er orden)', r2: 'Red autonómica comarcal y local (2.º orden)', r3: 'Red de las diputaciones (3.er orden)', eu: 'Itinerario europeo', otra: 'Otra vía' };
function roadKind(code) {
  const c = String(code ?? '').trim().toUpperCase();
  if (/^E-\d/.test(c)) return 'eu';
  if (/^AP?-\d/.test(c) || AUTOVIAS_CAT.has(c)) return 'auto';
  if (/^N-/.test(c)) return 'n';
  if (/^C-\d{1,2}[A-Z]?$/.test(c)) return 'r1';
  if (/^C-\d{3,}/.test(c) || /^(B|GI|T|L)-\d{1,3}[A-Z]?$/.test(c)) return 'r2';
  if (/^(BV|BP|GIV|GIP|TV|TP|LV|LP)-\d/.test(c)) return 'r3';
  return 'otra';
}
function roadBadge(code) {
  const k = roadKind(code);
  return `<span class="road ${k}" title="${esc(ROAD_KIND[k])}">${esc(code)}</span>`;
}

function popupRoad(f, lngLat) {
  const r = S.roads.find((x) => x.id === f.properties.id);
  if (!r) return;
  S.popup?.remove();
  S.popup = new maplibregl.Popup({ offset: 8, maxWidth: '280px' }).setLngLat(lngLat).setHTML(`<div class="pop"><h4>${roadBadge(r.road)}<span class="lvl-${r.level}">${esc(r.description)}</span></h4><p>km ${r.pkFrom}–${r.pkTo} · ${esc(r.direction)}${r.towards ? ` · hacia ${esc(r.towards)}` : ''}</p><p>${esc(r.cause)}${r.at ? ` · ${hhmm(r.at)}` : ''}</p></div>`).addTo(map);
}

// ── Tarjetas de compañía (las pestañas) ──────────────────────────────────────
function setCard(key, big, sub, status) {
  $(`[data-big="${key}"]`).textContent = big;
  $(`[data-sub="${key}"]`).innerHTML = sub;
  $(`[data-sdot="${key}"]`).dataset.status = status;
}
const warn = (txt) => `<em>${esc(txt)}</em>`;

function renderCards(live) {
  const by = (op) => live.trains.filter((t) => t.operator === op);
  const issues = (svc) => Object.values(svc).filter((v) => v.status === 'grave' || v.status === 'retrasos').length;

  const ren = by('renfe');
  const rd = ren.filter((t) => t.delaySeconds != null);
  const ri = issues(live.railService.renfe);
  setCard('rodalies', pct(rd.filter((t) => t.delaySeconds <= ON_TIME.renfe).length, rd.length),
    `${plural(ren.length, 'tren', 'trenes')}${ri ? warn(`${plural(ri, 'línea', 'líneas')} con retrasos`) : ''}`, worstStatus(live.railService.renfe));

  const fgc = by('fgc');
  const fl = fgc.filter((t) => sev(t) === 1 || sev(t) === 2).length;
  setCard('fgc', pct(fgc.length - fl, fgc.length),
    `${plural(fgc.length, 'tren', 'trenes')}${fl ? warn(`${fl} con retraso`) : ''}`, worstStatus(live.railService.fgc));

  const tram = by('tram');
  const tl = tram.filter((t) => sev(t) === 1 || sev(t) === 2).length;
  setCard('tram', pct(tram.length - tl, tram.length),
    `${plural(tram.length, 'tranvía', 'tranvías')}${tl ? warn(`${tl} con retraso`) : ''}`, worstStatus(live.railService.tram));

  const ld = by('ld');
  const lw = ld.filter((t) => t.delaySeconds != null);
  const canc = live.sources.ld?.cancelled ?? 0;
  setCard('ave', pct(lw.filter((t) => t.delaySeconds <= ON_TIME.ld).length, lw.length),
    `${plural(ld.length, 'tren', 'trenes')}${canc ? warn(`${plural(canc, 'cancelado', 'cancelados')}`) : ''}`, worstStatus(live.railService.ld));
}

function renderRoadCard() {
  const rel = S.roads.filter((r) => r.type === 'Retención' || /cortada/i.test(r.description));
  const ret = rel.filter((r) => r.type === 'Retención').length;
  setCard('carreteras', String(rel.length), `${plural(ret, 'retención', 'retenciones')} · ${plural(rel.length - ret, 'corte', 'cortes')}`, ret >= 10 ? 'grave' : ret ? 'retrasos' : 'normal');
}

// ── Pastillas de línea / corredor, desplegables con sus trenes ───────────────
function dots(trains) {
  const shown = trains.slice(0, MAX_DOTS).map((t) => `<i class="d s${sev(t)}"></i>`).join('');
  return `<span class="dots">${shown}${trains.length > MAX_DOTS ? `<span class="more">+${trains.length - MAX_DOTS}</span>` : ''}</span>`;
}

// Una frase que resume la línea: lo primero que hay que saber.
function fact(op, trains, v) {
  const n = op === 'tram' ? plural(trains.length, 'tranvía', 'tranvías') : plural(trains.length, 'tren', 'trenes');
  const late = trains.filter((t) => sev(t) === 1 || sev(t) === 2);
  const mins = late.map((t) => t.delaySeconds).filter((d) => d != null);
  if (trains.every((t) => sev(t) === 'u')) return `${n} · sin datos de retraso`;
  if (v.medianDelaySeconds > ON_TIME[op]) return `${n} · retraso habitual ${min(v.medianDelaySeconds)} min`;
  if (late.length) return `${n} · ${late.length} con retraso${mins.length ? `, máx. ${min(Math.max(...mins))} min` : ''}`;
  return `${n} · ${op === 'ld' ? 'todos puntuales' : 'todos en hora'}`;
}

function trainRow(t) {
  const lead = t.operator === 'ld' ? badge(t.productName, colorOf(t)) : '';
  return `<li><button class="tr${S.focus?.trainId === t.id ? ' is-sel' : ''}" data-train="${esc(t.id)}">
    <span class="tr-main"><span class="tr-title">${lead}${trainTitle(t)}</span><span class="tr-sub"><span class="tr-where">${esc(trainWhere(t))}</span>${t.occupancyPct != null ? occBar(t.occupancyPct) : ''}</span></span>
    ${board(t)}
  </button></li>`;
}

function group({ key, op, lead, title, status, trains, v, details, extra }) {
  const open = S.open.has(key);
  const focused = S.focus && `${S.focus.op}:${S.focus.id}` === key;
  const sorted = [...trains].sort(byWorst);
  return `<div class="grp${open ? ' is-open' : ''}${focused ? ' is-focus' : ''}">
    <button class="grp-head${lead ? '' : ' no-lead'}" data-toggle="${esc(key)}" aria-expanded="${open}">
      ${lead ?? ''}
      <span class="grp-main">
        ${title ? `<span class="grp-title">${esc(title)}</span>` : ''}
        ${dots(sorted)}
        <span class="grp-fact">${esc(fact(op, trains, v))}${extra ?? ''}</span>
      </span>
      <span class="st ${status}">${STATUS[status]}</span>
      <span class="chev" aria-hidden="true"></span>
    </button>
    ${open ? `<div class="grp-body">${details ? `<p class="grp-details">${esc(details)}</p>` : ''}<ul class="trains">${sorted.map(trainRow).join('')}</ul></div>` : ''}
  </div>`;
}

const todayText = (v, word) => (v.today ? `Hoy: ${v.today.onTimePct}% ${word} (${plural(v.today.trips, 'tren', 'trenes')})` : '');

function renderGroups(live) {
  for (const op of ['renfe', 'fgc', 'tram']) {
    const svc = live.railService[op];
    const trainsBy = (line) => live.trains.filter((t) => t.operator === op && t.line === line);
    const keys = Object.keys(svc).sort((a, b) => RANK[svc[b].status] - RANK[svc[a].status] || lineOrder(a, b));
    const active = keys.filter((k) => svc[k].trains);
    const idle = keys.filter((k) => !svc[k].trains).sort(lineOrder);
    let html = active.map((line) => {
      const v = svc[line];
      return group({ key: `${op}:${line}`, op, lead: badge(line, v.color), status: v.status, trains: trainsBy(line), v, details: [v.name, todayText(v, 'en hora')].filter(Boolean).join(' · ') });
    }).join('');
    // Las líneas sin trenes se agrupan en una sola fila (FGC tiene muchas turísticas o sin servicio diario)
    if (idle.length && op !== 'fgc') html += `<div class="idle"><span>Sin trenes ahora</span>${idle.map((l) => badge(l, svc[l].color)).join('')}</div>`;
    $(`#groups-${op}`).innerHTML = html || '<p class="empty">Sin datos.</p>';
  }

  const svc = live.railService.ld;
  const keys = Object.keys(svc).sort((a, b) => RANK[svc[b].status] - RANK[svc[a].status] || svc[b].trains - svc[a].trains);
  const active = keys.filter((k) => svc[k].trains);
  const idle = keys.filter((k) => !svc[k].trains);
  let html = active.map((id) => {
    const v = svc[id];
    const extra = v.cancelled ? ` · ${warn(`${plural(v.cancelled, 'cancelado', 'cancelados')}`)}` : '';
    return group({ key: `ld:${id}`, op: 'ld', title: v.name, status: v.status, trains: live.trains.filter((t) => t.operator === 'ld' && t.corridor === id), v, details: todayText(v, 'puntuales'), extra });
  }).join('');
  if (idle.length) {
    html += `<div class="idle idle-list"><span>Sin trenes ahora</span>${idle.map((id) => `<span class="idle-item">${esc(svc[id].name)}${svc[id].cancelled ? ` ${warn(`· ${svc[id].cancelled} cancelados`)}` : ''}</span>`).join('')}</div>`;
  }
  $('#groups-ld').innerHTML = html || '<p class="empty">Sin datos.</p>';
}

function renderEvents(live) {
  const lists = { renfe: '#events-rodalies', ld: '#events-ave' };
  for (const [op, sel] of Object.entries(lists)) {
    const color = (e) => (op === 'ld' ? live.ldProducts[e.line]?.color : live.railService.renfe[e.line]?.color) ?? '#777';
    const label = (e) => (op === 'ld' ? live.ldProducts[e.line]?.name ?? e.line : e.line);
    const items = live.events.filter((e) => e.op === op).slice(0, 8).map((e) => `<li><time>${hhmm(e.at)}</time>${badge(label(e), color(e))}<span>${esc(e.text)}</span></li>`);
    $(sel).innerHTML = items.join('') || '<li class="empty">Sin trenes con retrasos de 15 min o más desde que arrancó el servidor.</li>';
  }
}

function renderAlerts(live) {
  const colors = live.railService.renfe;
  const li = (a) => {
    const lines = a.lines.length > 8 ? `<span class="badge" style="background:#555">${a.lines.length} líneas</span>` : [...a.lines].sort(lineOrder).map((l) => badge(l, colors[l]?.color ?? '#777')).join('');
    const when = a.from ? `<time>${a.upcoming ? 'Desde ' : ''}${new Date(a.from).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' })}</time>` : '';
    return `<li><div class="badges">${lines}${when}</div>${esc(a.description)}</li>`;
  };
  $('#alerts-active').innerHTML = live.alerts.filter((a) => a.active).map(li).join('') || '<li class="empty">Sin avisos activos.</li>';
  $('#alerts-upcoming').innerHTML = live.alerts.filter((a) => a.upcoming).map(li).join('') || '<li class="empty">No hay obras ni cortes anunciados.</li>';
}

function renderRoads() {
  const relevant = S.roads.filter((r) => r.type === 'Retención' || /cortada/i.test(r.description));
  const rest = S.roads.length - relevant.length;
  $('#roads').innerHTML = relevant.map((r) => `<li>${roadBadge(r.road)}<div><span class="lvl-${r.level}">${esc(r.description)}</span><div class="meta">km ${r.pkFrom}–${r.pkTo} · ${esc(r.direction)}${r.towards ? ` · hacia ${esc(r.towards)}` : ''} · ${esc(r.cause)}${r.at ? ` · ${hhmm(r.at)}` : ''}</div></div></li>`).join('')
    + `<li class="empty" style="display:block;border:0">Además hay ${rest} incidencias por obras con calzada restringida (puntos grises en el mapa).</li>`;
  renderRoadCard();
}

function drawRoads() {
  if (!S.mapReady) return;
  const features = S.roads.filter((r) => r.lat != null).map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { id: r.id, type: r.type, level: r.level } }));
  map.getSource('carreteras')?.setData({ type: 'FeatureCollection', features });
}

function renderStatus(error) {
  const el = $('#upd');
  const src = S.live?.sources ?? {};
  const names = { renfe: 'Rodalies', fgc: 'FGC', tram: 'TRAM', ld: 'AVE' };
  const down = Object.keys(names).filter((k) => src[k] && !src[k].ok).map((k) => names[k]);
  const age = S.live ? Date.now() - S.live.queriedAt : Infinity;
  el.classList.toggle('is-error', !!error);
  el.classList.toggle('is-stale', !error && (down.length > 0 || age > STALE_MS));
  el.textContent = error ? 'sin conexión' : down.length ? `${down.join(', ')} sin actualizar` : S.live ? `actualizado ${hhmm(S.live.queriedAt)}` : 'cargando…';
}

function renderAll() {
  const live = S.live;
  if (!live) return;
  renderCards(live);
  renderGroups(live);
  renderEvents(live);
  renderAlerts(live);
  renderStatus(null);
  renderFocusChip();
}

// ── Sondeo ───────────────────────────────────────────────────────────────────
function schedule(ms) {
  clearTimeout(S.timer);
  S.timer = setTimeout(refresh, ms);
}

async function refresh() {
  if (document.hidden) return; // se reanuda al volver a la pestaña
  let next = POLL_MS;
  try {
    const res = await fetch('api/live', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    S.live = await res.json();
    const hint = parseFloat(res.headers.get('x-data-next'));
    if (Number.isFinite(hint)) next = Math.min(MAX_MS, Math.max(MIN_MS, hint * 1000 + LAG_MS));
    if (S.mapReady) setTrains(S.live.trains);
    renderAll();
  } catch (err) {
    renderStatus(err);
  }
  schedule(next);
}

async function refreshRoads() {
  try {
    const res = await fetch('api/carreteras', { cache: 'no-store' });
    if (res.ok) {
      S.roads = (await res.json()).incidents;
      renderRoads();
      drawRoads();
    }
  } catch { /* se reintenta en la siguiente vuelta */ }
  setTimeout(refreshRoads, 60_000);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// ── Pestañas e interacción ───────────────────────────────────────────────────
function setTab(tab, animate = true) {
  if (!TABS[tab]) tab = 'rodalies';
  if (tab !== S.tab) { S.focus = null; S.popup?.remove(); $('#panel-body').scrollTop = 0; }
  S.tab = tab;
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
  applyMapTab(animate);
  if (tab === 'bus') { loadBusLines(); drawBus(true); }
}

window.addEventListener('hashchange', () => setTab(location.hash.slice(1)));

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) return setTab(tab.dataset.tab);
  const tr = e.target.closest('[data-train]');
  if (tr) return focusTrain(tr.dataset.train);
  const bl = e.target.closest('[data-bus-line]');
  if (bl) return openBusLine(Number(bl.dataset.busLine));
  const br = e.target.closest('[data-bus-route]');
  if (br) { BUS.route[BUS.open] = Number(br.dataset.busRoute); BUS.stop = null; renderBus(); drawBus(true); return; }
  const bs = e.target.closest('[data-bus-stop]');
  if (bs) return openBusStop(Number(bs.dataset.busStop));
  const tg = e.target.closest('[data-toggle]');
  if (tg) return toggleGroup(tg.dataset.toggle);
  if (e.target.closest('#focus-x')) return clearFocus();
  if (e.target.closest('#open-how')) $('#how').showModal();
});

function fitTo(points) {
  if (!points.length || !S.mapReady) return;
  const b = points.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(points[0], points[0]));
  map.fitBounds(b, { padding: 60, maxZoom: 12, duration: 900 });
}

// Desplegar una línea la selecciona: sus trenes en la lista, su trazado resaltado en el mapa.
function toggleGroup(key) {
  const opening = !S.open.has(key);
  if (opening) S.open.add(key); else S.open.delete(key);
  const [op, id] = key.split(':');
  if (opening) {
    S.focus = { op, kind: op === 'ld' ? 'corridor' : 'line', id };
    const pred = op === 'ld' ? (t) => t.operator === 'ld' && t.corridor === id : (t) => t.operator === op && t.line === id;
    const trains = [...S.anim.values()].filter((a) => pred(a.train));
    fitTo(op === 'ld' ? trains.flatMap((a) => a.train.route ?? [a.to]) : trains.map((a) => a.to));
  } else if (S.focus?.op === op && S.focus.id === id) {
    S.focus = null;
    S.popup?.remove();
  }
  applyFocus();
  renderGroups(S.live);
}

// Seleccionar un tren (en la lista o en el mapa) resalta la línea por la que circula.
function selectTrain(id, { fly = true, lngLat } = {}) {
  const a = S.anim.get(id);
  if (!a || !S.mapReady) return;
  const t = a.train;
  setFocus({ op: t.operator, kind: t.operator === 'ld' ? 'corridor' : 'line', id: t.operator === 'ld' ? t.corridor : t.line, trainId: id });
  if (fly) {
    if (t.operator === 'ld' && t.route?.length > 1) fitTo(t.route);
    else map.flyTo({ center: a.to, zoom: Math.max(map.getZoom(), 11), duration: 800 });
  }
  popupTrain(id, lngLat ?? a.to);
}
const focusTrain = (id) => selectTrain(id);

// ── Bus Moventis (bajo demanda: líneas → paradas → próximos buses) ───────────
const BUS = { lines: null, error: false, loading: false, open: null, route: {}, stops: new Map(), times: new Map(), stop: null, q: '' };

async function getJsonOrThrow(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function loadBusLines() {
  if (BUS.lines || BUS.loading) return;
  BUS.loading = true;
  try { BUS.lines = (await getJsonOrThrow('api/bus-lineas')).lines; BUS.error = false; } catch {
    BUS.error = true;
    setTimeout(loadBusLines, 15_000); // p. ej. la función de Vercel en frío: se reintenta
  }
  BUS.loading = false;
  renderBus();
  renderBusCard();
}

function renderBusCard() {
  if (!BUS.lines) { setCard('bus', '–', BUS.error ? 'sin conexión con Moventis' : 'cargando…', 'sin-trenes'); return; }
  const brands = new Set(BUS.lines.map((l) => l.brand)).size;
  setCard('bus', String(BUS.lines.length), `${plural(brands, 'marca', 'marcas')} · tiempo real por parada`, 'normal');
}

const busLine = (id) => BUS.lines?.find((l) => l.id === id);
const busBadge = (l) => `<span class="badge" style="background:${esc(l.color)};color:${esc(l.textColor)}">${esc(l.code)}</span>`;
const busRoute = () => BUS.stops.get(BUS.open)?.routes?.[BUS.route[BUS.open] ?? 0];

function depBoard(d) {
  if (d.realtime) return `<span class="board s0" title="Tiempo real">${d.minutes < 1 ? 'NOW' : `${Math.round(d.minutes)} MIN`}</span>`;
  return `<span class="board su" title="Horario">${esc(d.time ?? `${Math.round(d.minutes)} MIN`)}</span>`;
}
function depList(list) {
  if (!list?.length) return '<p class="empty">Sin salidas próximas.</p>';
  return `<ul class="deps-list">${list.slice(0, 5).map((d) => `<li><span class="tr-title"><span class="dest">${TO} ${esc(d.destination)}</span></span>${depBoard(d)}</li>`).join('')}</ul>`;
}
function stopDepartures(stopId) {
  const t = BUS.times.get(`${stopId}:${BUS.open}`);
  if (!t) return '<p class="empty">Consultando…</p>';
  if (t.error) return '<p class="empty">No se pudo consultar Moventis.</p>';
  const mine = t.data.lines.find((x) => x.selected) ?? t.data.lines[0];
  let html = depList(mine?.departures);
  const others = t.data.lines.filter((x) => x !== mine && x.departures.length);
  if (others.length) html += `<p class="grp-details">También paran: ${others.map((o) => esc(o.name.split(' - ')[0])).join(' · ')}</p>`;
  return html;
}

function renderBus() {
  const el = $('#groups-bus');
  if (!el) return;
  if (!BUS.lines) { el.innerHTML = `<p class="empty">${BUS.error ? 'No se pudieron cargar las líneas de Moventis.' : 'Cargando líneas…'}</p>`; return; }
  const q = BUS.q.trim().toLowerCase();
  const lines = BUS.lines.filter((l) => !q || l.code.toLowerCase().includes(q) || l.name.toLowerCase().includes(q) || l.brand.toLowerCase().includes(q));
  const brands = [...new Set(lines.map((l) => l.brand))];
  el.innerHTML = brands.map((b) => `<h3 class="brand-h">${esc(b)}</h3>${lines.filter((l) => l.brand === b).map(busLineRow).join('')}`).join('') || '<p class="empty">Ninguna línea coincide.</p>';
}

function busLineRow(l) {
  const open = BUS.open === l.id;
  let body = '';
  if (open) {
    const d = BUS.stops.get(l.id);
    if (!d) body = '<p class="empty">Cargando paradas…</p>';
    else if (d.error || !d.routes?.length) body = '<p class="empty">No hay recorridos para hoy.</p>';
    else {
      const ri = BUS.route[l.id] ?? 0;
      body = `<div class="routes">${d.routes.map((r, i) => `<button class="route${i === ri ? ' is-on' : ''}" data-bus-route="${i}">${esc(r.name)}</button>`).join('')}</div>`
        + `<ul class="trains">${d.routes[ri].stops.map((st) => `<li><button class="tr${BUS.stop === st.id ? ' is-sel' : ''}" data-bus-stop="${st.id}"><span class="tr-main"><span class="tr-title">${esc(st.name)}</span><span class="tr-sub"><span class="tr-where">${esc(st.town)}</span></span></span><span class="chev" aria-hidden="true"></span></button>${BUS.stop === st.id ? `<div class="deps">${stopDepartures(st.id)}</div>` : ''}</li>`).join('')}</ul>`;
    }
  }
  return `<div class="grp${open ? ' is-open is-focus' : ''}"><button class="grp-head" data-bus-line="${l.id}" aria-expanded="${open}">${busBadge(l)}<span class="grp-main"><span class="grp-title">${esc(l.name)}</span></span><span></span><span class="chev" aria-hidden="true"></span></button>${open ? `<div class="grp-body">${body}</div>` : ''}</div>`;
}

async function openBusLine(id) {
  if (BUS.open === id) { BUS.open = null; BUS.stop = null; S.popup?.remove(); renderBus(); drawBus(); return; }
  BUS.open = id;
  BUS.stop = null;
  S.popup?.remove();
  renderBus();
  if (!BUS.stops.has(id)) {
    try { BUS.stops.set(id, await getJsonOrThrow(`api/bus-paradas?linea=${id}`)); } catch { BUS.stops.set(id, { error: true }); }
  }
  // Por defecto, el recorrido principal con más paradas
  const routes = BUS.stops.get(id).routes ?? [];
  if (BUS.route[id] == null && routes.length) BUS.route[id] = routes.reduce((best, r, i) => (r.stops.length > routes[best].stops.length ? i : best), 0);
  if (BUS.open === id) { renderBus(); drawBus(true); }
}

async function openBusStop(stopId, quiet = false) {
  if (!BUS.open) return;
  BUS.stop = stopId;
  if (!quiet) { renderBus(); drawBus(); }
  const key = `${stopId}:${BUS.open}`;
  try { BUS.times.set(key, { at: Date.now(), data: await getJsonOrThrow(`api/bus-tiempos?parada=${stopId}&linea=${BUS.open}`) }); } catch { BUS.times.set(key, { at: Date.now(), error: true }); }
  if (BUS.stop !== stopId) return;
  renderBus();
  const st = busRoute()?.stops.find((x) => x.id === stopId);
  if (st && S.mapReady && S.tab === 'bus') {
    S.popup?.remove();
    S.popup = new maplibregl.Popup({ offset: 10, maxWidth: '300px' }).setLngLat([st.lon, st.lat])
      .setHTML(`<div class="pop"><h4>${busBadge(busLine(BUS.open))}<span>${esc(st.name)}</span></h4>${stopDepartures(stopId)}</div>`).addTo(map);
  }
}

function drawBus(fit = false) {
  if (!S.mapReady) return;
  const l = busLine(BUS.open);
  const r = l && busRoute();
  const coords = r ? r.stops.map((st) => [st.lon, st.lat]) : [];
  map.getSource('bus-ruta')?.setData(r ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { color: l.color } }] } : empty);
  map.getSource('bus-paradas')?.setData(r ? { type: 'FeatureCollection', features: r.stops.map((st) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [st.lon, st.lat] }, properties: { id: st.id, name: st.name, color: l.color, sel: BUS.stop === st.id } })) } : empty);
  if (fit && coords.length > 1 && S.tab === 'bus') fitTo(coords);
}

$('#bus-search')?.addEventListener('input', (e) => { BUS.q = e.target.value; renderBus(); });
// Los próximos buses de la parada abierta se renuevan cada 30 s
setInterval(() => { if (S.tab === 'bus' && BUS.stop && !document.hidden) openBusStop(BUS.stop, true); }, 30_000);

setTab(location.hash.slice(1) || 'rodalies', false);
refresh();
refreshRoads();
loadBusLines();
