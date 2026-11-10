// Función de Vercel: próximos buses de Moventis en una parada (?parada=ID&linea=ID).
import { busTimes } from '../lib/moventis.mjs';
import { sendBus } from './_bus.mjs';

export default (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  return sendBus(res, () => busTimes(q.get('parada'), q.get('linea')), 30);
};
