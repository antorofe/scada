#!/usr/bin/env node
/*
 * Escáner Modbus: barre Unit IDs en modo TCP (MBAP) y RTU-over-TCP,
 * enviando Read Holding Registers (fn3, addr 0, count 1) a cada uno.
 * Reporta CUALQUIER respuesta, incluidas excepciones (eso ya indica que hay vida).
 *
 * Uso: node modbus-scan.js [--host IP] [--port N] [--from N] [--to N] [--fn 3|4]
 */
const net = require('net');
const a = process.argv.slice(2);
const arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };

const HOST = arg('host', '192.168.0.168');
const PORT = parseInt(arg('port', '8887'), 10);
const FROM = parseInt(arg('from', '1'), 10);
const TO   = parseInt(arg('to', '32'), 10);
const FN   = parseInt(arg('fn', '3'), 10);
const TIMEOUT = 800;

function crc16(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = (crc & 1) ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}
function tcpFrame(unit) {
  const pdu = Buffer.from([FN, 0, 0, 0, 1]);
  const mbap = Buffer.alloc(7);
  mbap.writeUInt16BE(1, 0); mbap.writeUInt16BE(0, 2);
  mbap.writeUInt16BE(pdu.length + 1, 4); mbap.writeUInt8(unit, 6);
  return Buffer.concat([mbap, pdu]);
}
function rtuFrame(unit) {
  const body = Buffer.from([unit, FN, 0, 0, 0, 1]);
  const t = Buffer.alloc(2); t.writeUInt16LE(crc16(body), 0);
  return Buffer.concat([body, t]);
}

function probe(mode, unit) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    const done = (r) => { try { sock.destroy(); } catch (_) {} resolve(r); };
    const timer = setTimeout(() => done(null), TIMEOUT);
    sock.on('error', () => { clearTimeout(timer); done(null); });
    sock.connect(PORT, HOST, () => sock.write(mode === 'rtu' ? rtuFrame(unit) : tcpFrame(unit)));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      clearTimeout(timer);
      // interpretar
      let fn, excCode = null, ok = false;
      if (mode === 'tcp' && buf.length >= 8) { fn = buf.readUInt8(7); if (fn & 0x80 && buf.length >= 9) excCode = buf.readUInt8(8); ok = true; }
      if (mode === 'rtu' && buf.length >= 3) { fn = buf.readUInt8(1); if (fn & 0x80) excCode = buf.readUInt8(2); ok = true; }
      if (ok) done({ mode, unit, exception: excCode, bytes: buf.length });
    });
  });
}

(async () => {
  console.log(`Escaneando ${HOST}:${PORT} — Unit IDs ${FROM}..${TO}, fn${FN}, modos [tcp, rtu]\n`);
  let found = 0;
  for (const mode of ['tcp', 'rtu']) {
    for (let u = FROM; u <= TO; u++) {
      const r = await probe(mode, u);
      if (r) {
        found++;
        const tag = r.exception != null
          ? `EXCEPCIÓN 0x${r.exception.toString(16).padStart(2, '0')} (hay esclavo, pero fn/addr no válida)`
          : `RESPUESTA OK (${r.bytes} bytes)`;
        console.log(`  ✔ [${mode}] Unit ${u}: ${tag}`);
      }
    }
  }
  console.log(found ? `\nHecho: ${found} respuesta(s).` : '\nNinguna respuesta en ningún Unit ID / modo.');
})();
