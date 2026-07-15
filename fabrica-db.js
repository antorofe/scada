#!/usr/bin/env node
/*
 * Cliente MySQL/MariaDB mínimo, en JavaScript puro y SIN dependencias.
 * Habla el protocolo clásico (Protocol 41) con autenticación
 * `mysql_native_password` usando solo `net` y `node:crypto`.
 *
 * Pensado como fuente de datos de solo-lectura para el SCADA SEGRA: conecta a la
 * base de producción MariaDB (segra / segra_fabrica) y ejecuta consultas SELECT.
 *
 * NO es un driver completo: cubre lo que el panel necesita (COM_QUERY con
 * resultados de texto). Suficiente para leer datos; no soporta prepared
 * statements binarios, TLS ni compresión.
 *
 * Config: se lee de db.config.json (no versionado) o de variables de entorno
 * FABRICA_DB_HOST/PORT/USER/PASS. Ver loadDbConfig().
 *
 * Uso como módulo:
 *   const { queryOnce, loadDbConfig } = require('./fabrica-db');
 *   const rows = await queryOnce('SELECT NOW() AS ahora');
 *
 * Uso como CLI (autotest):
 *   node fabrica-db.js --test
 *   node fabrica-db.js --sql "SELECT COUNT(*) n FROM segra_fabrica.data_pelleteras"
 */
'use strict';
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const pathm = require('path');

// ---- Capacidades del cliente (bitmask de 32 bits) ----
const CAP = {
  LONG_PASSWORD: 0x00000001,
  FOUND_ROWS: 0x00000002,
  LONG_FLAG: 0x00000004,
  CONNECT_WITH_DB: 0x00000008,
  PROTOCOL_41: 0x00000200,
  SECURE_CONNECTION: 0x00008000,
  PLUGIN_AUTH: 0x00080000,
  DEPRECATE_EOF: 0x01000000,
};
const CLIENT_CAPS =
  CAP.LONG_PASSWORD | CAP.LONG_FLAG | CAP.PROTOCOL_41 |
  CAP.SECURE_CONNECTION | CAP.PLUGIN_AUTH | CAP.DEPRECATE_EOF;

// ---- Configuración ----
const CONFIG_PATH = pathm.join(__dirname, 'db.config.json');
function loadDbConfig() {
  let c = { host: '192.168.0.12', port: 3306, user: 'scada', password: '', database: '' };
  try { c = { ...c, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch (_) {}
  if (process.env.FABRICA_DB_HOST) c.host = process.env.FABRICA_DB_HOST;
  if (process.env.FABRICA_DB_PORT) c.port = parseInt(process.env.FABRICA_DB_PORT, 10);
  if (process.env.FABRICA_DB_USER) c.user = process.env.FABRICA_DB_USER;
  if (process.env.FABRICA_DB_PASS) c.password = process.env.FABRICA_DB_PASS;
  return c;
}

// ---- Helpers de enteros/cadenas con longitud codificada (length-encoded) ----
function readLenEncInt(buf, pos) {
  const first = buf[pos];
  if (first < 0xfb) return [first, pos + 1];
  if (first === 0xfb) return [null, pos + 1];               // NULL
  if (first === 0xfc) return [buf.readUInt16LE(pos + 1), pos + 3];
  if (first === 0xfd) return [buf.readUIntLE(pos + 1, 3), pos + 4];
  // 0xfe → entero de 8 bytes (usamos Number; los tamaños que manejamos caben de sobra)
  return [Number(buf.readBigUInt64LE(pos + 1)), pos + 9];
}
function readLenEncStr(buf, pos) {
  const [len, p] = readLenEncInt(buf, pos);
  if (len === null) return [null, p];                        // NULL
  return [buf.toString('utf8', p, p + len), p + len];
}
function writeLenEncInt(n) {
  if (n < 0xfb) return Buffer.from([n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = 0xfc; b.writeUInt16LE(n, 1); return b; }
  if (n < 0x1000000) { const b = Buffer.alloc(4); b[0] = 0xfd; b.writeUIntLE(n, 1, 3); return b; }
  const b = Buffer.alloc(9); b[0] = 0xfe; b.writeBigUInt64LE(BigInt(n), 1); return b;
}

// ---- Respuesta de autenticación mysql_native_password ----
// token = SHA1(pass) XOR SHA1( seed + SHA1(SHA1(pass)) )
function nativePasswordToken(password, seed) {
  if (!password) return Buffer.alloc(0);
  const sha1 = (b) => crypto.createHash('sha1').update(b).digest();
  const p1 = sha1(Buffer.from(password, 'utf8'));
  const p2 = sha1(p1);
  const h = sha1(Buffer.concat([seed, p2]));
  const out = Buffer.alloc(20);
  for (let i = 0; i < 20; i++) out[i] = p1[i] ^ h[i];
  return out;
}

// ---- Lector de paquetes: framing de 3 bytes (longitud) + 1 byte (secuencia) ----
// Acumula lo que llega por el socket y entrega paquetes completos a quien espera.
class PacketReader {
  constructor(socket) {
    this.buf = Buffer.alloc(0);
    this.waiters = [];   // colas de resolvers esperando un paquete
    this.error = null;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
    socket.on('error', (e) => this._fail(e));
    socket.on('close', () => this._fail(new Error('conexión cerrada')));
  }
  _drain() {
    while (this.waiters.length) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUIntLE(0, 3);
      const seq = this.buf[3];
      if (this.buf.length < 4 + len) return;
      const payload = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      const w = this.waiters.shift();
      w.resolve({ seq, payload });
    }
  }
  _fail(e) {
    this.error = e;
    while (this.waiters.length) this.waiters.shift().reject(e);
  }
  next() {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this._drain(); });
  }
}

