// Función de Vercel: líneas de Moventis con tiempo real (se renuevan cada 12 h).
import { busLines } from '../lib/moventis.mjs';
import { sendBus } from './_bus.mjs';

export default (req, res) => sendBus(res, () => busLines(), 3600);
