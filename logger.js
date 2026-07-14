#!/usr/bin/env node
/*
 * Logger WEG PFW03-M12 → SQLite. Muestrea cada N ms (por defecto 1000) los
 * bloques Instantáneos (0..19) y Energía (2008..2018) y los guarda en una tabla.
 *
 * Uso:
 *   node logger.js [--host IP] [--port N] [--unit N] [--interval ms] [--db archivo]
 *
 * Requiere Node >= 22 (usa node:sqlite integrado, sin dependencias).
 */
const net = require('net');
const fs = require('fs');
const pathm = require('path');
const { DatabaseSync } = require('node:sqlite');

const a = process.argv.slice(2);
const arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
const FN = 3; // Holding Registers
const INTERVAL = parseInt(arg('interval', '1000'), 10);
const DB_PATH = arg('db', 'pfw03.db');
const KEEP_DAYS = parseInt(arg('keep-days', '10'), 10);   // días a resolución completa (1 s)
const ROLLUP_SEC = parseInt(arg('rollup-sec', '30'), 10); // resolución del histórico comprimido
const CONFIG_PATH = pathm.join(__dirname, 'config.json');

// Conexión del dispositivo: se lee de config.json (editable desde el panel) en cada
// muestra → cambios de IP/puerto/unit aplican en vivo. Args como valores por defecto.
let DEV = { host: arg('host', '192.168.0.168'), port: parseInt(arg('port', '8887'), 10), unit: parseInt(arg('unit', '2'), 10) };
function refreshDevice() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (c.host) DEV.host = c.host;
    if (c.port) DEV.port = parseInt(c.port, 10);
    if (c.unit != null) DEV.unit = parseInt(c.unit, 10);
  } catch (_) { /* mantiene el último válido */ }
}

// ---- Modbus (Modbus TCP / MBAP) ----
let tid = 0;
function readBlock(addr, count) {
  return new Promise((resolve) => {
    tid = (tid + 1) & 0xffff;
    const f = Buffer.alloc(12);
    f.writeUInt16BE(tid, 0); f.writeUInt16BE(0, 2); f.writeUInt16BE(6, 4);
    f.writeUInt8(DEV.unit, 6); f.writeUInt8(FN, 7); f.writeUInt16BE(addr, 8); f.writeUInt16BE(count, 10);
    const sock = new net.Socket(); let buf = Buffer.alloc(0);
    const done = (r) => { try { sock.destroy(); } catch (_) {} resolve(r); };
    const t = setTimeout(() => done({ st: 'timeout' }), 2000);
    sock.on('error', (e) => { clearTimeout(t); done({ st: 'err:' + (e.code || e.message) }); });
    sock.connect(DEV.port, DEV.host, () => sock.write(f));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9) return;
      const rfn = buf.readUInt8(7);
      if (rfn & 0x80) { clearTimeout(t); return done({ st: 'exc:0x' + buf.readUInt8(8).toString(16) }); }
      const bc = buf.readUInt8(8);
      if (buf.length < 9 + bc) return;
      clearTimeout(t);
      const regs = [];
      for (let i = 0; i < bc; i += 2) regs.push(buf.readUInt16BE(9 + i));
      done({ st: 'ok', regs });
    });
  });
}
function f32(r0, r1) { const b = Buffer.alloc(4); b.writeUInt16BE(r0, 0); b.writeUInt16BE(r1, 2); return b.readFloatBE(0); }
function u32(r0, r1) { const b = Buffer.alloc(4); b.writeUInt16BE(r0, 0); b.writeUInt16BE(r1, 2); return b.readUInt32BE(0); }

// ---- Base de datos ----
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`CREATE TABLE IF NOT EXISTS readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_unix_ms  INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  err         TEXT,
  v REAL, i REAL, p REAL, q REAL, s REAL,
  cosphi REAL, fp REAL, freq REAL, thdv REAL, thdi REAL,
  inicio_dia INTEGER, inicio_mes INTEGER,
  kwh REAL, kwh_e REAL, kvarh_i REAL, kvarh_c REAL,
  res INTEGER NOT NULL DEFAULT 1,
  secs REAL NOT NULL DEFAULT 1
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts_unix_ms);');
// Migración: añade columnas nuevas a BD antiguas que no las tengan
{
  const have = db.prepare('PRAGMA table_info(readings)').all().map(c => c.name);
  if (!have.includes('res')) db.exec('ALTER TABLE readings ADD COLUMN res INTEGER NOT NULL DEFAULT 1');
  if (!have.includes('secs')) db.exec('ALTER TABLE readings ADD COLUMN secs REAL NOT NULL DEFAULT 1');
}

const cols = ['ts_unix_ms','ok','err','v','i','p','q','s','cosphi','fp','freq','thdv','thdi','inicio_dia','inicio_mes','kwh','kwh_e','kvarh_i','kvarh_c'];
const insert = db.prepare(`INSERT INTO readings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);

// ---- Ciclo de muestreo ----
let n = 0, errors = 0, lastLog = 0, running = true;

