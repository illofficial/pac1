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

  // Базовые аргументы
  const args = [
    '-f', 'bestaudio',
    '--no-playlist',
    '--no-check-certificates',
    '--js-runtime', 'node',
    '-o', '-',
    url,
  ];

  // Если файл cookies.txt существует, добавляем его
  if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
    args.unshift('--cookies', 'cookies.txt');
    console.log('Using cookies.txt');
  }

  const proc = spawn('yt-dlp', args, {
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let headersSent = false;
  let stderr = '';

  // Безопасная отправка заголовков и данных
  const sendHeaders = () => {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'X-Audio-Title': encodeURIComponent('youtube_audio'),
      });
      headersSent = true;
      console.log('Streaming started');
    }
  };

  proc.stdout.on('data', (chunk) => {
    sendHeaders();
    res.write(chunk);
  });

  proc.stdout.on('end', () => {
    if (headersSent) {
      res.end();
    } else {
      // Если данные так и не пришли – ошибка
      console.error('yt-dlp ended without sending any data');
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('yt-dlp failed: no data received');
      }
    }
  });

  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    console.error('yt-dlp stderr:', d.toString());
  });

  proc.on('error', (err) => {
    console.error('yt-dlp spawn error:', err.message);
    if (!headersSent && !res.headersSent) {
      res.writeHead(502);
      res.end('yt-dlp error: ' + err.message);
    } else {
      res.end();
    }
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp exit code', code, 'stderr:', stderr.slice(0, 500));
      if (!headersSent && !res.headersSent) {
        res.writeHead(502);
        res.end('yt-dlp failed: ' + stderr.slice(0, 300));
      } else if (headersSent) {
        res.end();
      }
    } else {
      console.log('yt-dlp finished successfully');
      if (!headersSent && !res.headersSent) {
        // Если процесс завершился успешно, но данных не было – странно, но отправим ошибку
        res.writeHead(502);
        res.end('yt-dlp returned empty output');
      }
    }
  });

  // Таймаут на получение первого чанка (60 секунд)
  const timeout = setTimeout(() => {
    if (!headersSent) {
      console.error('yt-dlp timeout');
      proc.kill();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end('yt-dlp timeout');
      }
    }
  }, 60000);
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
