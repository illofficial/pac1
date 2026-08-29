const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 80;
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};

const STATIC = __dirname;

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

function handleYt(videoId, res) {
  const url = 'https://www.youtube.com/watch?v=' + videoId;
  console.log('yt-dlp for', videoId);

  const proc = spawn('yt-dlp', [
    '-f', 'bestaudio',
    '--no-playlist',
    '--no-check-certificates',
    '--socket-timeout', '20',
    '-o', '-',
    url,
  ], { timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });

  res.writeHead(200, {
    'Content-Type': 'audio/mp4',
    'X-Audio-Title': encodeURIComponent('youtube_audio'),
  });

  let first = true;
  proc.stdout.on('data', (chunk) => {
    if (first) { console.log('  streaming audio, first chunk:', chunk.length, 'bytes'); first = false; }
    res.write(chunk);
  });
  proc.stdout.on('end', () => res.end());

  let stderr = '';
  proc.stderr.on('data', (d) => stderr += d);

  proc.on('error', (e) => {
    console.error('yt-dlp spawn error:', e.message);
    if (!res.headersSent) { res.writeHead(502); res.end('yt-dlp error: ' + e.message); }
    else res.end();
  });
  proc.on('close', (code) => {
    if (code !== 0 && !res.headersSent) {
      console.error('yt-dlp exit', code, stderr.slice(0, 300));
      res.writeHead(502);
      res.end('yt-dlp failed: ' + stderr.slice(0, 200));
    }
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/yt/')) {
    const videoId = url.pathname.split('/api/yt/')[1].split('?')[0];
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      res.writeHead(400);
      return res.end('Invalid video ID');
    }
    return handleYt(videoId, res);
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200);
    return res.end('ok');
  }

  let filePath = path.join(STATIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!path.extname(filePath)) filePath = path.join(STATIC, 'index.html');
  serveFile(res, filePath);
}).listen(PORT, () => console.log('PAC1 on port ' + PORT));