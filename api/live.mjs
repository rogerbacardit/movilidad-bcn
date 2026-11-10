// Función de Vercel: trenes en directo (Rodalies, FGC, AVE y larga distancia) y avisos.
// Pide a las fuentes solo lo que haya caducado; la CDN de Vercel comparte la respuesta unos segundos.
import { ensureFresh, buildLive, nextHintSeconds } from '../lib/engine.mjs';

export default async function handler(req, res) {
  await ensureFresh(['renfe', 'fgcTu', 'fgc', 'ld', 'alerts']);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=0, s-maxage=10, stale-while-revalidate=20');
  res.setHeader('x-data-next', Math.max(5, nextHintSeconds()).toFixed(1));
  res.end(JSON.stringify(buildLive()));
}
