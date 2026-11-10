// Decodificador mínimo de GTFS Realtime (protobuf) sin dependencias.
// Solo los campos que usa el servidor: cabecera, trip_update y vehicle.
// Devuelve la misma forma que los JSON de Renfe (camelCase), para tratar igual ambos feeds.
// Referencia de campos: https://gtfs.org/realtime/reference/

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('protobuf truncado');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
}

// Recorre los campos de un mensaje: [número, tipo, valor]. Los mensajes anidados se devuelven como subarray.
function* fields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    const [key, p] = readVarint(buf, pos);
    pos = p;
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) { const [v, q] = readVarint(buf, pos); pos = q; yield [no, wire, v]; }
    else if (wire === 1) { yield [no, wire, buf.subarray(pos, pos + 8)]; pos += 8; }
    else if (wire === 2) { const [len, q] = readVarint(buf, pos); const end = q + Number(len); yield [no, wire, buf.subarray(q, end)]; pos = end; }
    else if (wire === 5) { yield [no, wire, buf.subarray(pos, pos + 4)]; pos += 4; }
    else throw new Error(`tipo de campo protobuf no soportado: ${wire}`);
  }
}

const str = (b) => Buffer.from(b).toString('utf8');
const int32 = (v) => Number(BigInt.asIntN(32, v));
const int64 = (v) => Number(BigInt.asIntN(64, v));
const float = (b) => Buffer.from(b).readFloatLE(0);
const STATUS = ['INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO'];
const TRIP_REL = ['SCHEDULED', 'ADDED', 'UNSCHEDULED', 'CANCELED', 'REPLACEMENT', 'DUPLICATED', 'DELETED'];

function trip(buf) {
  const o = {};
  for (const [n, , v] of fields(buf)) {
    if (n === 1) o.tripId = str(v);
    else if (n === 2) o.startTime = str(v);
    else if (n === 3) o.startDate = str(v);
    else if (n === 4) o.scheduleRelationship = TRIP_REL[Number(v)] ?? String(v);
    else if (n === 5) o.routeId = str(v);
    else if (n === 6) o.directionId = Number(v);
  }
  return o;
}
function vehicleDescriptor(buf) {
  const o = {};
  for (const [n, , v] of fields(buf)) {
    if (n === 1) o.id = str(v);
    else if (n === 2) o.label = str(v);
  }
  return o;
}
function stopTimeEvent(buf) {
  const o = {};
  for (const [n, , v] of fields(buf)) {
    if (n === 1) o.delay = int32(v);
    else if (n === 2) o.time = int64(v);
  }
  return o;
}
function stopTimeUpdate(buf) {
  const o = {};
  for (const [n, , v] of fields(buf)) {
    if (n === 1) o.stopSequence = Number(v);
    else if (n === 2) o.arrival = stopTimeEvent(v);
    else if (n === 3) o.departure = stopTimeEvent(v);
    else if (n === 4) o.stopId = str(v);
  }
  return o;
}
function tripUpdate(buf) {
  const o = { stopTimeUpdate: [] };
  for (const [n, , v] of fields(buf)) {
    if (n === 1) o.trip = trip(v);
    else if (n === 2) o.stopTimeUpdate.push(stopTimeUpdate(v));
    else if (n === 3) o.vehicle = vehicleDescriptor(v);
    else if (n === 4) o.timestamp = int64(v);
    else if (n === 5) o.delay = int32(v);
  }
  return o;
}
function position(buf) {
  const o = {};
  for (const [n, w, v] of fields(buf)) {
    if (n === 1 && w === 5) o.latitude = float(v);
    else if (n === 2 && w === 5) o.longitude = float(v);
  }
  return o;
}
function vehiclePosition(buf) {
  const o = {};
  for (const [n, , v] of fields(buf)) {
    if (n === 1) o.trip = trip(v);
    else if (n === 2) o.position = position(v);
    else if (n === 4) o.currentStatus = STATUS[Number(v)] ?? String(v);
    else if (n === 5) o.timestamp = int64(v);
    else if (n === 7) o.stopId = str(v);
    else if (n === 8) o.vehicle = vehicleDescriptor(v);
  }
  return o;
}

export function decodeFeed(buffer) {
  const feed = { header: {}, entity: [] };
  for (const [n, , v] of fields(buffer)) {
    if (n === 1) {
      for (const [hn, , hv] of fields(v)) if (hn === 3) feed.header.timestamp = int64(hv);
    } else if (n === 2) {
      const e = {};
      for (const [en, , ev] of fields(v)) {
        if (en === 1) e.id = str(ev);
        else if (en === 3) e.tripUpdate = tripUpdate(ev);
        else if (en === 4) e.vehicle = vehiclePosition(ev);
      }
      feed.entity.push(e);
    }
  }
  return feed;
}
