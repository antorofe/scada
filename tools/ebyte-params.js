#!/usr/bin/env node
/* Login EBYTE + reconstrucción de ALL_para (config actual) desde 3.json..7.json */
const net = require('net'), zlib = require('zlib'), crypto = require('crypto');
const HOST = '192.168.0.168', USER = process.argv[2] || 'admin', PASS = process.argv[3] || 'admin';

function req(method, path, body, headers) {
  return new Promise((resolve) => {
    const h = Object.assign({ Host: HOST, Connection: 'close', 'Accept-Encoding': 'gzip' }, headers || {});
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);
    let raw = method + ' ' + path + ' HTTP/1.1\r\n';
    for (const k in h) raw += k + ': ' + h[k] + '\r\n';
    raw += '\r\n' + (body != null ? body : '');
    const sock = new net.Socket(); let buf = Buffer.alloc(0);
    const finish = () => {
      const sep = buf.indexOf('\r\n\r\n');
      const head = sep >= 0 ? buf.slice(0, sep).toString() : buf.toString();
      let b = sep >= 0 ? buf.slice(sep + 4) : Buffer.alloc(0);
      if (/chunked/i.test(head)) { let o = Buffer.alloc(0), i = 0; while (i < b.length) { const j = b.indexOf('\r\n', i); if (j < 0) break; const s = parseInt(b.slice(i, j).toString(), 16); if (!s) break; o = Buffer.concat([o, b.slice(j + 2, j + 2 + s)]); i = j + 2 + s + 2; } b = o; }
      if (b[0] === 0x1f && b[1] === 0x8b) { try { b = zlib.gunzipSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (e) {} }
      const status = parseInt((head.match(/HTTP\/\d\.\d\s+(\d+)/) || [])[1] || '0', 10);
      resolve({ status, body: b.toString('utf8') });
    };
    sock.setTimeout(6000, () => { sock.destroy(); finish(); });
    sock.connect(80, HOST, () => sock.write(raw));
    sock.on('data', (d) => (buf = Buffer.concat([buf, d])));
    sock.on('close', finish);
    sock.on('error', () => { if (buf.length) finish(); });
  });
}

(async () => {
  const lj = await req('GET', '/login.json?' + Date.now());
  const RK = (lj.body.match(/RAND_KEY\s*=\s*'([^']+)'/) || [])[1];
  const hash = crypto.createHmac('sha1', PASS).update(USER + RK).digest('hex');
  const ls = await req('POST', '/loginsubmit', hash, { 'Content-Type': 'text/plain' });
  const token = ls.body; if (ls.status !== 200) return console.error('login fail');

  let concat = '';
  for (const f of ['3.json', '4.json', '5.json', '6.json', '7.json']) {
    const r = await req('GET', '/' + f + '?' + token, null, { Cookie: 'ebyte_token=' + token });
    // cada fichero hace: datN='...'; extraemos el string entre comillas
    const m = r.body.match(/=\s*'([\s\S]*)'\s*;?\s*$/) || r.body.match(/=\s*"([\s\S]*)"\s*;?\s*$/);
    process.stdout.write(`[${f} ${r.status} ${r.body.length}b] `);
    concat += m ? m[1] : '';
  }
  console.log('\n\n--- RAW concat ---\n' + concat + '\n');
  let obj; try { obj = JSON.parse(concat); } catch (e) { return console.error('JSON parse err:', e.message); }
  require('fs').writeFileSync('c:/Programas Claude/Segra/ALL_para.json', JSON.stringify(obj, null, 2));
  console.log('--- ALL_para (config actual) ---');
  for (const k of Object.keys(obj)) console.log(`  ${k} = ${JSON.stringify(obj[k])}`);
})();
