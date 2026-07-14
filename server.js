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
