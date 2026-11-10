# movilidad-bcn

Réplica local del panel «¿Cómo van los trenes?» de La Vanguardia (lavanguardia.com/movilidad): Rodalies, FGC, TRAM, AVE y larga distancia, bus Moventis y carreteras de Catalunya en directo.

Hay una pestaña por compañía (Rodalies, FGC, AVE y larga distancia, Carreteras). Las tarjetas de arriba son a la vez el resumen y las pestañas. El mapa muestra solo la compañía elegida, y la pestaña queda en la URL: `#rodalies`, `#fgc`, `#ave` o `#carreteras`.

Cada línea (o corredor, en AVE) es una pastilla:

- un punto por tren, coloreado por su estado (verde en hora, naranja con retraso, rojo con 15 min o más, hueco sin dato);
- una frase que la resume, por ejemplo «9 trenes · retraso habitual 40 min».

Al pulsarla se despliegan sus trenes, del peor al mejor: destino, dónde está y cuántos minutos de retraso lleva. En el mapa, cada tren con retraso lleva al lado «+N min»: naranja, o rojo con 15 min o más. Si las etiquetas se solapan, se ven antes las de más retraso. En FGC también se muestra su ocupación, en una barra de 5 tramos de un 20 % cada uno. La barra se pone naranja a partir de 4 tramos. Es la media de los coches que publican dato (MI, RI, M1, M2), y muchos trenes no lo publican. Las líneas sin trenes se agrupan en una sola fila.

**Selección en el mapa.** Al desplegar una línea o pulsar un tren (en la lista o en el mapa), esa línea queda seleccionada:

- su vía sale en su color, más gruesa y por encima de las demás;
- el resto de vías y trenes pasan a gris;
- el tren elegido lleva un halo.

En AVE se dibuja el recorrido del tren (o de todo el corredor) en discontinua, uniendo sus estaciones, porque Renfe no publica el trazado. Arriba a la izquierda del mapa aparece la selección con una ✕ para quitarla. También se quita al pulsar el mapa fuera de un tren o al cambiar de pestaña.

No usa la API de La Vanguardia. Consulta directamente los mismos datos abiertos oficiales que ellos usan.

## Arrancar

Requiere Node 20 o superior. No tiene dependencias.

```bash
npm run preparar   # opcional: regenera los datos estáticos (el repositorio ya trae unos)
npm start          # http://127.0.0.1:8080
```

Para usar otro puerto: `PORT=3000 npm start`.

## Despliegue en Vercel

El repositorio está listo para Vercel ([vercel.json](vercel.json)): al importarlo en vercel.com/new no hay que configurar nada.

- **Página:** se sirve tal cual desde `public/`.
- **Datos estáticos:** se regeneran en cada despliegue (`scripts/preparar-datos.mjs`). Si falla la descarga, se usan los del repositorio.
- **API:** `/api/live` y `/api/carreteras` son funciones ([api/](api/)) que usan el mismo motor que el servidor local, [lib/engine.mjs](lib/engine.mjs). En lugar de sondear continuamente, cada petición refresca solo las fuentes caducadas. La CDN de Vercel comparte la respuesta 10 s (carreteras, 120 s) entre todos los visitantes.
- **Región:** las funciones corren en París (`cdg1`), cerca de las fuentes.

Diferencias con el servidor local:

- «Directo», «en lo que va de día» y la confirmación de retrasos en dos lecturas viven en la memoria de la función: se mantienen mientras la instancia esté activa y se reinician en frío.
- No hay historial (`/api/history`), porque Vercel no permite escribir ficheros que duren.
- El límite de FGC (5.000 peticiones al día por IP) se comparte con otros proyectos que salgan por la misma IP de Vercel. Si se agota, FGC sale como «sin actualizar».
- Los datos estáticos solo se renuevan al volver a desplegar. Conviene desplegar al menos una vez por semana: el horario de FGC cubre 8 días y los `trip_id` de Renfe cambian con cada periodo de horarios.

## Cómo funciona