function writePacket(socket, seq, payload) {
  const head = Buffer.alloc(4);
  head.writeUIntLE(payload.length, 0, 3);
  head[3] = seq & 0xff;
  socket.write(Buffer.concat([head, payload]));
}

// Interpreta un paquete de error del servidor (primer byte 0xff).
function parseErr(payload) {
  const code = payload.readUInt16LE(1);
  let pos = 3;
  if (payload[3] === 0x23) pos = 9;   // '#' + SQLSTATE de 5 bytes (marcador de estado)
  const msg = payload.toString('utf8', pos);
  return new Error(`MySQL error ${code}: ${msg}`);
}

// ---- Cliente ----
class MySQLClient {
  constructor(cfg) { this.cfg = cfg; this.socket = null; this.reader = null; }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.cfg.host, port: this.cfg.port || 3306 });
      // El timeout de inactividad se usa SOLO para conectar + autenticar. Tras el
      // handshake se desactiva: una consulta pesada (p. ej. COUNT sobre millones de
      // filas) puede tardar más y no debe cerrar la conexión por "inactividad".
      const onTimeout = () => { sock.destroy(); reject(new Error('timeout de conexión')); };
      sock.setTimeout(this.cfg.connectTimeout || 8000);
      sock.once('timeout', onTimeout);
      sock.once('error', reject);
      sock.once('connect', async () => {
        sock.removeListener('error', reject);
        this.socket = sock;
        this.reader = new PacketReader(sock);
        try {
          await this._handshake();
          sock.removeListener('timeout', onTimeout);
          sock.setTimeout(0);                       // sin timeout de inactividad tras autenticar
          resolve(this);
        } catch (e) { try { sock.destroy(); } catch (_) {} reject(e); }
      });
    });
  }

  async _handshake() {
    // 1) Paquete inicial del servidor (Handshake v10)
    const { payload } = await this.reader.next();
    if (payload[0] === 0xff) throw parseErr(payload);
    let pos = 1;
    while (payload[pos] !== 0x00) pos++;              // server version (cadena NUL-terminada)
    pos++;
    pos += 4;                                          // thread id
    const seed1 = payload.subarray(pos, pos + 8); pos += 8;
    pos += 1;                                          // filler
    pos += 2;                                          // capability lower
    pos += 1;                                          // charset
    pos += 2;                                          // status
    pos += 2;                                          // capability upper
    const authLen = payload[pos]; pos += 1;            // longitud de auth-plugin-data
    pos += 10;                                         // reservado
    const restLen = Math.max(13, authLen - 8);
    const seed2 = payload.subarray(pos, pos + restLen - 1); // se descarta el NUL final
    const seed = Buffer.concat([seed1, seed2]);        // scramble de 20 bytes

    // 2) Respuesta de handshake (Protocol 41)
    const token = nativePasswordToken(this.cfg.password, seed);
    const user = Buffer.from(this.cfg.user, 'utf8');
    const db = this.cfg.database ? Buffer.from(this.cfg.database, 'utf8') : null;
    let caps = CLIENT_CAPS;
    if (db) caps |= CAP.CONNECT_WITH_DB;

    const parts = [];
    const head = Buffer.alloc(32);
    head.writeUInt32LE(caps, 0);
    head.writeUInt32LE(0x01000000, 4);                 // max packet = 16 MB
    head[8] = 0x21;                                     // charset utf8_general_ci
    parts.push(head);                                  // 23 bytes reservados ya en cero
    parts.push(user, Buffer.from([0]));
    parts.push(Buffer.from([token.length]), token);    // SECURE_CONNECTION: 1 byte de longitud
    if (db) parts.push(db, Buffer.from([0]));
    parts.push(Buffer.from('mysql_native_password\0', 'utf8'));
    writePacket(this.socket, 1, Buffer.concat(parts));

    // 3) Resultado de la autenticación
    const res = await this.reader.next();
    const p = res.payload;
    if (p[0] === 0x00) return;                          // OK
    if (p[0] === 0xff) throw parseErr(p);
    if (p[0] === 0xfe) throw new Error('el servidor pidió cambiar de plugin de auth (no soportado)');
    throw new Error('respuesta de auth inesperada: 0x' + p[0].toString(16));
  }

  // Ejecuta una consulta de texto (COM_QUERY) y devuelve { columns, rows }.
  // rows: array de objetos { columna: valor(string|null) }.
  async query(sql) {
    if (!this.socket) throw new Error('no conectado');
    writePacket(this.socket, 0, Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, 'utf8')]));
    const first = (await this.reader.next()).payload;
    if (first[0] === 0xff) throw parseErr(first);
    if (first[0] === 0x00 || first[0] === 0xfe) return { columns: [], rows: [] }; // OK sin resultados
    if (first[0] === 0xfb) throw new Error('LOCAL INFILE no soportado');

    const [colCount] = readLenEncInt(first, 0);
    const columns = [];
    for (let i = 0; i < colCount; i++) {
      const cp = (await this.reader.next()).payload;
      // catalog, schema, table, org_table, name, org_name (cadenas len-enc); solo usamos 'name'
      let p = 0, s;
      for (let k = 0; k < 4; k++) { [s, p] = readLenEncStr(cp, p); }
      [s, p] = readLenEncStr(cp, p);
      columns.push(s);
    }
    // Con DEPRECATE_EOF no hay paquete EOF tras las columnas: van directo las filas.
    const rows = [];
    while (true) {
      const rp = (await this.reader.next()).payload;
      if (rp[0] === 0xfe && rp.length < 9) break;       // OK/EOF final del conjunto
      if (rp[0] === 0xff) throw parseErr(rp);
      const row = {};
      let p = 0, val;
      for (let i = 0; i < colCount; i++) { [val, p] = readLenEncStr(rp, p); row[columns[i]] = val; }
      rows.push(row);
    }
    return { columns, rows };
  }

  close() {
    try { writePacket(this.socket, 0, Buffer.from([0x01])); } catch (_) {}  // COM_QUIT
    try { this.socket.destroy(); } catch (_) {}
    this.socket = null;
  }
}

