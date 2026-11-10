// Función de Vercel: recorridos y paradas de una línea de Moventis (?linea=ID).
import { busStops } from '../lib/moventis.mjs';
import { sendBus } from './_bus.mjs';

export default (req, res) => sendBus(res, () => busStops(new URL(req.url, 'http://x').searchParams.get('linea')), 3600);
