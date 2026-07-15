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
    'SELECT ts_unix_ms AS t, i, p, fp FROM readings WHERE ts_unix_ms >= ? AND ts_unix_ms <= ? AND ok = 1 ORDER BY ts_unix_ms'
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
        const cli = new fabricaDb.MySQLClient(dbcfg);
        try {
          await cli.connect();
          const server = (await cli.query('SELECT VERSION() AS version, NOW() AS ahora, CURRENT_USER() AS usuario')).rows[0] || null;
          const ultimaMuestra = (await cli.query(
            'SELECT fechahora, tipo, subtipo, valor FROM segra_fabrica.data_pelleteras ORDER BY id DESC LIMIT 1'
          )).rows[0] || null;
          json(res, 200, { ok: true, ms: Date.now() - t0, host: dbcfg.host, port: dbcfg.port || 3306, server, ultimaMuestra });
        } catch (e) {
          json(res, 200, { ok: false, ms: Date.now() - t0, host: dbcfg.host, port: dbcfg.port || 3306, error: e.message });
        } finally { cli.close(); }
      })();
      return;
    }
    // Producciones (tabla segra_fabrica.data_ciclado): producción en curso + últimas N.
    // La tabla es de eventos clave-valor por lote (variable/valor). 'valor' es texto,
    // así que se castea a entero para los conteos de batch. Solo lectura.
    if (url.pathname === '/api/producciones') {
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));
      (async () => {
        const cli = new fabricaDb.MySQLClient(fabricaDb.loadDbConfig());
        try {
          await cli.connect();
          // Hora del propio servidor de BD: el cliente calcula el "transcurrido" contra
          // esta referencia (no contra el reloj del navegador, que puede diferir).
          const serverNow = (await cli.query('SELECT NOW() AS now')).rows[0].now;
          // Últimas N producciones: 1 fila por lote (con evento de inicio), agregando
          // primer inicio, último fin y batches (programados / producidos).
          // inicio_ms/fin_ms: epoch (ms) calculado por MariaDB con UNIX_TIMESTAMP para
          // correlacionar con pfw03.db, que guarda epoch UTC (los relojes están en husos
          // distintos: la BD en hora local, la caja SCADA en UTC). last_ms = último evento
          // del lote (respaldo de fin cuando no hay evento explícito valor=0).
          const lista = (await cli.query(
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
                 WHERE variable='PRODUCCION_INICIADA'
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
                 (SELECT fecha FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='PRODUCCION_INICIADA' AND valor='1' ORDER BY id DESC LIMIT 1) AS inicio,
                 (SELECT fecha FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='PRODUCCION_INICIADA' AND valor='0' ORDER BY id DESC LIMIT 1) AS fin,
                 (SELECT UNIX_TIMESTAMP(MIN(fecha))*1000 FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='PRODUCCION_INICIADA' AND valor='1') AS inicio_ms,
                 (SELECT CAST(valor AS UNSIGNED) FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='BATCH_PROGRAMADOS' ORDER BY id DESC LIMIT 1) AS programados,
                 (SELECT CAST(valor AS UNSIGNED) FROM segra_fabrica.data_ciclado WHERE lote=${lote} AND variable='BATCH_PRODUCIDOS' ORDER BY id DESC LIMIT 1) AS producidos`
            )).rows[0] || null;
          }

          // Energía por lote (kWh) SOLO de los tramos activos (se excluyen las pausas).
          // Se traen todos los eventos PRODUCCION_INICIADA de los lotes listados en una
          // sola consulta y se arman los tramos por lote.
          const lotes = lista.map(r => Number(r.lote)).filter(n => !isNaN(n));
          const eventosPorLote = {};
          if (lotes.length) {
            const evs = (await cli.query(
              `SELECT lote, valor, UNIX_TIMESTAMP(fecha)*1000 AS ms
               FROM segra_fabrica.data_ciclado
               WHERE variable='PRODUCCION_INICIADA' AND lote IN (${lotes.join(',')})
               ORDER BY lote, id`
            )).rows;
            for (const ev of evs) (eventosPorLote[String(ev.lote)] ||= []).push(ev);
          }
          const runningLote = (actual && String(actual.en_marcha) === '1') ? String(actual.lote) : null;
          const ahora = Date.now();
          for (const row of lista) {
            const evs = eventosPorLote[String(row.lote)] || [];
            const enCurso = String(row.lote) === runningLote;
            const cierre = enCurso ? ahora : (row.last_ms != null ? Number(row.last_ms) : null);
            const tramos = tramosActivos(evs, cierre);
            if (enCurso) {
              row.kwh = energiaTramos(tramos).kwh;                 // en curso → tramos hasta ahora
            } else {
              const firma = row.last_ms != null ? Number(row.last_ms) : null;
              row.kwh = tramos.length ? energiaLoteActivaGuardada(Number(row.lote), tramos, firma) : null;
            }
          }
          if (actual) {
            const evs = eventosPorLote[String(actual.lote)] || [];
            actual.kwh = evs.length ? energiaTramos(tramosActivos(evs, ahora)).kwh : null;
          }
          json(res, 200, { ok: true, serverNow, actual, lista });
        } catch (e) {
          json(res, 200, { ok: false, error: e.message });
        } finally { cli.close(); }
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
