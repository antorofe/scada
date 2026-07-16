#!/usr/bin/env node
/*
 * Servidor del dashboard SCADA SEGRA — Módulo de Energía.
 * Sirve la pantalla de monitoreo y una API que lee de la BD del logger (pfw03.db).
 * Sin dependencias (http + node:sqlite integrado).
 *
 * Uso: node server.js [--db pfw03.db] [--http-port 8080]
 * Luego abre  http://localhost:8080  (o la IP del servidor en la intranet).
 */
const http = require('http');
const fs = require('fs');
const pathm = require('path');
const { DatabaseSync } = require('node:sqlite');
const fabricaDb = require('./fabrica-db'); // fuente MariaDB de producción (segra / segra_fabrica)
// Pool de conexiones a MariaDB: reutiliza conexiones autenticadas entre peticiones
// (el poll de producciones + comparativas abren muchas consultas). La config se lee
// una vez al arrancar; si cambia db.config.json, reiniciar el servicio.
const fabricaPool = new fabricaDb.MySQLPool(fabricaDb.loadDbConfig(), { max: 4 });

const a = process.argv.slice(2);
const arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
const DB_PATH = arg('db', pathm.join(__dirname, 'pfw03.db'));
const HTTP_PORT = parseInt(arg('http-port', '8080'), 10);
const HTML_FILE = pathm.join(__dirname, 'dashboard.html');

// ---- Configuración persistente (config.json) ----
const CONFIG_PATH = pathm.join(__dirname, 'config.json');
let config = { kwhValue: 150, currency: '$', host: '192.168.0.168', port: 8887, unit: 2 };
function loadConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch (_) {}
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (_) {}
}
function sanitizeConfig(patch) {
  const out = {};
  if (patch.kwhValue !== undefined) { const n = Number(patch.kwhValue); if (isFinite(n)) out.kwhValue = n; }
  if (patch.currency !== undefined) out.currency = String(patch.currency).slice(0, 8);
  if (patch.host !== undefined) out.host = String(patch.host).slice(0, 64).trim();
  if (patch.port !== undefined) { const n = parseInt(patch.port, 10); if (n > 0 && n < 65536) out.port = n; }
  if (patch.unit !== undefined) { const n = parseInt(patch.unit, 10); if (n >= 0 && n <= 247) out.unit = n; }
  return out;
}
loadConfig();