async function sample() {
  const now = new Date();
  refreshDevice(); // aplica IP/puerto/unit actuales (editables desde el panel)
  // Secuencial: el gateway EBYTE en modo "Simple" atiende una transacción a la vez.
  const inst = await readBlock(0, 20);
  const ene = await readBlock(2008, 12);
  const ok = inst.st === 'ok' && ene.st === 'ok';
  const r = ok ? {
    v: f32(inst.regs[0], inst.regs[1]), i: f32(inst.regs[2], inst.regs[3]),
    p: f32(inst.regs[4], inst.regs[5]), q: f32(inst.regs[6], inst.regs[7]),
    s: f32(inst.regs[8], inst.regs[9]), cosphi: f32(inst.regs[10], inst.regs[11]),
    fp: f32(inst.regs[12], inst.regs[13]), freq: f32(inst.regs[14], inst.regs[15]),
    thdv: f32(inst.regs[16], inst.regs[17]), thdi: f32(inst.regs[18], inst.regs[19]),
    inicio_dia: u32(ene.regs[0], ene.regs[1]), inicio_mes: u32(ene.regs[2], ene.regs[3]),
    kwh: f32(ene.regs[4], ene.regs[5]), kwh_e: f32(ene.regs[6], ene.regs[7]),
    kvarh_i: f32(ene.regs[8], ene.regs[9]), kvarh_c: f32(ene.regs[10], ene.regs[11]),
  } : {};
  const err = ok ? null : `inst=${inst.st} ene=${ene.st}`;

  insert.run(now.getTime(), ok ? 1 : 0, err,
    r.v ?? null, r.i ?? null, r.p ?? null, r.q ?? null, r.s ?? null,
    r.cosphi ?? null, r.fp ?? null, r.freq ?? null, r.thdv ?? null, r.thdi ?? null,
    r.inicio_dia ?? null, r.inicio_mes ?? null,
    r.kwh ?? null, r.kwh_e ?? null, r.kvarh_i ?? null, r.kvarh_c ?? null);

  n++; if (!ok) errors++;
  if (Date.now() - lastLog > 5000) {
    lastLog = Date.now();
    if (ok) console.log(`[${now.toLocaleTimeString()}] #${n}  V=${r.v.toFixed(1)} I=${r.i.toFixed(1)} P=${(r.p/1000).toFixed(2)}kW FP=${r.fp.toFixed(3)} F=${r.freq.toFixed(2)}Hz  (errores:${errors})`);
    else console.log(`[${now.toLocaleTimeString()}] #${n}  ERROR: ${err}  (errores:${errors})`);
  }
}

async function loop() {
  while (running) {
    const t0 = Date.now();
    try { await sample(); } catch (e) { console.error('sample err:', e.message); }
    const wait = Math.max(0, INTERVAL - (Date.now() - t0)); // cadencia estable sin deriva
    await new Promise((z) => setTimeout(z, wait));
  }
}

// ---- Mantenimiento: rollup de datos > KEEP_DAYS a ROLLUP_SEC (promedio) ----
// Comprime a 1 dato/ROLLUP_SEC (promediando) y borra el detalle de 1 s. En una
// sola tabla → las consultas no cambian. La energía se conserva (P_prom·Δt = kWh).
const AVG_COLS = ['v', 'i', 'p', 'q', 's', 'cosphi', 'fp', 'freq', 'thdv', 'thdi', 'inicio_dia', 'inicio_mes', 'kwh', 'kwh_e', 'kvarh_i', 'kvarh_c'];
function runMaintenance() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const bucket = ROLLUP_SEC * 1000;
  const pending = db.prepare('SELECT COUNT(*) c FROM readings WHERE res = 1 AND ts_unix_ms < ?').get(cutoff).c;
  if (pending === 0) return;
  const avgSel = AVG_COLS.map(c => `AVG(${c}) AS ${c}`).join(', ');
  try {
    db.exec('BEGIN');
    // 1 fila promedio por balde de ROLLUP_SEC. secs = Σsecs (segundos realmente
    // medidos en el balde) → conserva la energía Σ(P·secs) exactamente.
    db.prepare(
      `INSERT INTO readings (ts_unix_ms, ok, err, ${AVG_COLS.join(', ')}, secs, res)
       SELECT (ts_unix_ms/${bucket})*${bucket} AS bts, 1, NULL, ${avgSel}, SUM(secs), ${ROLLUP_SEC}
       FROM readings WHERE res = 1 AND ts_unix_ms < ? AND ok = 1
       GROUP BY ts_unix_ms/${bucket}`
    ).run(cutoff);
    // borra el detalle de 1 s ya comprimido (incluye filas de error viejas)
    const del = db.prepare('DELETE FROM readings WHERE res = 1 AND ts_unix_ms < ?').run(cutoff);
    db.exec('COMMIT');
    console.log(`[${new Date().toLocaleString()}] Mantenimiento: comprimidas ${del.changes} filas (1 s) → ${ROLLUP_SEC} s. Detalle conservado: ${KEEP_DAYS} días.`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('Mantenimiento falló:', e.message);
  }
}

process.on('SIGINT', () => {
  running = false;
  console.log(`\nDeteniendo… ${n} lecturas guardadas (${errors} errores) en ${DB_PATH}`);
  try { db.close(); } catch (_) {}
  process.exit(0);
});

refreshDevice();
console.log(`Logger PFW03 → SQLite`);
console.log(`  destino : ${DEV.host}:${DEV.port} unit ${DEV.unit} (fn03)`);
console.log(`  cada    : ${INTERVAL} ms`);
console.log(`  base    : ${DB_PATH} (tabla 'readings')`);
console.log(`  retención: 1 s durante ${KEEP_DAYS} días, luego ${ROLLUP_SEC} s (promedio)`);
console.log(`  Ctrl+C para detener.\n`);

// Mantenimiento: al arrancar (tras 10 s) y cada 24 h
setTimeout(runMaintenance, 10000);
setInterval(runMaintenance, 24 * 3600000);

loop();
