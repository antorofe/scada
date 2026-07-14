#!/usr/bin/env node
/* Login EBYTE + descarga y descompresión (gzip/deflate) de páginas de config. */
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const HOST = '192.168.0.168';
const USER = process.argv[2] || 'admin';
const PASS = process.argv[3] || 'admin';

function req(method, path, body, headers) {
  return new Promise((resolve) => {
    const h = Object.assign({ Host: HOST, Connection: 'close', 'Accept-Encoding': 'gzip, deflate' }, headers || {});
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);
    let raw = method + ' ' + path + ' HTTP/1.1\r\n';
    for (const k in h) raw += k + ': ' + h[k] + '\r\n';
    raw += '\r\n' + (body != null ? body : '');
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    const finish = (err) => {
      const sep = buf.indexOf('\r\n\r\n');
      const head = sep >= 0 ? buf.slice(0, sep).toString('utf8') : buf.toString('utf8');
      let bodyBuf = sep >= 0 ? buf.slice(sep + 4) : Buffer.alloc(0);
      const status = parseInt((head.match(/HTTP\/\d\.\d\s+(\d+)/) || [])[1] || '0', 10);
      const enc = (head.match(/Content-Encoding:\s*(\S+)/i) || [])[1];
      // chunked?
      if (/Transfer-Encoding:\s*chunked/i.test(head)) bodyBuf = dechunk(bodyBuf);
      let out = bodyBuf, dec = enc || 'none';
      const opt = { finishFlush: zlib.constants.Z_SYNC_FLUSH }; // tolera streams truncados por RST
      const isGz = bodyBuf[0] === 0x1f && bodyBuf[1] === 0x8b;
      try {
        if (enc === 'gzip' || isGz) { out = zlib.gunzipSync(bodyBuf, opt); dec = 'gzip'; }
        else if (enc === 'deflate') { out = zlib.inflateSync(bodyBuf, opt); dec = 'deflate'; }
      } catch (e) { dec = (enc || (isGz ? 'gzip' : 'raw')) + '(fail:' + e.code + ')'; }
      resolve({ status, head, enc: dec, body: out, err });
    };
    sock.setTimeout(6000, () => { sock.destroy(); finish('timeout'); });
    sock.connect(80, HOST, () => sock.write(raw));
    sock.on('data', (d) => (buf = Buffer.concat([buf, d])));
    sock.on('close', () => finish(null));
    sock.on('error', (e) => { if (buf.length) finish(e.code); });
  });
}
function dechunk(b) {
  let out = Buffer.alloc(0), i = 0;
  while (i < b.length) {
    let j = b.indexOf('\r\n', i); if (j < 0) break;
    const size = parseInt(b.slice(i, j).toString(), 16); if (!size) break;
    out = Buffer.concat([out, b.slice(j + 2, j + 2 + size)]); i = j + 2 + size + 2;
  }
  return out;
}

(async () => {
  const lj = await req('GET', '/login.json?' + Date.now());
  const RAND_KEY = (lj.body.toString().match(/RAND_KEY\s*=\s*'([^']+)'/) || [])[1];
  const hash = crypto.createHmac('sha1', PASS).update(USER + RAND_KEY).digest('hex');
  const ls = await req('POST', '/loginsubmit', hash, { 'Content-Type': 'text/plain' });
  const token = ls.body.toString();
  console.log(`login status=${ls.status} token="${token}"`);
  if (ls.status !== 200) return;

  const fs = require('fs');
  for (const p of process.argv[4] ? [process.argv[4]] : ['/paraconfig.html', '/paraconfig.js', '/app.js', '/main.js', '/index.js']) {
    const res = await req('GET', p + '?' + token, null, { Cookie: 'ebyte_token=' + token });
    console.log(`\n=== ${p}  status=${res.status} enc=${res.enc} bytes=${res.body.length} ===`);
    const text = res.body.toString('utf8');
    const printable = text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '').length / (text.length || 1);
    if (res.status === 200 && printable > 0.8) {
      console.log(text.slice(0, 4000));
      fs.writeFileSync('c:/Programas Claude/Segra/dump' + p.replace(/[\/.]/g, '_') + '.txt', text);
    } else if (res.status === 200) {
      console.log('(no-texto, printable=' + printable.toFixed(2) + ') primeros bytes hex:', res.body.slice(0, 16).toString('hex'));
    }
  }
})();