// Conexión perezosa de solo-lectura (la BD la crea el logger; puede no existir aún)
let db = null;
function getDb() {
  if (db) return db;
  if (!fs.existsSync(DB_PATH)) return null;
  try { db = new DatabaseSync(DB_PATH, { readOnly: true }); return db; }
  catch (_) { return null; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function latest() {
  const d = getDb(); if (!d) return null;
  // Última lectura EXITOSA (ok=1): así el estado/valores reflejan el último dato
  // real del equipo, no una fila de error. Si el equipo falla, esta fila envejece
  // de forma estable → "Inactivo" sin parpadeo (en vez de oscilar con las filas de error).
  return d.prepare('SELECT * FROM readings WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() || null;
}

function history(fromMs, toMs) {
  const d = getDb(); if (!d) return [];
  let rows = d.prepare(
    'SELECT ts_unix_ms AS t, i, p, fp, thdi FROM readings WHERE ts_unix_ms >= ? AND ts_unix_ms <= ? AND ok = 1 ORDER BY ts_unix_ms'
  ).all(fromMs, toMs);
  // Diezmado si hay demasiados puntos (mantiene ~1200 máx para la gráfica)
  const MAX = 1200;
  if (rows.length > MAX) {
    const stride = Math.ceil(rows.length / MAX);
    rows = rows.filter((_, idx) => idx % stride === 0);
  }
  return rows;
}

// Mín/máx de los parámetros eléctricos en un periodo. Se resuelve con agregación
// SQL (no materializa filas en JS), así que da igual que el rango sean 5 min o 24 h.
// Incluye i/p/fp además de los parámetros de los tiles: así los extremos del reporte
// (potencia y corriente máx.) salen de TODAS las muestras y no de la serie diezmada
// que se manda a la gráfica, que se salta los picos.
const MINMAX_COLS = ['v', 'i', 'p', 'q', 's', 'fp', 'cosphi', 'freq', 'thdv', 'thdi'];
function minmax(fromMs, toMs) {
  const d = getDb(); if (!d) return null;
  const sel = MINMAX_COLS
    .map(c => `MIN(${c}) AS ${c}_min, MAX(${c}) AS ${c}_max, AVG(${c}) AS ${c}_avg`)
    .join(', ');
  // `v > 0` descarta las lecturas en las que el medidor responde ok pero devuelve
  // todo a cero (fallo puntual del equipo): un solo cero hundiría el mínimo a 0 V.
  return d.prepare(
    `SELECT ${sel}, COUNT(*) AS samples FROM readings
      WHERE ts_unix_ms >= ? AND ts_unix_ms <= ? AND ok = 1 AND v > 0`
  ).get(fromMs, toMs) || null;
}

// Integra la potencia activa (W) en el tiempo → energía (kWh).
// Usa agregación SQL (SUM/COUNT/MIN/MAX): O(filas) en el motor, sin materializar
// filas en JS → escala a millones de registros (mes/año) sin coste por segundo.
// Método rectangular: energía = Σ(P) · Δt_medio; a muestreo de 1 s difiere del
// trapezoidal en <0,1 %.
function energy(fromMs, toMs) {
  const d = getDb(); if (!d) return null;
  // Cada fila lleva 'secs' = segundos que representa (1 para datos crudos; N para
  // datos comprimidos). Energía = Σ(P·secs) → exacta, escalable y a prueba de huecos
  // (los periodos sin datos no cuentan). avgKw = energía / tiempo realmente medido.
  const r = d.prepare(
    'SELECT SUM(p * secs) AS psum, SUM(secs) AS tsecs, COUNT(*) AS n, MIN(ts_unix_ms) AS mn, MAX(ts_unix_ms) AS mx ' +
    'FROM readings WHERE ts_unix_ms >= ? AND ts_unix_ms <= ? AND ok = 1 AND p IS NOT NULL'
  ).get(fromMs, toMs);
  const n = r.n || 0;
  if (n < 1) return { kwh: 0, samples: 0, durationMs: 0, avgKw: 0, from: fromMs, to: toMs };
  const kwh = (r.psum || 0) / 3600 / 1000;
  const measuredH = (r.tsecs || 0) / 3600;
  const avgKw = measuredH > 0 ? kwh / measuredH : 0;
  return { kwh, samples: n, durationMs: r.mx - r.mn, avgKw, from: r.mn, to: r.mx };
}

// ---- Energía por lote de producción (almacén escribible propio) ----
// pfw03.db se abre en solo-lectura; la energía consolidada de cada producción
// terminada se persiste aquí para no recalcularla en cada consulta. Las producciones
// terminadas no cambian, así que el valor guardado es estable (y la retención del
// logger conserva la energía, por lo que seguiría siendo recalculable si hiciera falta).
const ENERGIA_DB = pathm.join(__dirname, 'energia.db');
let edb = null;
function getEnergiaDb() {
  if (edb) return edb;
  try {
    edb = new DatabaseSync(ENERGIA_DB);
    edb.exec(`CREATE TABLE IF NOT EXISTS lote_energia (
      lote INTEGER PRIMARY KEY, inicio_ms INTEGER, fin_ms INTEGER,
      kwh REAL, avg_kw REAL, samples INTEGER, saved_at INTEGER
    )`);
  } catch (_) { edb = null; }
  return edb;
}
// Construye los TRAMOS ACTIVOS de un lote a partir de sus eventos PRODUCCION_INICIADA
// (ordenados): cada '1' abre un tramo y el siguiente '0' lo cierra (los '1' repetidos
// se ignoran, la producción sigue activa). Si queda un tramo abierto, se cierra en
// 'cierreMs' (ahora, para la producción en curso; el último evento, para las terminadas).
// Así se excluye la energía consumida durante las pausas.
function tramosActivos(eventos, cierreMs) {
  const tramos = [];
  let abierto = null;
  for (const ev of eventos) {
    if (String(ev.valor) === '1') { if (abierto == null) abierto = Number(ev.ms); }
    else { if (abierto != null) { tramos.push([abierto, Number(ev.ms)]); abierto = null; } }
  }
  if (abierto != null && cierreMs != null) tramos.push([abierto, cierreMs]);
  return tramos;
}
// Batches producidos/programados de un lote, corrigiendo los reinicios del contador.
// El contador BATCH_PRODUCIDOS se reinicia al pausar/reanudar y suele reprogramarse
// (BATCH_PROGRAMADOS baja: p. ej. 20 → 17 cuando ya había 3 hechos). Por eso:
//   producidos = (programados_total − programados_actual) + máx del segmento actual
//   programados = programados_total (el objetivo del lote)
// prodVals/progVals: valores (enteros, en orden por id); los 0 son marcadores de
// reinicio/fin, no batches.
function calcBatches(prodVals, progVals) {
  const progNZ = progVals.filter(v => v > 0);
  const progTotal = progNZ.length ? Math.max(...progNZ) : null;
  const progActual = progNZ.length ? progNZ[progNZ.length - 1] : null;
  const hechosAntes = (progTotal != null && progActual != null) ? Math.max(0, progTotal - progActual) : 0;
  let segMax = 0, prev = null;                 // máx del último segmento del contador
  for (const v of prodVals) {
    if (v === 0) continue;                      // marcador de reset/fin, no es batch
    if (prev != null && v < prev) segMax = 0;   // el contador bajó → nuevo segmento
    segMax = Math.max(segMax, v);
    prev = v;
  }
  return { producidos: hechosAntes + segMax, programados: progTotal };
}
// Segmentos de producción (para el detalle del tiempo transcurrido): pares
// inicio→fin de cada tramo activo. El último queda "abierto" (hasta=null) si la
// producción sigue en marcha; el cliente lo cierra en "ahora".
function segmentosProduccion(eventos) {
  const segs = [];
  let abierto = null;
  for (const ev of eventos) {
    if (String(ev.valor) === '1') { if (abierto == null) abierto = ev; }
    else { if (abierto != null) { segs.push({ desde: Number(abierto.ms), desde_f: abierto.fecha, hasta: Number(ev.ms), hasta_f: ev.fecha }); abierto = null; } }
  }
  if (abierto != null) segs.push({ desde: Number(abierto.ms), desde_f: abierto.fecha, hasta: null, hasta_f: null });
  return segs;
}
// Suma la energía del PFW03 sobre una lista de tramos [from,to] (kWh).
function energiaTramos(tramos) {
  let kwh = 0, samples = 0;
  for (const [from, to] of tramos) {
    if (from == null || to == null || to <= from) continue;
    const e = energy(from, to);
    if (e) { kwh += e.kwh; samples += e.samples; }
  }
  return { kwh, samples };
}
// Energía activa de un lote TERMINADO: usa el valor guardado si la firma (último
// evento) coincide; si no, la calcula sumando tramos y la guarda.
function energiaLoteActivaGuardada(lote, tramos, firmaMs) {
  const e = getEnergiaDb();
  if (e) {
    const row = e.prepare('SELECT * FROM lote_energia WHERE lote = ?').get(lote);
    if (row && row.fin_ms === firmaMs) return row.kwh;
  }
  const { kwh, samples } = energiaTramos(tramos);
  if (e && samples > 0) {
    try {
      e.prepare('INSERT OR REPLACE INTO lote_energia (lote,inicio_ms,fin_ms,kwh,avg_kw,samples,saved_at) VALUES (?,?,?,?,?,?,?)')
        .run(lote, tramos.length ? tramos[0][0] : null, firmaMs, kwh, 0, samples, Date.now());
    } catch (_) {}
  }
  return kwh;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      fs.readFile(HTML_FILE, (err, buf) => {
        if (err) { res.writeHead(500); return res.end('dashboard.html no encontrado'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buf);
      });
      return;
    }
    if (url.pathname === '/logo.jpeg') {
      fs.readFile(pathm.join(__dirname, 'logo.jpeg'), (err, buf) => {
        if (err) { res.writeHead(404); return res.end('logo no encontrado'); }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
        res.end(buf);
      });
      return;
    }
    if (url.pathname === '/api/latest') {
      const row = latest();
      const stale = row ? (Date.now() - row.ts_unix_ms > 5000) : true;
      return json(res, 200, { ok: !!row, stale, row });
    }
    if (url.pathname === '/api/history') {
      let from, to = Date.now();
      if (url.searchParams.has('from')) { // rango absoluto (histórico)
        from = parseInt(url.searchParams.get('from'), 10);
        to = parseInt(url.searchParams.get('to') || String(Date.now()), 10);
      } else {                             // relativo (vista en vivo)
        const minutes = Math.min(1440, Math.max(1, parseInt(url.searchParams.get('minutes') || '5', 10)));
        from = Date.now() - minutes * 60000;
      }
      return json(res, 200, { from, to, points: history(from, to) });
    }
    if (url.pathname === '/api/minmax') {
      let from, to = Date.now();
      if (url.searchParams.has('from')) {
        from = parseInt(url.searchParams.get('from'), 10);
        to = parseInt(url.searchParams.get('to') || String(Date.now()), 10);
      } else {
        const minutes = Math.min(1440, Math.max(1, parseInt(url.searchParams.get('minutes') || '5', 10)));
        from = Date.now() - minutes * 60000;
      }
      return json(res, 200, { from, to, ...(minmax(from, to) || {}) });
    }
    if (url.pathname === '/api/energy') {
      const from = parseInt(url.searchParams.get('from') || '0', 10);
      const to = parseInt(url.searchParams.get('to') || String(Date.now()), 10);
      const e = energy(from, to);
      return json(res, 200, e || { kwh: 0, samples: 0, durationMs: 0, avgKw: 0 });
    }
    if (url.pathname === '/api/config') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try { config = { ...config, ...sanitizeConfig(JSON.parse(body || '{}')) }; saveConfig(); json(res, 200, config); }
          catch (e) { json(res, 400, { error: e.message }); }
        });
        return;
      }
      return json(res, 200, config);
    }
    if (url.pathname === '/api/export') { // CSV del periodo (resolución completa)
      const from = parseInt(url.searchParams.get('from') || '0', 10);
      const to = parseInt(url.searchParams.get('to') || String(Date.now()), 10);
      const d = getDb();
      if (!d) { res.writeHead(503); return res.end('BD no disponible'); }
      const cols = ['v', 'i', 'p', 'q', 's', 'cosphi', 'fp', 'freq', 'thdv', 'thdi', 'inicio_dia', 'inicio_mes', 'kwh', 'kwh_e', 'kvarh_i', 'kvarh_c'];
      const rows = d.prepare(
        `SELECT ts_unix_ms, ${cols.join(',')} FROM readings WHERE ts_unix_ms >= ? AND ts_unix_ms <= ? AND ok = 1 ORDER BY ts_unix_ms`
      ).all(from, to);
      const fname = `reporte_energia_${new Date(to).toISOString().slice(0, 16).replace(/[-:T]/g, '')}.csv`;
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}"` });
      res.write('fecha_hora,' + cols.join(',') + '\n');
      for (const r of rows) {
        res.write(new Date(r.ts_unix_ms).toISOString() + ',' + cols.map(c => (r[c] == null ? '' : r[c])).join(',') + '\n');
      }
      return res.end();
    }
    if (url.pathname === '/api/health') {
      return json(res, 200, { db: !!getDb(), dbPath: DB_PATH });
    }
    // Prueba de la fuente MariaDB de producción: conecta, consulta y responde estado.
    // Un fallo de la BD no tumba el server: siempre responde 200 con ok:false.
    if (url.pathname === '/api/fabrica/ping') {
      (async () => {
        const t0 = Date.now();
        const dbcfg = fabricaDb.loadDbConfig();
        let cli;
        try {
          cli = await fabricaPool.acquire();
          const server = (await cli.query('SELECT VERSION() AS version, NOW() AS ahora, CURRENT_USER() AS usuario')).rows[0] || null;
          const ultimaMuestra = (await cli.query(
            'SELECT fechahora, tipo, subtipo, valor FROM segra_fabrica.data_pelleteras ORDER BY id DESC LIMIT 1'
          )).rows[0] || null;
          json(res, 200, { ok: true, ms: Date.now() - t0, host: dbcfg.host, port: dbcfg.port || 3306, server, ultimaMuestra });
        } catch (e) {
          json(res, 200, { ok: false, ms: Date.now() - t0, host: dbcfg.host, port: dbcfg.port || 3306, error: e.message });
        } finally { if (cli) fabricaPool.release(cli); }
      })();
      return;
    }
    // Producciones (tabla segra_fabrica.data_ciclado): producción en curso + últimas N.
    // La tabla es de eventos clave-valor por lote (variable/valor). 'valor' es texto,
    // así que se castea a entero para los conteos de batch. Solo lectura.
    if (url.pathname === '/api/producciones') {
      // ?from=&to= (YYYY-MM-DD, fecha local de la BD) → filtra los lotes por su fecha
      // de inicio de producción y sube el tope de filas. Sin rango: últimas N (limit).
      const reDate = /^\d{4}-\d{2}-\d{2}$/;
      const fromD = url.searchParams.get('from') || '';
      const toD = url.searchParams.get('to') || '';
      const hasRange = reDate.test(fromD) && reDate.test(toD);
      const limit = hasRange
        ? Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '1000', 10)))
        : Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
      // Condición de rango para el subquery de selección de lotes (sobre el inicio=1).
      const rangeCond = hasRange
        ? `AND valor='1' AND fecha >= '${fromD} 00:00:00' AND fecha <= '${toD} 23:59:59'`
        : '';
      // ?solo=actual → solo la producción en curso (refresco liviano en tiempo real,
      // sin recalcular la lista de las últimas producciones).
      const soloActual = url.searchParams.get('solo') === 'actual';
      (async () => {
        let cli;
        try {
          cli = await fabricaPool.acquire();
          // Hora del propio servidor de BD: el cliente calcula el "transcurrido" contra
          // esta referencia (no contra el reloj del navegador, que puede diferir).
          const serverNow = (await cli.query('SELECT NOW() AS now')).rows[0].now;
          // Últimas N producciones: 1 fila por lote (con evento de inicio), agregando
          // primer inicio, último fin y batches (programados / producidos).
          // inicio_ms/fin_ms: epoch (ms) calculado por MariaDB con UNIX_TIMESTAMP para
          // correlacionar con pfw03.db, que guarda epoch UTC (los relojes están en husos
          // distintos: la BD en hora local, la caja SCADA en UTC). last_ms = último evento
          // del lote (respaldo de fin cuando no hay evento explícito valor=0).
          const lista = soloActual ? [] : (await cli.query(
            `SELECT lote,
                MIN(CASE WHEN variable='PRODUCCION_INICIADA' AND valor='1' THEN fecha END) AS inicio,
                MAX(CASE WHEN variable='PRODUCCION_INICIADA' AND valor='0' THEN fecha END) AS fin,
                UNIX_TIMESTAMP(MIN(CASE WHEN variable='PRODUCCION_INICIADA' AND valor='1' THEN fecha END))*1000 AS inicio_ms,
                UNIX_TIMESTAMP(MAX(CASE WHEN variable='PRODUCCION_INICIADA' AND valor='0' THEN fecha END))*1000 AS fin_ms,
                UNIX_TIMESTAMP(MAX(fecha))*1000 AS last_ms,
                MAX(CASE WHEN variable='BATCH_PROGRAMADOS' THEN CAST(valor AS UNSIGNED) END) AS programados,
                MAX(CASE WHEN variable='BATCH_PRODUCIDOS' THEN CAST(valor AS UNSIGNED) END) AS producidos
             FROM segra_fabrica.data_ciclado
             WHERE lote IN (
               SELECT lote FROM (
                 SELECT lote FROM segra_fabrica.data_ciclado
                 WHERE variable='PRODUCCION_INICIADA' ${rangeCond}
                 GROUP BY lote ORDER BY MAX(id) DESC LIMIT ${limit}
               ) t
             )
             GROUP BY lote ORDER BY inicio DESC`
          )).rows;
          // Producción en curso = último lote con PRODUCCION_INICIADA=1.
          const head = (await cli.query(
            "SELECT lote FROM segra_fabrica.data_ciclado WHERE variable='PRODUCCION_INICIADA' AND valor='1' ORDER BY id DESC LIMIT 1"
          )).rows[0];
          let actual = null;
          if (head) {
            const lote = parseInt(head.lote, 10); // viene de la propia BD; se fuerza a entero
            actual = (await cli.query(
              `SELECT
                 ${lote} AS lote,
                 (SELECT valor FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='PRODUCCION_INICIADA' ORDER BY id DESC LIMIT 1) AS en_marcha,
                 (SELECT fecha FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='PRODUCCION_INICIADA' AND valor='1' ORDER BY id ASC LIMIT 1) AS inicio,
                 (SELECT fecha FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='PRODUCCION_INICIADA' AND valor='0' ORDER BY id DESC LIMIT 1) AS fin,
                 (SELECT UNIX_TIMESTAMP(MIN(fecha))*1000 FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='PRODUCCION_INICIADA' AND valor='1') AS inicio_ms,
                 (SELECT CAST(valor AS UNSIGNED) FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='BATCH_PROGRAMADOS' ORDER BY id DESC LIMIT 1) AS programados,
                 (SELECT CAST(valor AS UNSIGNED) FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='BATCH_PRODUCIDOS' ORDER BY id DESC LIMIT 1) AS producidos`
            )).rows[0] || null;
          }

          const ahora = Date.now();

          // Energía (tramos activos) + programación del lote EN CURSO, con consultas
          // dedicadas de un solo lote → sirve para el refresco liviano ?solo=actual.
          if (actual) {
            const lote = Number(actual.lote);
            const evs = (await cli.query(
              `SELECT valor, UNIX_TIMESTAMP(fecha)*1000 AS ms, fecha FROM segra_fabrica.data_ciclado
               WHERE variable='PRODUCCION_INICIADA' AND lote=${lote} ORDER BY id`
            )).rows;
            const tramosA = tramosActivos(evs, ahora);
            actual.kwh = evs.length ? energiaTramos(tramosA).kwh : null;
            actual.activo_ms = tramosA.reduce((a, t) => a + Math.max(0, t[1] - t[0]), 0); // tiempo activo (sin pausas)
            actual.segmentos = segmentosProduccion(evs);   // para el detalle del transcurrido
            const p = (await cli.query(
              `SELECT pr.nombre AS producto, pg.cod_producto, pg.cliente, pg.kg_produccion AS kg,
                      pg.kg_batch, pg.tipo, pg.formato
               FROM segra.programacion pg LEFT JOIN segra.productos pr ON pr.id = pg.cod_producto
               WHERE pg.lote=${lote} LIMIT 1`
            )).rows[0];
            if (p) Object.assign(actual, p);
            // Batches producidos/programados corrigiendo los reinicios del contador.
            const bv = (await cli.query(
              `SELECT variable, CAST(valor AS SIGNED) AS v FROM segra_fabrica.data_ciclado
               WHERE lote=${lote} AND variable IN ('BATCH_PRODUCIDOS','BATCH_PROGRAMADOS') ORDER BY id`
            )).rows;
            const cb = calcBatches(
              bv.filter(x => x.variable === 'BATCH_PRODUCIDOS').map(x => Number(x.v)),
              bv.filter(x => x.variable === 'BATCH_PROGRAMADOS').map(x => Number(x.v))
            );
            actual.producidos = cb.producidos; actual.programados = cb.programados;
            // Horas de cada batch producido (para marcarlas en la gráfica de corriente).
            actual.batches = (await cli.query(
              `SELECT CAST(valor AS SIGNED) AS n, UNIX_TIMESTAMP(fecha)*1000 AS ms
               FROM segra_fabrica.data_ciclado
               WHERE lote=${lote} AND variable='BATCH_PRODUCIDOS' AND CAST(valor AS SIGNED) > 0 ORDER BY id`
            )).rows.map(r => ({ n: Number(r.n), ms: Number(r.ms) }));
          }

          // Energía + programación de las últimas producciones (solo si se pidió la lista).
          // Los eventos y la programación de los lotes se traen en una sola consulta cada uno.
          if (lista.length) {
            const lotes = lista.map(r => Number(r.lote)).filter(n => !isNaN(n));
            const eventosPorLote = {};
            const evs = (await cli.query(
              `SELECT lote, valor, UNIX_TIMESTAMP(fecha)*1000 AS ms FROM segra_fabrica.data_ciclado
               WHERE variable='PRODUCCION_INICIADA' AND lote IN (${lotes.join(',')}) ORDER BY lote, id`
            )).rows;
            for (const ev of evs) (eventosPorLote[String(ev.lote)] ||= []).push(ev);
            const progPorLote = {};
            const prog = (await cli.query(
              `SELECT pg.lote, pr.nombre AS producto, pg.cod_producto, pg.cliente,
                      pg.kg_produccion AS kg, pg.kg_batch, pg.tipo, pg.formato
               FROM segra.programacion pg LEFT JOIN segra.productos pr ON pr.id = pg.cod_producto
               WHERE pg.lote IN (${lotes.join(',')})`
            )).rows;
            for (const p of prog) progPorLote[String(p.lote)] = p;
            const attachProg = (obj) => {
              const p = obj && progPorLote[String(obj.lote)];
              if (p) { obj.producto = p.producto; obj.cod_producto = p.cod_producto; obj.cliente = p.cliente; obj.kg = p.kg; obj.kg_batch = p.kg_batch; obj.tipo = p.tipo; obj.formato = p.formato; }
            };
            // Eventos de batch por lote → producidos/programados corregidos por reinicios.
            const batchPorLote = {};
            const bevs = (await cli.query(
              `SELECT lote, variable, CAST(valor AS SIGNED) AS v FROM segra_fabrica.data_ciclado
               WHERE variable IN ('BATCH_PRODUCIDOS','BATCH_PROGRAMADOS') AND lote IN (${lotes.join(',')})
               ORDER BY lote, id`
            )).rows;
            for (const e of bevs) {
              const b = (batchPorLote[String(e.lote)] ||= { prod: [], prog: [] });
              (e.variable === 'BATCH_PRODUCIDOS' ? b.prod : b.prog).push(Number(e.v));
            }
            const runningLote = (actual && String(actual.en_marcha) === '1') ? String(actual.lote) : null;
            for (const row of lista) {
              const evsL = eventosPorLote[String(row.lote)] || [];
              const enCurso = String(row.lote) === runningLote;
              const cierre = enCurso ? ahora : (row.last_ms != null ? Number(row.last_ms) : null);
              const tramos = tramosActivos(evsL, cierre);
              row.activo_ms = tramos.reduce((a, t) => a + Math.max(0, t[1] - t[0]), 0); // tiempo activo (sin pausas)
              if (enCurso) {
                row.kwh = energiaTramos(tramos).kwh;               // en curso → tramos hasta ahora
              } else {
                const firma = row.last_ms != null ? Number(row.last_ms) : null;
                row.kwh = tramos.length ? energiaLoteActivaGuardada(Number(row.lote), tramos, firma) : null;
              }
              attachProg(row);
              const b = batchPorLote[String(row.lote)];
              if (b) { const cb = calcBatches(b.prod, b.prog); row.producidos = cb.producidos; row.programados = cb.programados; }
            }
          }
          json(res, 200, { ok: true, serverNow, actual, lista });
        } catch (e) {
          json(res, 200, { ok: false, error: e.message });
        } finally { if (cli) fabricaPool.release(cli); }
      })();
      return;
    }
    // Histórico de producciones por rango de fecha: resumen por tipo del $/kg
    // (costo energético) promedio PONDERADO respecto a los kg REALIZADOS
    // (batches producidos × kg_batch). Solo se consideran los lotes con datos:
    // los que quedan en 0 por falta de información (sin energía medida o sin kg
    // realizados) NO entran en el promedio. Rango en fecha local de la BD
    // (YYYY-MM-DD), sobre el inicio de producción (PRODUCCION_INICIADA=1).
    if (url.pathname === '/api/producciones/historico') {
      const reDate = /^\d{4}-\d{2}-\d{2}$/;
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';
      if (!reDate.test(from) || !reDate.test(to)) {
        return json(res, 400, { ok: false, error: 'fechas inválidas (se espera YYYY-MM-DD)' });
      }
      const desde = `${from} 00:00:00`, hasta = `${to} 23:59:59`;
      // Solo estos tipos entran al resumen (los demás, p. ej. GRANO, se ignoran).
      const TIPOS = ['PELLET', 'MOLIDO', 'MOLIDO MONOPRODUCTO'];
      (async () => {
        let cli;
        try {
          cli = await fabricaPool.acquire();
          const serverNow = (await cli.query('SELECT NOW() AS now')).rows[0].now;
          const ahora = Date.now();
          // Lote realmente EN MARCHA = el del último evento PRODUCCION_INICIADA si es
          // valor='1'. Solo ese cierra sus tramos en "ahora"; los demás lotes usan su
          // último evento. Sin esto, un lote abandonado con un inicio (=1) sin cierre
          // (=0) se tomaría como "en curso" y barrería energía hasta ahora (kWh irreal).
          const ultIni = (await cli.query(
            "SELECT lote, valor FROM segra_fabrica.data_ciclado WHERE variable='PRODUCCION_INICIADA' ORDER BY id DESC LIMIT 1"
          )).rows[0];
          const runningLote = (ultIni && String(ultIni.valor) === '1') ? String(parseInt(ultIni.lote, 10)) : null;
          // Lotes cuyo inicio de producción cae dentro del rango. last_ms = último
          // evento del lote (firma/cierre de energía para lotes terminados).
          const lista = (await cli.query(
            `SELECT lote,
                MIN(CASE WHEN variable='PRODUCCION_INICIADA' AND valor='1' THEN fecha END) AS inicio,
                UNIX_TIMESTAMP(MAX(fecha))*1000 AS last_ms
             FROM segra_fabrica.data_ciclado
             WHERE lote IN (
               SELECT DISTINCT lote FROM segra_fabrica.data_ciclado
               WHERE variable='PRODUCCION_INICIADA' AND valor='1'
                 AND fecha >= '${desde}' AND fecha <= '${hasta}'
             )
             GROUP BY lote ORDER BY inicio DESC`
          )).rows;

          const resumen = {};
          for (const t of TIPOS) resumen[t] = { tipo: t, lotes: 0, kg: 0, costo: 0, kwh: 0 };
          const detalle = [];
          let considerados = 0, excluidos = 0;

          if (lista.length) {
            const lotes = lista.map(r => Number(r.lote)).filter(n => !isNaN(n));
            // Eventos PRODUCCION_INICIADA de todos los lotes (para los tramos activos).
            const eventosPorLote = {};
            const evs = (await cli.query(
              `SELECT lote, valor, UNIX_TIMESTAMP(fecha)*1000 AS ms FROM segra_fabrica.data_ciclado
               WHERE variable='PRODUCCION_INICIADA' AND lote IN (${lotes.join(',')}) ORDER BY lote, id`
            )).rows;
            for (const ev of evs) (eventosPorLote[String(ev.lote)] ||= []).push(ev);
            // Programación (kg_batch, tipo) de cada lote.
            const progPorLote = {};
            const prog = (await cli.query(
              `SELECT lote, kg_batch, tipo FROM segra.programacion WHERE lote IN (${lotes.join(',')})`
            )).rows;
            for (const p of prog) progPorLote[String(p.lote)] = p;
            // Eventos de batch por lote → producidos corregidos por reinicios.
            const batchPorLote = {};
            const bevs = (await cli.query(
              `SELECT lote, variable, CAST(valor AS SIGNED) AS v FROM segra_fabrica.data_ciclado
               WHERE variable IN ('BATCH_PRODUCIDOS','BATCH_PROGRAMADOS') AND lote IN (${lotes.join(',')})
               ORDER BY lote, id`
            )).rows;
            for (const e of bevs) {
              const b = (batchPorLote[String(e.lote)] ||= { prod: [], prog: [] });
              (e.variable === 'BATCH_PRODUCIDOS' ? b.prod : b.prog).push(Number(e.v));
            }

            for (const row of lista) {
              const key = String(row.lote);
              const p = progPorLote[key];
              const tipo = p ? p.tipo : null;
              // Fuera del resumen: tipos no pedidos (GRANO, etc.) o sin programación.
              if (!tipo || !TIPOS.includes(tipo)) continue;
              const evsL = eventosPorLote[key] || [];
              const enCurso = key === runningLote;   // solo el lote realmente en marcha
              const cierre = enCurso ? ahora : (row.last_ms != null ? Number(row.last_ms) : null);
              const tramos = tramosActivos(evsL, cierre);
              // Energía: en curso se calcula en vivo; terminado usa la caché por firma.
              const kwh = enCurso
                ? energiaTramos(tramos).kwh
                : (tramos.length ? energiaLoteActivaGuardada(Number(row.lote), tramos, cierre) : 0);
              const b = batchPorLote[key];
              const cb = b ? calcBatches(b.prod, b.prog) : { producidos: null };
              const kgBatch = p.kg_batch != null ? Number(p.kg_batch) : null;
              const producidos = cb.producidos != null ? Number(cb.producidos) : null;
              const kgReal = (kgBatch != null && producidos != null) ? producidos * kgBatch : 0;
              const costo = (kwh || 0) * (config.kwhValue || 0);
              // Lote válido = tiene energía medida (>0) y kg realizados (>0).
              // Los que quedan en 0 por falta de datos no entran al promedio.
              const valido = kwh > 0 && kgReal > 0;
              if (!valido) { excluidos++; continue; }
              considerados++;
              const g = resumen[tipo];
              g.lotes++; g.kg += kgReal; g.costo += costo; g.kwh += kwh;
              detalle.push({
                lote: Number(row.lote), tipo, inicio: row.inicio,
                producidos, kg_batch: kgBatch, kg: kgReal, kwh, costo, perKg: costo / kgReal,
              });
            }
          }

          const resumenArr = TIPOS.map(t => {
            const g = resumen[t];
            return { tipo: t, lotes: g.lotes, kg: g.kg, kwh: g.kwh, costo: g.costo,
                     perKg: g.kg > 0 ? g.costo / g.kg : null };
          });
          json(res, 200, {
            ok: true, from, to, serverNow,
            kwhValue: config.kwhValue, currency: config.currency,
            resumen: resumenArr, detalle,
            totalLotes: lista.length, considerados, excluidos,
          });
        } catch (e) {
          json(res, 200, { ok: false, error: e.message });
        } finally { if (cli) fabricaPool.release(cli); }
      })();
      return;
    }
    // Comparativa de un producto: rendimiento (kg/h) y costo ($/kg) del lote pedido
    // frente a (a) la historia del MISMO cod_producto y (b) los otros cod_producto del
    // MISMO tipo y formato. kg/h sale de los eventos (hay historia larga); $/kg solo
    // existe donde hay energía medida (ventana del medidor / caché), así que muchos
    // lotes antiguos muestran $/kg vacío — con el tiempo se irá poblando.
    if (url.pathname === '/api/producciones/comparativa') {
      const lote = parseInt(url.searchParams.get('lote') || '', 10);
      if (!Number.isInteger(lote)) { return json(res, 400, { ok: false, error: 'lote inválido' }); }
      const LIM_COD = 60;   // lotes recientes del mismo cod_producto + tipo + formato
      // Escapa una cadena para MySQL (comillas y backslash). Los valores vienen de la
      // propia BD, pero se escapan igual por seguridad.
      const sqlStr = v => "'" + String(v).replace(/[\\']/g, c => '\\' + c) + "'";
      const eq = (col, v) => (v == null ? `${col} IS NULL` : `${col}=${sqlStr(v)}`);
      (async () => {
        let cli;
        try {
          cli = await fabricaPool.acquire();
          const serverNow = (await cli.query('SELECT NOW() AS now')).rows[0].now;
          const ahora = Date.now();
          // Programación del lote de referencia.
          const ref = (await cli.query(
            `SELECT pg.lote, pg.cod_producto, pr.nombre AS producto, pg.tipo, pg.formato,
                    pg.kg_batch, pg.kg_produccion AS kg
             FROM segra.programacion pg LEFT JOIN segra.productos pr ON pr.id=pg.cod_producto
             WHERE pg.lote=${lote} LIMIT 1`
          )).rows[0];
          if (!ref) { return json(res, 200, { ok: false, error: 'lote sin programación' }); }
          // Lote realmente en marcha (cierre correcto de tramos; ver /historico).
          const ultIni = (await cli.query(
            "SELECT lote, valor FROM segra_fabrica.data_ciclado WHERE variable='PRODUCCION_INICIADA' ORDER BY id DESC LIMIT 1"
          )).rows[0];
          const runningLote = (ultIni && String(ultIni.valor) === '1') ? String(parseInt(ultIni.lote, 10)) : null;
          // Candidatos = lotes PRODUCIDOS del MISMO cod_producto + tipo + formato
          // (recientes). La comparación es del producto contra sí mismo.
          const producidosSub = "(SELECT DISTINCT lote FROM segra_fabrica.data_ciclado WHERE variable='PRODUCCION_INICIADA' AND valor='1')";
          const candCod = (await cli.query(
            `SELECT pg.lote FROM segra.programacion pg
             JOIN ${producidosSub} dc ON dc.lote=pg.lote
             WHERE ${eq('pg.cod_producto', ref.cod_producto)}
               AND ${eq('pg.tipo', ref.tipo)} AND ${eq('pg.formato', ref.formato)}
             ORDER BY pg.lote DESC LIMIT ${LIM_COD}`
          )).rows;
          const set = new Set();
          for (const r of candCod) set.add(Number(r.lote));
          set.add(lote);
          const lotes = [...set].filter(n => !isNaN(n));

          // Datos en bloque para todos los candidatos.
          const eventosPorLote = {};
          const evs = (await cli.query(
            `SELECT lote, valor, UNIX_TIMESTAMP(fecha)*1000 AS ms FROM segra_fabrica.data_ciclado
             WHERE variable='PRODUCCION_INICIADA' AND lote IN (${lotes.join(',')}) ORDER BY lote, id`
          )).rows;
          for (const ev of evs) (eventosPorLote[String(ev.lote)] ||= []).push(ev);
          const lastMs = {}, inicioF = {};
          const meta = (await cli.query(
            `SELECT lote, UNIX_TIMESTAMP(MAX(fecha))*1000 AS last_ms,
                    MIN(CASE WHEN variable='PRODUCCION_INICIADA' AND valor='1' THEN fecha END) AS inicio
             FROM segra_fabrica.data_ciclado WHERE lote IN (${lotes.join(',')}) GROUP BY lote`
          )).rows;
          for (const m of meta) { lastMs[String(m.lote)] = m.last_ms; inicioF[String(m.lote)] = m.inicio; }
          const progPorLote = {};
          const prog = (await cli.query(
            `SELECT pg.lote, pg.cod_producto, pr.nombre AS producto, pg.kg_batch
             FROM segra.programacion pg LEFT JOIN segra.productos pr ON pr.id=pg.cod_producto
             WHERE pg.lote IN (${lotes.join(',')})`
          )).rows;
          for (const p of prog) progPorLote[String(p.lote)] = p;
          const batchPorLote = {};
          const bevs = (await cli.query(
            `SELECT lote, variable, CAST(valor AS SIGNED) AS v FROM segra_fabrica.data_ciclado
             WHERE variable IN ('BATCH_PRODUCIDOS','BATCH_PROGRAMADOS') AND lote IN (${lotes.join(',')})
             ORDER BY lote, id`
          )).rows;
          for (const e of bevs) {
            const b = (batchPorLote[String(e.lote)] ||= { prod: [], prog: [] });
            (e.variable === 'BATCH_PRODUCIDOS' ? b.prod : b.prog).push(Number(e.v));
          }

          // Métricas por lote: kg realizados, horas activas, kg/h, kWh y $/kg.
          const metrica = (l) => {
            const key = String(l);
            const p = progPorLote[key];
            const evsL = eventosPorLote[key] || [];
            const enCurso = key === runningLote;
            const cierre = enCurso ? ahora : (lastMs[key] != null ? Number(lastMs[key]) : null);
            const tramos = tramosActivos(evsL, cierre);
            const activoMs = tramos.reduce((a, t) => a + Math.max(0, t[1] - t[0]), 0);
            const kwh = enCurso
              ? energiaTramos(tramos).kwh
              : (tramos.length ? energiaLoteActivaGuardada(l, tramos, cierre) : 0);
            const b = batchPorLote[key];
            const cb = b ? calcBatches(b.prod, b.prog) : { producidos: null };
            const kgBatch = p && p.kg_batch != null ? Number(p.kg_batch) : null;
            const producidos = cb.producidos != null ? Number(cb.producidos) : null;
            const kgReal = (kgBatch != null && producidos != null) ? producidos * kgBatch : 0;
            const activoH = activoMs / 3600000;
            const kgh = (kgReal > 0 && activoH > 0) ? kgReal / activoH : null;
            const costo = (kwh || 0) * (config.kwhValue || 0);
            const perKg = (kwh > 0 && kgReal > 0) ? costo / kgReal : null;
            return {
              lote: l, cod_producto: p ? p.cod_producto : null, producto: p ? p.producto : null,
              inicio: inicioF[key] || null, producidos, kg_batch: kgBatch, kg: kgReal,
              activoH, kwh, costo, kgh, perKg, enCurso,
            };
          };
          const porLote = {};
          for (const l of lotes) porLote[String(l)] = metrica(l);

          // Agrega una lista de métricas: kg/h ponderado (Σkg/Σh) y $/kg ponderado (Σcosto/Σkg).
          const agg = (items) => {
            let kgKgh = 0, hKgh = 0, costoE = 0, kgE = 0, nKgh = 0, nE = 0, totKg = 0;
            for (const m of items) {
              totKg += m.kg || 0;
              if (m.kgh != null) { kgKgh += m.kg; hKgh += m.activoH; nKgh++; }
              if (m.perKg != null) { costoE += m.costo; kgE += m.kg; nE++; }
            }
            return { n: items.length, nKgh, nEnergia: nE,
                     avgKgh: hKgh > 0 ? kgKgh / hKgh : null,
                     avgPerKg: kgE > 0 ? costoE / kgE : null, totKg };
          };

          const refM = porLote[String(lote)];
          // Historia del mismo cod_producto + tipo + formato (incluye el lote de
          // referencia), de la más reciente a la más antigua.
          const mismosItems = lotes.map(l => porLote[String(l)])
            .filter(Boolean)
            .sort((a, b) => b.lote - a.lote);
          const mismoProducto = { ...agg(mismosItems), lotes: mismosItems.slice(0, LIM_COD) };

          json(res, 200, {
            ok: true, serverNow, kwhValue: config.kwhValue, currency: config.currency,
            lote, cod_producto: ref.cod_producto, producto: ref.producto,
            tipo: ref.tipo, formato: ref.formato,
            ref: refM, mismoProducto,
          });
        } catch (e) {
          json(res, 200, { ok: false, error: e.message });
        } finally { if (cli) fabricaPool.release(cli); }
      })();
      return;
    }
    // Promedio de kg/h por producto (cod_producto + tipo + formato) para los lotes
    // pedidos. Sirve para mostrar, junto al kg/h de cada fila de la tabla, cuánto se
    // desvía del promedio de ese mismo producto. Solo usa eventos (sin energía), así
    // que es liviano; el cliente lo cachea por producto.
    if (url.pathname === '/api/producciones/kghprom') {
      const req = (url.searchParams.get('lotes') || '').split(',')
        .map(s => parseInt(s, 10)).filter(Number.isInteger);
      if (!req.length) { return json(res, 200, { ok: true, prom: {} }); }
      const lotesReq = [...new Set(req)];
      const LIM = 40;   // lotes recientes por producto para el promedio
      const tkey = (c, t, f) => [c, t, f].map(x => x == null ? '' : x).join('|');
      const sqlStr = v => "'" + String(v).replace(/[\\']/g, c => '\\' + c) + "'";
      const eq = (col, v) => (v == null ? `${col} IS NULL` : `${col}=${sqlStr(v)}`);
      (async () => {
        let cli;
        try {
          cli = await fabricaPool.acquire();
          const ahora = Date.now();
          // Producto (cod+tipo+formato) de cada lote pedido → triples distintos.
          const prog0 = (await cli.query(
            `SELECT lote, cod_producto, tipo, formato FROM segra.programacion WHERE lote IN (${lotesReq.join(',')})`
          )).rows;
          const triples = new Map();
          for (const r of prog0) triples.set(tkey(r.cod_producto, r.tipo, r.formato),
            { cod: r.cod_producto, tipo: r.tipo, formato: r.formato });
          if (!triples.size) { return json(res, 200, { ok: true, prom: {} }); }
          const ultIni = (await cli.query(
            "SELECT lote, valor FROM segra_fabrica.data_ciclado WHERE variable='PRODUCCION_INICIADA' ORDER BY id DESC LIMIT 1"
          )).rows[0];
          const runningLote = (ultIni && String(ultIni.valor) === '1') ? String(parseInt(ultIni.lote, 10)) : null;
          const producidosSub = "(SELECT DISTINCT lote FROM segra_fabrica.data_ciclado WHERE variable='PRODUCCION_INICIADA' AND valor='1')";
          // Lotes recientes de cada producto.
          const histPorTriple = {}; const allHist = new Set();
          for (const [k, t] of triples) {
            const hl = (await cli.query(
              `SELECT pg.lote FROM segra.programacion pg
               JOIN ${producidosSub} dc ON dc.lote=pg.lote
               WHERE ${eq('pg.cod_producto', t.cod)} AND ${eq('pg.tipo', t.tipo)} AND ${eq('pg.formato', t.formato)}
               ORDER BY pg.lote DESC LIMIT ${LIM}`
            )).rows.map(x => Number(x.lote));
            histPorTriple[k] = hl; hl.forEach(l => allHist.add(l));
          }
          const lotes = [...allHist];
          if (!lotes.length) { return json(res, 200, { ok: true, prom: {} }); }
          // Datos en bloque de todos los lotes de historia.
          const eventosPorLote = {}, lastMs = {}, kgBatchPorLote = {}, batchPorLote = {};
          const evs = (await cli.query(
            `SELECT lote, valor, UNIX_TIMESTAMP(fecha)*1000 AS ms FROM segra_fabrica.data_ciclado
             WHERE variable='PRODUCCION_INICIADA' AND lote IN (${lotes.join(',')}) ORDER BY lote, id`
          )).rows;
          for (const ev of evs) (eventosPorLote[String(ev.lote)] ||= []).push(ev);
          const meta = (await cli.query(
            `SELECT lote, UNIX_TIMESTAMP(MAX(fecha))*1000 AS last_ms FROM segra_fabrica.data_ciclado
             WHERE lote IN (${lotes.join(',')}) GROUP BY lote`
          )).rows;
          for (const m of meta) lastMs[String(m.lote)] = m.last_ms;
          const prog = (await cli.query(
            `SELECT lote, kg_batch FROM segra.programacion WHERE lote IN (${lotes.join(',')})`
          )).rows;
          for (const p of prog) kgBatchPorLote[String(p.lote)] = p.kg_batch;
          const bevs = (await cli.query(
            `SELECT lote, variable, CAST(valor AS SIGNED) AS v FROM segra_fabrica.data_ciclado
             WHERE variable IN ('BATCH_PRODUCIDOS','BATCH_PROGRAMADOS') AND lote IN (${lotes.join(',')})
             ORDER BY lote, id`
          )).rows;
          for (const e of bevs) {
            const b = (batchPorLote[String(e.lote)] ||= { prod: [], prog: [] });
            (e.variable === 'BATCH_PRODUCIDOS' ? b.prod : b.prog).push(Number(e.v));
          }
          // kg realizados y horas activas por lote (kg/h no necesita energía).
          const porLote = {};
          for (const l of lotes) {
            const key = String(l);
            const evsL = eventosPorLote[key] || [];
            const enCurso = key === runningLote;
            const cierre = enCurso ? ahora : (lastMs[key] != null ? Number(lastMs[key]) : null);
            const tramos = tramosActivos(evsL, cierre);
            const activoH = tramos.reduce((a, t) => a + Math.max(0, t[1] - t[0]), 0) / 3600000;
            const b = batchPorLote[key];
            const cb = b ? calcBatches(b.prod, b.prog) : { producidos: null };
            const kgBatch = kgBatchPorLote[key] != null ? Number(kgBatchPorLote[key]) : null;
            const producidos = cb.producidos != null ? Number(cb.producidos) : null;
            const kgReal = (kgBatch != null && producidos != null) ? producidos * kgBatch : 0;
            porLote[key] = { kg: kgReal, activoH, valido: kgReal > 0 && activoH > 0 };
          }
          // Promedio ponderado (Σkg/Σh) por producto.
          const prom = {};
          for (const [k] of triples) {
            let sk = 0, sh = 0;
            for (const l of (histPorTriple[k] || [])) {
              const m = porLote[String(l)];
              if (m && m.valido) { sk += m.kg; sh += m.activoH; }
            }
            prom[k] = sh > 0 ? sk / sh : null;
          }
          json(res, 200, { ok: true, prom });
        } catch (e) {
          json(res, 200, { ok: false, error: e.message });
        } finally { if (cli) fabricaPool.release(cli); }
      })();
      return;
    }
    // Detalle de un lote: batches producidos (cada BATCH_PRODUCIDOS con su hora) y
    // segmentos de producción (para el tiempo activo). Sirve para cualquier lote,
    // en curso o terminado. El cliente calcula minutos/kg-min y duraciones.
    if (url.pathname === '/api/producciones/detalle' || url.pathname === '/api/producciones/batches') {
      const lote = parseInt(url.searchParams.get('lote') || '', 10);
      if (!Number.isInteger(lote)) { return json(res, 400, { ok: false, error: 'lote inválido' }); }
      (async () => {
        let cli;
        try {
          cli = await fabricaPool.acquire();
          const serverNow = (await cli.query('SELECT NOW() AS now')).rows[0].now;
          const kgBatch = (await cli.query(
            `SELECT kg_batch, tipo FROM segra.programacion WHERE lote=${lote} LIMIT 1`
          )).rows[0];
          const inicio = (await cli.query(
            `SELECT UNIX_TIMESTAMP(MIN(fecha))*1000 AS inicio_ms FROM segra_fabrica.data_ciclado
             WHERE lote=${lote} AND variable='PRODUCCION_INICIADA' AND valor='1'`
          )).rows[0];
          const batches = (await cli.query(
            `SELECT CAST(valor AS UNSIGNED) AS n, UNIX_TIMESTAMP(fecha)*1000 AS ms, fecha
             FROM segra_fabrica.data_ciclado
             WHERE lote=${lote} AND variable='BATCH_PRODUCIDOS' AND CAST(valor AS UNSIGNED) > 0
             ORDER BY id`
          )).rows;
          const iniEvs = (await cli.query(
            `SELECT valor, UNIX_TIMESTAMP(fecha)*1000 AS ms, fecha FROM segra_fabrica.data_ciclado
             WHERE lote=${lote} AND variable='PRODUCCION_INICIADA' ORDER BY id`
          )).rows;
          const enMarcha = iniEvs.length ? iniEvs[iniEvs.length - 1].valor : null;
          json(res, 200, {
            ok: true, lote, serverNow,
            kg_batch: kgBatch ? kgBatch.kg_batch : null,
            tipo: kgBatch ? kgBatch.tipo : null,
            inicio_ms: inicio ? inicio.inicio_ms : null,
            en_marcha: enMarcha,
            batches,
            segmentos: segmentosProduccion(iniEvs),
          });
        } catch (e) {
          json(res, 200, { ok: false, error: e.message });
        } finally { if (cli) fabricaPool.release(cli); }
      })();
      return;
    }
    // Amperaje y temperatura de las pelleteras (CPM/KAHL) en una ventana [from,to] (ms).
    // data_pelleteras tiene ~22M filas y muestrea cada ~2 s → se acota por el índice
    // de fechahora y se AGREGA por buckets en SQL (no se transfieren millones de filas):
    //   ~600 puntos por serie, independiente del largo de la producción.
    if (url.pathname === '/api/producciones/pelleteras') {
      const from = parseInt(url.searchParams.get('from') || '', 10);
      const to = parseInt(url.searchParams.get('to') || '', 10);
      if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
        return json(res, 400, { ok: false, error: 'rango inválido' });
      }
      (async () => {
        let cli;
        try {
          cli = await fabricaPool.acquire();
          const fromS = Math.floor(from / 1000), toS = Math.floor(to / 1000);
          const bucket = Math.max(2, Math.ceil((toS - fromS) / 600)); // ~600 puntos/serie
          const cond = `tipo IN ('AMPERAJE','TEMPERATURA') AND subtipo IN ('CPM','KAHL')
             AND fechahora >= FROM_UNIXTIME(${fromS}) AND fechahora <= FROM_UNIXTIME(${toS})`;
          const rows = (await cli.query(
            `SELECT tipo, subtipo, FLOOR(UNIX_TIMESTAMP(fechahora)/${bucket})*${bucket} AS b, AVG(valor) AS v
             FROM segra_fabrica.data_pelleteras
             WHERE ${cond}
             GROUP BY tipo, subtipo, FLOOR(UNIX_TIMESTAMP(fechahora)/${bucket}) ORDER BY b`
          )).rows;
          const out = { cpm: { amp: [], temp: [], stats: {} }, kahl: { amp: [], temp: [], stats: {} } };
          for (const r of rows) {
            const pel = r.subtipo === 'CPM' ? out.cpm : out.kahl;
            (r.tipo === 'AMPERAJE' ? pel.amp : pel.temp).push({ t: Number(r.b) * 1000, y: Number(r.v) });
          }
          const stRows = (await cli.query(
            `SELECT tipo, subtipo, MIN(valor) mn, MAX(valor) mx, AVG(valor) av
             FROM segra_fabrica.data_pelleteras WHERE ${cond} GROUP BY tipo, subtipo`
          )).rows;
          for (const s of stRows) {
            const pel = s.subtipo === 'CPM' ? out.cpm : out.kahl;
            pel.stats[s.tipo === 'AMPERAJE' ? 'amp' : 'temp'] = { min: Number(s.mn), max: Number(s.mx), avg: Number(s.av) };
          }
          json(res, 200, { ok: true, bucket, cpm: out.cpm, kahl: out.kahl });
        } catch (e) {
          json(res, 200, { ok: false, error: e.message });
        } finally { if (cli) fabricaPool.release(cli); }
      })();
      return;
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(HTTP_PORT, () => {
  console.log(`SCADA SEGRA — dashboard escuchando en http://localhost:${HTTP_PORT}`);
  console.log(`  BD: ${DB_PATH}${fs.existsSync(DB_PATH) ? '' : '  (aún no existe: arranca el logger)'}`);
  console.log(`  Abre esa URL en el navegador (o http://<ip-del-servidor>:${HTTP_PORT} desde la intranet).`);
});
