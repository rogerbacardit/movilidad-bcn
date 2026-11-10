// Servidor local: sondea las fuentes de forma continua y sirve la página y la API.
// La lógica de datos está en lib/engine.mjs (la misma que usan las funciones de Vercel en api/).
// Sin dependencias: solo Node >= 20.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

let engine;
try {
  engine = await import('./lib/engine.mjs');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const { ROOT, EVERY, ensureFresh, buildLive, nextHintSeconds, roadsPayload, historyRow, summary, loadStatic, staticGeneratedAt } = engine;
const { busLines, busStops, busTimes } = await import('./lib/moventis.mjs');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const HISTORY_FILE = path.join(ROOT, 'data', 'historial.jsonl');

// Los horarios de Renfe y FGC cambian a menudo: se regeneran los datos estáticos una vez al día.
function refreshStatic() {
  execFile(process.execPath, [path.join(ROOT, 'scripts', 'preparar-datos.mjs')], { timeout: 10 * 60_000 }, (err) => {
    if (err) return console.error('No se pudieron actualizar los datos estáticos:', err.message);
    loadStatic();
    console.log('Datos estáticos actualizados', staticGeneratedAt());
  });
}

// ── Historial: una muestra cada 5 minutos ────────────────────────────────────
function sampleHistory() {
  fs.appendFile(HISTORY_FILE, JSON.stringify(historyRow()) + '\n', () => {});
}
function readHistory(hours = 24) {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const since = Date.now() - hours * 3600_000;
  return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((r) => r && r.t >= since);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json', '.svg': 'image/svg+xml' };

function sendJson(res, data, extra = {}) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // La cabecera x-data-next le dice al navegador cuándo habrá datos nuevos.
  if (url.pathname === '/api/live') return sendJson(res, buildLive(), { 'x-data-next': nextHintSeconds().toFixed(1) });
  if (url.pathname === '/api/carreteras') return sendJson(res, roadsPayload());
  if (url.pathname === '/api/history') return sendJson(res, readHistory(Math.min(168, Number(url.searchParams.get('h')) || 24)));
  // Moventis: bajo demanda (con caché en lib/moventis.mjs)
  const bus = { '/api/bus-lineas': () => busLines(), '/api/bus-paradas': () => busStops(url.searchParams.get('linea')), '/api/bus-tiempos': () => busTimes(url.searchParams.get('parada'), url.searchParams.get('linea')) }[url.pathname];
  if (bus) {
    Promise.resolve().then(bus).then((data) => sendJson(res, data), (err) => {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(err.message ?? err) }));
    });
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, 'public', rel);
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

// Sondeo continuo: cada segundo se refresca lo que haya caducado (cada fuente con su cadencia).
await ensureFresh();
setInterval(() => ensureFresh().catch((err) => console.error(err)), 1_000);
if (Date.now() - Date.parse(staticGeneratedAt()) > 20 * 3600_000) refreshStatic();
setInterval(refreshStatic, EVERY.static);
setInterval(sampleHistory, EVERY.history);

server.listen(PORT, HOST, () => {
  console.log(`Movilidad en directo → http://${HOST}:${PORT}`);
  console.log(`  ${summary()}`);
});
