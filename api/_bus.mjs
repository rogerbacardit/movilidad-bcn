// Respuesta común de las funciones de Moventis: JSON con caché en la CDN de Vercel (s-maxage).
// Los ficheros que empiezan por «_» no son rutas en Vercel.
export async function sendBus(res, load, seconds) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    const data = await load();
    res.setHeader('cache-control', `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds}`);
    res.end(JSON.stringify(data));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
  }
}