// Conecta, ejecuta UNA consulta y cierra. Cómodo para endpoints puntuales.
async function queryOnce(sql, cfgOverride) {
  const cfg = { ...loadDbConfig(), ...(cfgOverride || {}) };
  const cli = new MySQLClient(cfg);
  await cli.connect();
  try { return (await cli.query(sql)).rows; }
  finally { cli.close(); }
}

module.exports = { MySQLClient, queryOnce, loadDbConfig };

// ---- CLI de autotest ----
if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  (async () => {
    try {
      if (a.includes('--sql')) {
        const rows = await queryOnce(arg('sql'));
        console.log(JSON.stringify(rows, null, 2));
      } else {
        const cfg = loadDbConfig();
        console.log(`Conectando a ${cfg.user}@${cfg.host}:${cfg.port || 3306} …`);
        const t0 = Date.now();
        const info = await queryOnce('SELECT CURRENT_USER() AS usuario, VERSION() AS version, NOW() AS ahora');
        console.log('OK  (', Date.now() - t0, 'ms )');
        console.log('  ', info[0]);
        const last = await queryOnce(
          'SELECT fechahora, tipo, subtipo, valor FROM segra_fabrica.data_pelleteras ORDER BY id DESC LIMIT 3'
        );
        console.log('  Últimas muestras de data_pelleteras:');
        for (const r of last) console.log('   ', r.fechahora, r.tipo, r.subtipo, '=', r.valor);
      }
      process.exit(0);
    } catch (e) {
      console.error('FALLO:', e.message);
      process.exit(1);
    }
  })();
}
