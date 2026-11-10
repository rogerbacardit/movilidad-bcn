// Lector mínimo de ficheros .zip, sin dependencias ni el programa `unzip`
// (así la preparación de datos funciona igual en local y en el servidor de compilación de Vercel).
// Solo lo necesario para los GTFS: directorio central, entradas «stored» o «deflate», sin ZIP64.
import fs from 'node:fs';
import zlib from 'node:zlib';

export function openZip(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const tailLen = Math.min(size, 65_557); // registro final (22 B) + comentario máximo (64 KB)
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file}: no es un zip válido`);
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error(`${file}: ZIP64 no soportado`);

  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = new Map();
  for (let p = 0, n = 0; n < count; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: directorio central dañado`);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    entries.set(cd.toString('utf8', p + 46, p + 46 + nameLen), {
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      localHeader: cd.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  // Flujo con el contenido descomprimido de una entrada (para ficheros grandes, línea a línea).
  function stream(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`${file}: no contiene ${name}`);
    const lh = Buffer.alloc(30);
    fs.readSync(fd, lh, 0, 30, e.localHeader);
    const start = e.localHeader + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = fs.createReadStream(file, { start, end: start + e.compressedSize - 1 });
    if (e.method === 0) return raw;
    if (e.method === 8) return raw.pipe(zlib.createInflateRaw());
    throw new Error(`${file}: método de compresión ${e.method} no soportado`);
  }

  async function text(name) {
    const chunks = [];
    for await (const c of stream(name)) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }

  return { entries, stream, text, close: () => fs.closeSync(fd) };
}