```
Renfe GTFS-RT ────┐ cada 15 s
FGC Geotren ──────┤ cada 30 s        ┌──────────────┐  /api/live (+ x-data-next)  ┌──────────┐
FGC GTFS-RT TU ───┤ cada 60 s        │              │
Renfe GTFS-RT LD ─┤ cada 30 s   ───► │  server.mjs  │ ──────────────────────────► │ navegador│
Avisos Renfe ─────┤ cada 60 s        └──────────────┘  /api/carreteras            └──────────┘
SCT (GML) ────────┘ cada 3 min         estado por línea y corredor, «Directo», historial
```

El navegador no habla con los operadores. Pregunta al servidor local, que le indica en la cabecera `x-data-next` cuándo tendrá datos nuevos. El siguiente sondeo se programa entre 2 y 12 s, igual que en la web original. Cada tren se desliza de su posición anterior a la nueva.

| Archivo | Qué hace |
|---|---|
| `scripts/preparar-datos.mjs` | Descarga los GTFS estáticos y genera `data/static.json`, `data/fgc-horarios.json`, `public/data/vias.geojson` y `public/data/estaciones.geojson` |
| `lib/engine.mjs` | Motor: consulta las fuentes, calcula el estado de cada línea y arma las respuestas |
| `lib/gtfs-rt.mjs`, `lib/zip.mjs` | Lectores de GTFS-RT (protobuf) y de .zip, sin dependencias |
| `server.mjs` | Servidor local: sondeo continuo, historial, API y página |
| `lib/moventis.mjs` | Bus Moventis: líneas, paradas y próximos buses, con caché |
| `api/` | Funciones de Vercel (`/api/live`, `/api/carreteras`, `/api/bus-*`) sobre el mismo motor |
| `public/` | Página: mapa MapLibre + OpenFreeMap, panel de líneas, avisos y carreteras |
| `data/historial.jsonl` | Una muestra cada 5 min (se crea al arrancar) |

### Endpoints

- `GET /api/live`: trenes (posición, línea, retraso), avisos, estado por línea (`railService.renfe` / `railService.fgc`), estado por corredor de AVE y larga distancia (`railService.ld`), «Directo» y estado de cada fuente.
- `GET /api/carreteras`: incidencias del SCT traducidas al castellano.
- `GET /api/history?h=24`: muestras del historial de las últimas *h* horas (máx. 168).

## Fuentes

| Red | Fuente | Clave |
|---|---|---|
| Rodalies | `gtfsrt.renfe.com` (posiciones, retrasos y avisos, GTFS-RT en JSON) | No |
| Rodalies (estático) | Renfe Data, GTFS de Cercanías (`fomento_transit.zip`) | No |
| AVE y larga distancia | `gtfsrt.renfe.com/vehicle_positions_LD.json` y `trip_updates_LD.json` (posición, retraso, cancelaciones) | No |
| TRAM | `opendata.tram.cat/api/v1`: `lines`, `lines/{id}/stops?page=0` y `StopTimes` (hora prevista y programada de los próximos tranvías en cada parada, con ocupación) | No |
| Bus Moventis | JSON de su página de tiempo real (`www.moventis.es`): `/moventis/es/lines`, `/api/json/GetTrayectos/{línea}/{fecha}` y `/api/json/GetTiemposParada/es/{parada}/{línea}/0` | No (no son datos abiertos oficiales) |
| AVE y larga distancia (estático) | Renfe Data, GTFS AV/LD/MD (`Fichero_AV_LD/google_transit.zip`) | No |
| FGC | `dadesobertes.fgc.cat`: `posicionament-dels-trens` (posición, en hora, ocupación), `trip-updates-gtfs_realtime` (hora prevista por parada, protobuf) y `gtfs_zip` (horario) | No (límite de 5.000 peticiones al día por IP, sumando todos los conjuntos) |
| Carreteras | `gencat.cat/transit/opendata/incidenciesGML.xml` | No |
| Mapa | OpenFreeMap (estilo Positron), © OpenStreetMap | No |

