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

const STATIC = __dirname;

const INVIDIOUS = [
  { host: 'invidious.fdn.fr', port: 443 },
  { host: 'inv.nadeko.net', port: 443 },
  { host: 'invidious.perennialte.ch', port: 443 },
  { host: 'vid.puffyan.us', port: 443 },
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

function fetchHttps(host, port, targetPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: host, port, path: targetPath, method: 'GET',
      headers: { host, 'User-Agent': 'PAC1/1.0', 'Accept': '*/*' },
      timeout: 12000,
      rejectUnauthorized: false,
    };
    const req = https.request(opts, (pres) => {
      const chunks = [];
      pres.on('data', c => chunks.push(c));
      pres.on('end', () => {
        const body = Buffer.concat(chunks);
        if (pres.statusCode >= 400) return reject(new Error('HTTP ' + pres.statusCode));
        resolve({ statusCode: pres.statusCode, headers: pres.headers, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function proxyYt(res, targetPath) {
  for (const inst of INVIDIOUS) {
    try {
      console.log('Trying', inst.host, targetPath.slice(0, 60));
      const result = await fetchHttps(inst.host, inst.port, targetPath);
      const isJson = targetPath.includes('/api/v1/videos/');
      const ct = isJson ? 'application/json' : result.headers['content-type'] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct, 'Content-Length': result.body.length });
      res.end(result.body);
      return;
    } catch (e) {
      console.log('  failed:', inst.host, e.message);
    }
  }
  res.writeHead(502);
  res.end('All Invidious instances unreachable');
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/yt/')) {
    const targetPath = url.pathname.replace('/api/yt', '') + url.search;
    return proxyYt(res, targetPath);
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200);
    return res.end('ok');
  }

  let filePath = path.join(STATIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!path.extname(filePath)) filePath = path.join(STATIC, 'index.html');
  serveFile(res, filePath);
}).listen(PORT, () => console.log('PAC1 on port ' + PORT));