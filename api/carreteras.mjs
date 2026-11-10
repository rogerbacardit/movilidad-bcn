// Función de Vercel: incidencias del Servei Català de Trànsit (se renuevan cada 3 minutos).
import { ensureFresh, roadsPayload } from '../lib/engine.mjs';

export default async function handler(req, res) {
  await ensureFresh(['sct']);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=0, s-maxage=120, stale-while-revalidate=60');
  res.end(JSON.stringify(roadsPayload()));
}
