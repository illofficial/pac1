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

function proxyRequest(req, res, targetHost, targetPath) {
  const opts = {
    hostname: targetHost, port: 443, path: targetPath, method: req.method,
    headers: { ...req.headers, host: targetHost },
    timeout: 30000,
  };
  const proxy = https.request(opts, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  proxy.on('error', (e) => {
    res.writeHead(502);
    res.end('Proxy error: ' + e.message);
  });
  proxy.on('timeout', () => { proxy.destroy(); res.writeHead(504); res.end('Timeout'); });
  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/yt/')) {
    const targetPath = url.pathname.replace('/api/yt', '') + url.search;
    return proxyRequest(req, res, 'invidious.fdn.fr', targetPath);
  }
  if (url.pathname.startsWith('/api/yt2/')) {
    const targetPath = url.pathname.replace('/api/yt2', '') + url.search;
    return proxyRequest(req, res, 'vid.puffyan.us', targetPath);
  }

  let filePath = path.join(STATIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!path.extname(filePath)) filePath = path.join(STATIC, 'index.html');
  serveFile(res, filePath);
});

server.listen(PORT, () => console.log('PAC1 on port ' + PORT));