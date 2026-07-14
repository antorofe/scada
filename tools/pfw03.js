#!/usr/bin/env node
/*
 * Lector WEG PFW03-M12 vía gateway Modbus TCP (EBYTE).
 * Datos legibles = float32 en pares de registros. Prueba fn4 (input) y fn3 (holding),
 * y decodifica cada float en ambos órdenes de palabra (big-endian y word-swap).
 * Uso: node pfw03.js [--unit N] [--interval ms]
 */
const net = require('net');
const a = process.argv.slice(2);
const arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
const HOST = arg('host', '192.168.0.168'), PORT = parseInt(arg('port', '8887'), 10);
const UNIT = parseInt(arg('unit', '2'), 10);
const INTERVAL = arg('interval', null) ? parseInt(arg('interval'), 10) : null;

// Mapa "Datos Legibles" PFW03-M12. Tipo: 'f' = float32, 't' = Unix time (uint32).
// [dirección del par, etiqueta, unidad, tipo]
const MAP = [
  [0, 'V   (Tensión)', 'V', 'f'], [2, 'I   (Corriente)', 'A', 'f'], [4, 'P   (Pot. activa)', 'W', 'f'],
  [6, 'Q   (Pot. reactiva)', 'VAr', 'f'], [8, 'S   (Pot. aparente)', 'VA', 'f'], [10, 'Cosφ', '', 'f'],
  [12, 'FP  (Factor pot.)', '', 'f'], [14, 'F   (Frecuencia)', 'Hz', 'f'], [16, 'THDV', '%', 'f'], [18, 'THDI', '%', 'f'],
];

// Sección "Energía" (R/W). Tipo 'i' = entero 32 bits, 'f' = float32.
const ENERGY = [
  [2008, 'Inicio del día', 'h', 'i'], [2010, 'Inicio del mes', 'día', 'i'],
  [2012, 'kWh', 'kWh', 'f'], [2014, 'kWh E.', 'kWh', 'f'],
  [2016, 'kVArh I.', 'kVArh', 'f'], [2018, 'kVArh C.', 'kVArh', 'f'],
];

let tid = 0;
function readBlock(fn, addr, count) {
  return new Promise((resolve) => {
    tid = (tid + 1) & 0xffff;
    const f = Buffer.alloc(12);
    f.writeUInt16BE(tid, 0); f.writeUInt16BE(0, 2); f.writeUInt16BE(6, 4);
    f.writeUInt8(UNIT, 6); f.writeUInt8(fn, 7); f.writeUInt16BE(addr, 8); f.writeUInt16BE(count, 10);
    const sock = new net.Socket(); let buf = Buffer.alloc(0);
    const done = (r) => { try { sock.destroy(); } catch (_) {} resolve(r); };
    const t = setTimeout(() => done({ st: 'timeout' }), 2500);
    sock.on('error', () => { clearTimeout(t); done({ st: 'err' }); });
    sock.connect(PORT, HOST, () => sock.write(f));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 9) return;
      const rfn = buf.readUInt8(7);
      if (rfn & 0x80) { clearTimeout(t); return done({ st: 'exc', code: buf.readUInt8(8) }); }
      const bc = buf.readUInt8(8);
      if (buf.length < 9 + bc) return;
      clearTimeout(t);
      const regs = [];
      for (let i = 0; i < bc; i += 2) regs.push(buf.readUInt16BE(9 + i));
      done({ st: 'ok', regs });
    });
  });
}

function f32(r0, r1, swap) {
  const b = Buffer.alloc(4);
  if (swap) { b.writeUInt16BE(r1, 0); b.writeUInt16BE(r0, 2); }
  else { b.writeUInt16BE(r0, 0); b.writeUInt16BE(r1, 2); }
  return b.readFloatBE(0);
}
function u32(r0, r1) {
  const b = Buffer.alloc(4); b.writeUInt16BE(r0, 0); b.writeUInt16BE(r1, 2);
  return b.readUInt32BE(0);
}
// Decodifica e imprime una fila del mapa a partir de un bloque leído desde `base`.
function row(regs, base, entry) {
  const [addr, label, unit, type] = entry;
  const i = addr - base;
  if (type === 't') {
    const ts = u32(regs[i], regs[i + 1]);
    const s = ts === 0 ? '(sin dato)' : new Date(ts * 1000).toLocaleString();
    console.log(`  ${label.padEnd(22)} ${String(s).padStart(20)}`);
  } else if (type === 'i') {
    console.log(`  ${label.padEnd(22)} ${String(u32(regs[i], regs[i + 1])).padStart(12)} ${unit}`);
  } else {
    const v = f32(regs[i], regs[i + 1], false);
    const val = Number.isFinite(v) ? v.toFixed(3) : String(v);
    console.log(`  ${label.padEnd(22)} ${val.padStart(12)} ${unit}`);
  }
}

async function detect() {
  for (const fn of [3, 4]) {
    const r = await readBlock(fn, 0, 20);
    if (r.st === 'ok') return { fn, regs: r.regs };
    console.log(`  fn${fn}: ${r.st}${r.code ? ' 0x' + r.code.toString(16) : ''}`);
  }
  return null;
}

async function once(fn) {
  const main = await readBlock(fn, 0, 20);
  if (main.st !== 'ok') { console.log(`  lectura fn${fn}: ${main.st}${main.code ? ' 0x' + main.code.toString(16) : ''}`); return; }
  const ene = await readBlock(fn, 2008, 12); // 2008..2019

  console.log(`\n[${new Date().toLocaleTimeString()}]  WEG PFW03-M12  (unit ${UNIT}, Holding Registers, big-endian)`);
  console.log('  ── Instantáneos ──────────────────────────────');
  for (const e of MAP) row(main.regs, 0, e);
  console.log('  ── Energía ───────────────────────────────────');
  if (ene.st === 'ok') for (const e of ENERGY) row(ene.regs, 2008, e);
  else console.log(`  (bloque 2008: ${ene.st}${ene.code ? ' 0x' + ene.code.toString(16) : ''})`);
}

(async () => {
  console.log(`Conectando PFW03 en ${HOST}:${PORT}, unit ${UNIT}...`);
  const det = await detect();
  if (!det) return console.error('No pude leer el bloque 0..19 en fn3 ni fn4.');
  console.log(`\n>> Espacio de registros detectado: función 0${det.fn} (${det.fn === 4 ? 'Input Registers' : 'Holding Registers'})`);
  do { await once(det.fn); if (INTERVAL) await new Promise((z) => setTimeout(z, INTERVAL)); } while (INTERVAL);
})();