## Criterios (copiados de la metodología publicada por La Vanguardia)

- Un tren va **en hora** con 3 min de retraso o menos (criterio de Renfe).
- Un retraso solo cuenta si Renfe lo **repite en dos lecturas seguidas**.
- **En lo que va de día**: cada tren cuenta una sola vez, con el último retraso que publicó.

### Simplificación respecto al original

La Vanguardia mide el estado de cada línea **desde el andén**: cuánto más de lo previsto espera el viajero, cruzando el horario con el tiempo real. Aquí se usa una aproximación sin horarios:

- **Grave**: retraso mediano de los trenes de la línea ≥ 15 min.
- **Retrasos**: retraso mediano > 3 min, o algún tren con ≥ 15 min.
- **Aviso**: hay un aviso oficial activo y los trenes van en hora.
- FGC: **Grave** si la mitad o más de sus trenes van con retraso, o si su retraso mediano llega a 15 min.

### Minutos de retraso en FGC

FGC no publica el retraso, solo la hora prevista de llegada a cada parada (GTFS-RT en protobuf, que lee [lib/gtfs-rt.mjs](lib/gtfs-rt.mjs) sin dependencias). El servidor calcula el retraso como la hora prevista menos la hora programada en la próxima parada, según `data/fgc-horarios.json` (de ayer a dentro de 8 días).

- En tiempo real el `trip_id` lleva otro prefijo de servicio que en el horario, así que se cruza por el código de viaje (lo que va tras `|`).
- Si ese código existe en varios servicios del día, se queda el más cercano a la previsión.
- Con minutos, un tren va con retraso a partir de 3 min, como en Rodalies. Sin previsión, se usa el «en hora» oficial de FGC.
- Para no pasar del límite diario: posiciones cada 30 s (2.880) + previsiones cada 60 s (1.440) = 4.320 peticiones al día.

### AVE y larga distancia

- Se muestran los AVE, Avlo, Alvia, Euromed, Intercity y Avant que paran en alguna estación de Catalunya. MD y regionales quedan fuera porque son las líneas R1x de Rodalies.
- Cada tren se asigna a un corredor según su recorrido en el horario oficial: Madrid, Francia, Andalucía, València y Alacant, Norte y Noroeste, Avant en Catalunya y Otros.
- Puntual: menos de 5 min de retraso. **Grave**: retraso mediano ≥ 15 min, o la mitad de los trenes con ≥ 15 min.
- Renfe publica cada tren varias veces, una por variante de recorrido (el dígito tras el número de tren en el `trip_id`). Se queda la variante con más paradas, y las cancelaciones se agrupan igual.
- La marca de tiempo del feed de posiciones LD va una hora por detrás (zona horaria), aunque las posiciones son actuales. Se usa la hora de recepción.
- El servidor regenera los datos estáticos una vez al día, porque los `trip_id` de Renfe cambian con cada periodo de horarios.

### TRAM

- El TRAM publica, para cada parada y sentido (`outboundCode` / `returnCode`), la hora prevista y la programada de los próximos tranvías. Se consulta cada 20 s.
- El retraso es la diferencia entre las dos horas en la próxima parada del tranvía.
- La posición no se publica: se estima entre la parada anterior y la siguiente según lo que le falta para llegar, como hace La Vanguardia con el metro.
- El trazado se dibuja uniendo las paradas en orden. Todas las líneas usan el verde corporativo `#008D78`.
- La ocupación llega en cinco niveles (de `EMPTY` a `FULL`) y se muestra en la misma barra de 5 tramos que FGC.

### Bus Moventis

- Moventis (Empresa Casas, Moventis, Sarbus, Sarfa y TCC Barcelona: 89 líneas) no publica datos abiertos. Se usan los JSON públicos de su página «Tiempo real», sin claves.
- No publica la posición de los buses, solo los próximos pasos por parada. Por eso funciona bajo demanda: líneas → recorridos y paradas → próximos buses de la parada elegida.
- Cachés ([lib/moventis.mjs](lib/moventis.mjs)): líneas y paradas 12 h; tiempos de una parada 30 s (en Vercel, además, la CDN).
- En verde, los minutos en tiempo real; en gris, la hora del horario. El recorrido del mapa une las paradas en línea recta.
- Al no ser una API oficial, puede cambiar sin aviso.

