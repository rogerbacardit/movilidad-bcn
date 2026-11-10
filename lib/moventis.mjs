// Autobuses de Moventis (Sagalés, Casas, Sarbus…): líneas, paradas y próximos buses por parada.
// Moventis no publica datos abiertos: se usan los mismos JSON públicos que su página «Tiempo real»
// (www.moventis.es/es/tiempo-real), sin claves. Solo se piden bajo demanda y con caché:
// líneas y paradas 12 h, tiempos de una parada 30 s. Moventis no publica la posición de los buses.
const BASE = 'https://www.moventis.es';
const UA = { 'user-agent': 'movilidad-bcn/0.1 (datos de tiempo real)', 'x-requested-with': 'XMLHttpRequest' };
const H12 = 12 * 3600_000;
const cache = new Map(); // clave → { at, ttl, value | promise }

async function cached(key, ttl, load) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttl) return c.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  try {
    return await value;
  } catch (err) {
    cache.delete(key); // no se guardan los errores
    throw err;
  }
}

async function getJson(path) {
  const res = await fetch(BASE + path, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Moventis ${path} → HTTP ${res.status}`);
  return res.json();
}

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(Date.now()).replaceAll('-', '');
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Líneas con tiempo real, agrupadas por marca (la API devuelve una fila por línea y día de servicio).
export function busLines() {
  return cached('lines', H12, async () => {
    const [rows, brands] = await Promise.all([getJson('/moventis/es/lines'), getJson('/moventis/es/brands')]);
    const brandName = new Map(brands.map((b) => [String(b.nid), clean(b.TITLE)]));
    const byId = new Map();
    for (const r of rows) {
      if (byId.has(r.ID_LINEA)) continue;
      byId.set(r.ID_LINEA, {
        id: Number(r.ID_LINEA),
        code: clean(r.COD_LINEA),
        name: clean(r.DESC_LINEA).replace(new RegExp(`^${clean(r.COD_LINEA)}\\s*-\\s*`), ''),
        color: /^#[0-9a-f]{6}$/i.test(r.COLOR ?? '') ? r.COLOR : '#3a5a8c',
        textColor: /^#[0-9a-f]{6}$/i.test(r.TEXT_COLOR ?? '') ? r.TEXT_COLOR : '#ffffff',
        brand: brandName.get(String(r.MARCA)) ?? 'Moventis',
        realtime: r.TREAL === 'S',
      });
    }
    const lines = [...byId.values()].sort((a, b) => a.brand.localeCompare(b.brand) || a.code.localeCompare(b.code, 'es', { numeric: true }));
    return { queriedAt: Date.now(), lines };
  });
}

// Recorridos de una línea (uno por sentido) con sus paradas en orden.
export function busStops(lineId) {
  const id = Number(lineId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('línea no válida');
  return cached(`stops:${id}:${today()}`, H12, async () => {
    const trips = await getJson(`/api/json/GetTrayectos/${id}/${today()}`);
    const routes = (Array.isArray(trips) ? trips : []).map((t) => ({
      id: t.ID_TRAYECTO,
      name: clean(t.DESC_TRAYECTO),
      direction: t.SENTIDO ?? null,
      main: t.PRINCIPAL === 'S' || t.PRINCIPAL === 1 || t.PRINCIPAL === true,
      stops: (t.TrayectosDet ?? [])
        .slice().sort((a, b) => (a.SECUENCIA ?? 0) - (b.SECUENCIA ?? 0))
        .map((d) => d.Parada)
        .filter((p) => p && Number.isFinite(p.LATITUD) && Number.isFinite(p.LONGITUD))
        .map((p) => ({ id: p.ID_PARADA, name: clean(p.DESC_PARADA), town: clean(p.MUNICIPIO), lat: p.LATITUD, lon: p.LONGITUD })),
    })).filter((r) => r.stops.length > 1);
    return { line: id, routes };
  });
}

// «16 min 51.73 s» (tiempo real) o «tiempo: 00 h 57 min» (horario) → minutos
function minutesOf(e) {
  const rt = /(\d+)\s*min\s*([\d.]+)?\s*s?/.exec(e.minutos ?? '');
  if (e.real === 'S' && rt) return Number(rt[1]) + Number(rt[2] ?? 0) / 60;
  const sch = /(\d+)\s*h\s*(\d+)\s*min/.exec(e.tiempo ?? '');
  if (sch) return Number(sch[1]) * 60 + Number(sch[2]);
  return rt ? Number(rt[1]) : null;
}

// Próximos buses en una parada: los de la línea pedida y, aparte, las demás líneas que paran allí.
export function busTimes(stopId, lineId) {
  const stop = Number(stopId);
  const line = Number(lineId) || 0;
  if (!Number.isInteger(stop) || stop <= 0) throw new Error('parada no válida');
  return cached(`times:${stop}:${line}`, 30_000, async () => {
    const rows = await getJson(`/api/json/GetTiemposParada/es/${stop}/${line}/0`);
    const lines = (Array.isArray(rows) ? rows : []).map((r) => {
      const departures = [];
      for (const [destination, v] of Object.entries(r.trayectos ?? {})) {
        for (const e of Array.isArray(v) ? v : Object.values(v ?? {})) {
          const minutes = minutesOf(e);
          if (minutes == null) continue;
          departures.push({ destination: clean(destination), minutes: Math.round(minutes * 10) / 10, realtime: e.real === 'S', time: e.hora ?? null });
        }
      }
      departures.sort((a, b) => a.minutes - b.minutes);
      return { line: r.idLinea, name: clean(r.desc_linea), selected: r.selected === 1, departures: departures.slice(0, 6), incidents: r.incidencias ?? null };
    });
    return { queriedAt: Date.now(), stop, lines };
  });
}
