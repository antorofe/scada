#!/usr/bin/env node
/*
 * Cliente Modbus TCP de diagnóstico (sin dependencias).
 * Lee registros de un esclavo RTU a través de un conversor Modbus RTU->TCP.
 *
 * Uso:
 *   node modbus-read.js [--host IP] [--port N] [--unit N] [--fn 3|4|1|2]
 *                       [--addr N] [--count N] [--interval ms] [--mode tcp|rtu]
 *
 *   --mode tcp : Modbus TCP con cabecera MBAP (gateway que traduce)
 *   --mode rtu : Modbus RTU crudo (dirección+PDU+CRC16) tunelado sobre TCP
 *                (conversores transparentes serie<->Ethernet)
 *
 * Ejemplos:
 *   node modbus-read.js                          // holding regs 0..9 del unit 2
 *   node modbus-read.js --fn 4 --addr 0 --count 20
 *   node modbus-read.js --interval 1000          // sondeo continuo cada 1s
 */

const net = require('net');

// ---- Parseo de argumentos ----
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}

const HOST     = arg('host', '192.168.0.168');
const PORT     = parseInt(arg('port', '8887'), 10);
const UNIT     = parseInt(arg('unit', '2'), 10);   // Unit ID / dirección esclavo RTU
const FN       = parseInt(arg('fn', '3'), 10);     // 3=holding,4=input,1=coils,2=discrete
const ADDR     = parseInt(arg('addr', '0'), 10);   // dirección inicial (0-based)
const COUNT    = parseInt(arg('count', '10'), 10); // nº de registros/bits
const INTERVAL = arg('interval', null) ? parseInt(arg('interval'), 10) : null;
const MODE     = arg('mode', 'tcp'); // 'tcp' (MBAP) o 'rtu' (RTU crudo sobre TCP)

const FN_NAME = { 1: 'Read Coils', 2: 'Read Discrete Inputs', 3: 'Read Holding Registers', 4: 'Read Input Registers' };

let txid = 0;
function nextTid() { txid = (txid + 1) & 0xffff; return txid; }

// CRC16 Modbus (poly 0xA001)
function crc16(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      if (crc & 1) crc = (crc >> 1) ^ 0xa001;
      else crc >>= 1;
    }
  }
  return crc; // low byte first al serializar
}

// Construye una petición Modbus TCP (MBAP + PDU) para funciones de lectura
function buildRequest(unit, fn, addr, count) {
  const tid = nextTid();
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(fn, 0);
  pdu.writeUInt16BE(addr, 1);
  pdu.writeUInt16BE(count, 3);

  const mbap = Buffer.alloc(7);
  mbap.writeUInt16BE(tid, 0);   // Transaction ID
  mbap.writeUInt16BE(0, 2);     // Protocol ID = 0
  mbap.writeUInt16BE(pdu.length + 1, 4); // Length (unit + pdu)
  mbap.writeUInt8(unit, 6);     // Unit ID

  return { tid, frame: Buffer.concat([mbap, pdu]) };
}

// Construye una trama Modbus RTU cruda (unit + PDU + CRC16) para tunelar sobre TCP
function buildRtuRequest(unit, fn, addr, count) {
  const body = Buffer.alloc(6);
  body.writeUInt8(unit, 0);
  body.writeUInt8(fn, 1);
  body.writeUInt16BE(addr, 2);
  body.writeUInt16BE(count, 4);
  const crc = crc16(body);
  const tail = Buffer.alloc(2);
  tail.writeUInt16LE(crc, 0);
  return { frame: Buffer.concat([body, tail]) };
}

function parseRtuResponse(buf) {
  if (buf.length < 5) throw new Error('Respuesta RTU demasiado corta');
  const fn = buf.readUInt8(1);
  if (fn & 0x80) {
    const code = buf.readUInt8(2);
    throw new Error(`Excepción Modbus 0x${code.toString(16)}: ${MODBUS_ERRORS[code] || 'desconocida'}`);
  }
  const byteCount = buf.readUInt8(2);
  const data = buf.slice(3, 3 + byteCount);
  if (fn === 3 || fn === 4) {
    const regs = [];
    for (let i = 0; i + 1 < data.length; i += 2) regs.push(data.readUInt16BE(i));
    return { type: 'regs', regs };
  } else {
    const bits = [];
    for (let i = 0; i < byteCount; i++) for (let b = 0; b < 8; b++) bits.push((data[i] >> b) & 1);
    return { type: 'bits', bits: bits.slice(0, COUNT) };
  }
}

