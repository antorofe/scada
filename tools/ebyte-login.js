#!/usr/bin/env node
/* Login en conversor EBYTE y volcado de la config. Uso: node ebyte-login.js [user] [pass] */
const net = require('net');
const crypto = require('crypto');

const HOST = '192.168.0.168';
const USER = process.argv[2] || 'admin';
const PASS = process.argv[3] || 'admin';

// HTTP crudo sobre socket: capta la respuesta aunque el servidor haga RST tras enviarla.
function req(method, path, body, headers) {
  return new Promise((resolve) => {
    const h = Object.assign({ Host: HOST, Connection: 'close' }, headers || {});
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);
    let raw = method + ' ' + path + ' HTTP/1.1\r\n';
    for (const k in h) raw += k + ': ' + h[k] + '\r\n';
    raw += '\r\n' + (body != null ? body : '');

    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    const finish = (err) => {
      const text = buf.toString('utf8');
      const idx = text.indexOf('\r\n\r\n');
      const statusLine = text.split('\r\n', 1)[0] || '';
      const status = parseInt((statusLine.match(/HTTP\/\d\.\d\s+(\d+)/) || [])[1] || '0', 10);
      resolve({ status, body: idx >= 0 ? text.slice(idx + 4) : '', head: idx >= 0 ? text.slice(0, idx) : text, err });
    };
    sock.setTimeout(6000, () => { sock.destroy(); finish('timeout'); });
    sock.connect(80, HOST, () => sock.write(raw));
    sock.on('data', (d) => (buf = Buffer.concat([buf, d])));
    sock.on('close', () => finish(null));
    sock.on('error', (e) => { if (buf.length) finish(e.code); });
  });
}

(async () => {
  const lj = await req('GET', '/login.json?' + Date.now());
  const m = lj.body.match(/RAND_KEY\s*=\s*'([^']+)'/);
  if (!m) return console.error('No RAND_KEY:', lj.body);
  const RAND_KEY = m[1];
  const hash = crypto.createHmac('sha1', PASS).update(USER + RAND_KEY).digest('hex');
  console.log(`RAND_KEY=${RAND_KEY}  user=${USER}  hmac=${hash}`);

  const ls = await req('POST', '/loginsubmit', hash, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(hash) });
  console.log(`loginsubmit -> status=${ls.status}${ls.err ? ' err=' + ls.err : ''}  token="${ls.body}"`);
  if (ls.status !== 200) return console.error('Login fallido con ' + USER + '/' + PASS);
  const token = ls.body;

  // Probar endpoints de configuración conocidos de EBYTE, pasando el token de varias formas
  const paths = ['/paraconfig.html', '/para.json', '/paraconfig.json', '/config.json',
                 '/serial.json', '/net.json', '/status.json', '/info.json', '/data.json'];
  for (const p of paths) {
    const url = p + '?' + token;
    const res = await req('GET', url, null, { Cookie: 'ebyte_token=' + token, Authorization: token });
    const tag = `${res.status} len=${res.body.length}`;
    console.log(`\n=== GET ${p} [${tag}] ===`);
    if (res.status === 200 && res.body.length) console.log(res.body.slice(0, 2500));
  }
})();
