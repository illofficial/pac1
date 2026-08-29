const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 80;
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};

const STATIC = path.join(__dirname);

const INVIDIOUS = [
  'invidious.fdn.fr',
  'vid.puffyan.us',
  'inv.nadeko.net',
  'yt.artemislena.eu',
  'invidious.perennialte.ch',
];

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const ct = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': data.length });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function proxyStream(req, res, host, targetPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: host, port: 443, path: targetPath, method: 'GET',
      headers: { host },
      timeout: 15000,
    };
    const proxy = https.request(opts, (pres) => {
      if (pres.statusCode >= 400) {
        pres.resume();
        return reject(new Error('HTTP ' + pres.statusCode));
      }
      const chunks = [];
      pres.on('data', c => chunks.push(c));
      pres.on('end', () => resolve(Buffer.concat(chunks)));
    });
    proxy.on('error', reject);
    proxy.on('timeout', () => { proxy.destroy(); reject(new Error('timeout')); });
    req.pipe(proxy);
  });
}

async function proxyYt(req, res, targetPath) {
  for (const host of INVIDIOUS) {
    try {
      console.log('Trying', host, targetPath.slice(0, 60));
      const buf = await proxyStream(req, res, host, targetPath);
      const ct = targetPath.includes('/api/v1/videos/') ? 'application/json' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': buf.length });
      res.end(buf);
      return;
    } catch (e) {
      console.log('  failed:', host, e.message);
    }
  }
  res.writeHead(502);
  res.end('All Invidious instances unreachable');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/yt/')) {
    const targetPath = url.pathname.replace('/api/yt', '') + url.search;
    return proxyYt(req, res, targetPath);
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  let filePath = path.join(STATIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!path.extname(filePath)) filePath = path.join(STATIC, 'index.html');
  serveFile(res, filePath);
});

server.listen(PORT, () => console.log('PAC1 on port ' + PORT));