### Carreteras: código de color

Cada carretera lleva el color de los hitos kilométricos españoles. El SCT no publica el tipo de vía, así que se deduce del código:

| Color | Red | Códigos |
|---|---|---|
| Azul | Autopista o autovía | `A-`, `AP-` y una lista fija (aproximada) de autovías catalanas: C-16, C-17, C-25, C-31, C-32, C-33, C-58, C-60, B-10, B-20, B-23, B-30, B-40, T-11 |
| Rojo | Red del Estado | `N-` |
| Naranja | Generalitat, red básica (1.er orden) | `C-` de 1 o 2 cifras |
| Verde | Generalitat, comarcal y local (2.º orden) | `C-` de 3 o más cifras; `B-`, `GI-`, `L-`, `T-` de hasta 3 cifras |
| Amarillo | Diputaciones (3.er orden) | `BV-`, `BP-`, `GIV-`, `GIP-`, `TV-`, `TP-`, `LV-`, `LP-` |
| Verde redondeado | Itinerario europeo | `E-` |

La gravedad de la incidencia se ve en el color del texto (rojo cortes y congestión, naranja retenciones). El código de la vía no se parte nunca en dos líneas.

### Logos

Las tarjetas de arriba llevan el logo de cada compañía, en [public/logos/](public/logos/). Se han sacado de Wikimedia Commons, donde constan como dominio público, y son marcas registradas de sus operadores:

| Archivo | Origen |
|---|---|
| `rodalies.svg` | Símbolo naranja con la «R», recortado de *Rodalies de Catalunya logo.svg* (sin el texto) |
| `fgc.svg` | *FGC logo (2019).svg* |
| `ave.svg` | *AVE.svg*; en la tarjeta va sobre una placa blanca para que se vea en modo oscuro |
| `tram.svg` | *Tram Barcelona negative.svg* (Wikimedia Commons), sobre el verde del TRAM |
| `moventis-e.png` | La «e» naranja (`#FF6A14`) del logotipo de Moventis, recortada del logo facilitado: solo los píxeles naranjas, con fondo transparente (256 × 256) |

El icono de Carreteras es un pictograma genérico dibujado para esta página, en el azul de las autopistas.

## Qué falta respecto a la web original

- **Metro de Barcelona (TMB iMetro)** y **bus (iBus)**: requieren `app_id` y `app_key` gratuitos de developer.tmb.cat. TMB no publica la posición GPS del metro: el original la estima a partir de los tiempos de llegada a cada estación.
- Ouigo e Iryo: no publican datos abiertos en tiempo real.
- Avisos oficiales de AVE y larga distancia: Renfe no los publica en GTFS-RT (solo los de Cercanías).
- «¿Llego?» (trayectos), avisos de viajeros, otras ciudades.
- La posición del tren interpola en línea recta, no a lo largo de la vía.

## Cómo se ha analizado la web original

Con [REA](https://github.com/morluto/rea) (`rea-agents` 6.8.0), sobre un Chrome headless con perfil propio:

- `rea inspect-web-page --observation-ms 25000 --include-json-body-shapes`: muestra que la página sondea `api/live` cada pocos segundos (sin WebSockets) y da la forma del JSON (`trains`, `alerts`, `metroService`, `railService`, `sources`).
- `rea analyze-web-bundle`: análisis estático de `app.<hash>.js`. Las constantes del sondeo (`POLL_MS=1e4`, `LIVE_MIN_MS=2e3`, `LIVE_MAX_MS=12e3`, `LIVE_LAG_MS=700`) y el uso de `x-data-next` salen de ese código.
- La sección «Cómo se hace» de la propia web documenta las fuentes y los criterios.
