#!/usr/bin/env node
/*
 * Escanea direcciones de registro válidas en un esclavo Modbus (vía gateway TCP).
 * Lee 1 registro por dirección; reporta las que devuelven dato (no excepción 0x02).
 * Uso: node modbus-regscan.js [--unit N] [--fn 3|4] [--from N] [--to N]
 */
const net = require('net');
const a = process.argv.slice(2);
const arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
const HOST = arg('host', '192.168.0.168'), PORT = parseInt(arg('port', '8887'), 10);
const UNIT = parseInt(arg('unit', '2'), 10), FN = parseInt(arg('fn', '3'), 10);
const FROM = parseInt(arg('from', '0'), 10), TO = parseInt(arg('to', '999'), 10);

let tid = 0;
function read1(addr) {
  return new Promise((resolve) => {
    tid = (tid + 1) & 0xffff;
    const f = Buffer.alloc(12);
    f.writeUInt16BE(tid, 0); f.writeUInt16BE(0, 2); f.writeUInt16BE(6, 4);
    f.writeUInt8(UNIT, 6); f.writeUInt8(FN, 7); f.writeUInt16BE(addr, 8); f.writeUInt16BE(1, 10);
    const sock = new net.Socket(); let buf = Buffer.alloc(0);
    const done = (r) => { try { sock.destroy(); } catch (_) {} resolve(r); };
    const t = setTimeout(() => done({ st: 'timeout' }), 1500);
    sock.on('error', () => { clearTimeout(t); done({ st: 'err' }); });
    sock.connect(PORT, HOST, () => sock.write(f));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9) return;
      clearTimeout(t);
      const fn = buf.readUInt8(7);
      if (fn & 0x80) return done({ st: 'exc', code: buf.readUInt8(8) });
      done({ st: 'ok', val: buf.length >= 11 ? buf.readUInt16BE(9) : null });
    });
  });
}

(async () => {
  console.log(`Escaneo registros — unit ${UNIT}, fn${FN}, addr ${FROM}..${TO}\n`);
  const ok = [];
  let excCount = 0, lastLog = Date.now();
  for (let addr = FROM; addr <= TO; addr++) {
    const r = await read1(addr);
    if (r.st === 'ok') {
      const s = r.val > 0x7fff ? r.val - 0x10000 : r.val;
      console.log(`  ✔ addr ${addr} (Modbus ${FN === 4 ? 30001 + addr : 40001 + addr}) = ${r.val}  0x${r.val.toString(16).padStart(4, '0')}  int16:${s}`);
      ok.push(addr);
    } else if (r.st === 'exc') { excCount++; }
    else { /* timeout/err: pausa breve */ await new Promise((z) => setTimeout(z, 50)); }
    if (Date.now() - lastLog > 4000) { console.log(`  ...addr ${addr} (válidos hasta ahora: ${ok.length})`); lastLog = Date.now(); }
  }
  console.log(`\nHecho. Registros válidos: ${ok.length}. Excepciones 0x02: ${excCount}.`);
  if (ok.length) console.log('Direcciones válidas:', ok.join(', '));
})();
