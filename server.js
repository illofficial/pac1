const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
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

function ytDlpGetUrl(videoId) {
  return new Promise((resolve, reject) => {
    const url = 'https://www.youtube.com/watch?v=' + videoId;
    execFile('yt-dlp', ['-f', 'bestaudio', '-g', '--no-playlist', url], {
      timeout: 20000, maxBuffer: 4096,
    }, (err, stdout) => {
      if (err) return reject(err);
      const line = stdout.trim().split('\n')[0];
      if (!line || !line.startsWith('http')) return reject(new Error('no URL from yt-dlp'));
      resolve(line);
    });
  });
}

function fetchAudio(audioUrl, res) {
  return new Promise((resolve, reject) => {
    const proto = audioUrl.startsWith('https') ? https : http;
    const opts = {
      headers: { 'User-Agent': 'PAC1/1.0', 'Accept': '*/*' },
      timeout: 60000,
    };
    const req = proto.get(audioUrl, opts, (pres) => {
      if (pres.statusCode >= 400) {
        pres.resume();
        return reject(new Error('HTTP ' + pres.statusCode));
      }
      const total = parseInt(pres.headers['content-length'], 10) || 0;
      res.writeHead(200, {
        'Content-Type': pres.headers['content-type'] || 'audio/mp4',
        'Content-Length': total || undefined,
        'X-Audio-Title': encodeURIComponent('youtube_audio'),
      });
      pres.pipe(res);
      pres.on('end', resolve);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function handleYt(videoId, res) {
  try {
    console.log('yt-dlp for', videoId);
    const audioUrl = await ytDlpGetUrl(videoId);
    console.log('  got URL:', audioUrl.slice(0, 80) + '...');
    await fetchAudio(audioUrl, res);
  } catch (e) {
    console.error('yt-dlp failed:', e.message);
    res.writeHead(502);
    res.end('YouTube audio unavailable: ' + e.message);
  }
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