const MODBUS_ERRORS = {
  1: 'Illegal Function (función no soportada por el esclavo)',
  2: 'Illegal Data Address (dirección de registro inexistente)',
  3: 'Illegal Data Value',
  4: 'Slave Device Failure',
  6: 'Slave Device Busy',
  11: 'Gateway Target Device Failed to Respond (el conversor no obtuvo respuesta del RTU)',
};

function parseResponse(buf) {
  if (buf.length < 9) throw new Error('Respuesta demasiado corta');
  const fn = buf.readUInt8(7);
  if (fn & 0x80) {
    const code = buf.readUInt8(8);
    throw new Error(`Excepción Modbus 0x${code.toString(16)}: ${MODBUS_ERRORS[code] || 'desconocida'}`);
  }
  const byteCount = buf.readUInt8(8);
  const data = buf.slice(9, 9 + byteCount);
  if (fn === 3 || fn === 4) {
    const regs = [];
    for (let i = 0; i + 1 < data.length; i += 2) regs.push(data.readUInt16BE(i));
    return { type: 'regs', regs };
  } else {
    const bits = [];
    for (let i = 0; i < byteCount; i++) {
      for (let b = 0; b < 8; b++) bits.push((data[i] >> b) & 1);
    }
    return { type: 'bits', bits: bits.slice(0, COUNT) };
  }
}

function printResult(res) {
  const stamp = new Date().toLocaleTimeString();
  if (res.type === 'regs') {
    console.log(`\n[${stamp}] ${FN_NAME[FN]} — unit ${UNIT}, addr ${ADDR}..${ADDR + COUNT - 1}`);
    res.regs.forEach((v, i) => {
      const a = ADDR + i;
      const hex = '0x' + v.toString(16).padStart(4, '0');
      const signed = v > 0x7fff ? v - 0x10000 : v;
      console.log(`  [${String(a).padStart(5)}]  ${String(v).padStart(6)}  ${hex}  (int16: ${signed})`);
    });
  } else {
    console.log(`\n[${stamp}] ${FN_NAME[FN]} — unit ${UNIT}, addr ${ADDR}..${ADDR + COUNT - 1}`);
    res.bits.forEach((v, i) => console.log(`  [${String(ADDR + i).padStart(5)}]  ${v}`));
  }
}

function pollOnce() {
  return new Promise((resolve, reject) => {
    const req = MODE === 'rtu' ? buildRtuRequest(UNIT, FN, ADDR, COUNT) : buildRequest(UNIT, FN, ADDR, COUNT);
    const sock = new net.Socket();
    let chunks = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Timeout (sin respuesta en 3s)')); }, 3000);

    sock.connect(PORT, HOST, () => sock.write(req.frame));
    sock.on('data', (d) => {
      chunks = Buffer.concat([chunks, d]);
      let need;
      if (MODE === 'rtu') {
        // unit + fn + byteCount + data + crc(2); si es excepción: unit+fn+code+crc = 5
        if (chunks.length >= 2 && (chunks.readUInt8(1) & 0x80)) need = 5;
        else if (chunks.length >= 3) need = 3 + chunks.readUInt8(2) + 2;
        else return;
      } else {
        if (chunks.length < 6) return;
        need = 6 + chunks.readUInt16BE(4);
      }
      if (chunks.length >= need) {
        clearTimeout(timer);
        sock.destroy();
        try { resolve(MODE === 'rtu' ? parseRtuResponse(chunks) : parseResponse(chunks)); }
        catch (e) { reject(e); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

(async () => {
  console.log(`Conectando a ${HOST}:${PORT} [modo ${MODE}] — ${FN_NAME[FN] || 'fn ' + FN}, unit ${UNIT}`);
  do {
    try {
      printResult(await pollOnce());
    } catch (e) {
      console.error(`\n[${new Date().toLocaleTimeString()}] ERROR: ${e.message}`);
    }
    if (INTERVAL) await new Promise((r) => setTimeout(r, INTERVAL));
  } while (INTERVAL);
})();
