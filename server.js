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

// Очередь для ограничения параллельных запросов (макс. 1 одновременная обработка)
let queue = [];
let processing = false;
const MAX_CONCURRENT = 1; // можно увеличить, но помните о ресурсах

function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  const { videoId, res } = queue.shift();
  handleYt(videoId, res, () => {
    processing = false;
    processQueue();
  });
}

function enqueue(videoId, res) {
  queue.push({ videoId, res });
  processQueue();
}

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

function handleYt(videoId, res, doneCallback) {
  const url = 'https://www.youtube.com/watch?v=' + videoId;
  console.log('yt-dlp for', videoId);

  const args = [
    '-f', 'bestaudio',
    '--no-playlist',
    '--no-check-certificates',
    '--js-runtime', 'node',
    '-o', '-',
    url,
  ];

  if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
    args.unshift('--cookies', 'cookies.txt');
    console.log('Using cookies.txt');
  }

  let headersSent = false;
  let stderr = '';
  let stdoutClosed = false;
  let processExited = false;

  const proc = spawn('yt-dlp', args, {
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
    stdoutClosed = true;
    if (headersSent) {
      res.end();
    } else {
      console.error('yt-dlp ended without sending any data');
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('yt-dlp failed: no data received');
      }
    }
    checkDone();
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
    checkDone();
  });

  proc.on('close', (code) => {
    processExited = true;
    if (code !== 0) {
      console.error('yt-dlp exit code', code, 'stderr:', stderr.slice(0, 500));
      if (!headersSent && !res.headersSent) {
        res.writeHead(502);
        res.end('yt-dlp failed: ' + stderr.slice(0, 300));
      } else if (headersSent) {
        // Если уже отправили заголовки, просто закрываем ответ, если он еще не закрыт
        if (!res.writableEnded) res.end();
      }
    } else {
      console.log('yt-dlp finished successfully');
      if (!headersSent && !res.headersSent) {
        res.writeHead(502);
        res.end('yt-dlp returned empty output');
      }
    }
    checkDone();
  });

  // Таймаут на получение первого чанка (60 секунд)
  const timeout = setTimeout(() => {
    if (!headersSent) {
      console.error('yt-dlp timeout');
      proc.kill('SIGTERM');
      if (!res.headersSent) {
        res.writeHead(504);
        res.end('yt-dlp timeout');
      }
    }
  }, 60000);

  // Функция проверки завершения процесса и очистки
  function checkDone() {
    if (stdoutClosed && processExited) {
      clearTimeout(timeout);
      if (doneCallback) doneCallback();
    }
  }

  // Принудительное завершение при закрытии соединения клиентом
  res.on('close', () => {
    if (!headersSent) {
      proc.kill('SIGTERM');
      clearTimeout(timeout);
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
    // Постановка в очередь
    enqueue(videoId, res);
    return;
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200);
    return res.end('ok');
  }

  let filePath = path.join(STATIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!path.extname(filePath)) filePath = path.join(STATIC, 'index.html');
  serveFile(res, filePath);
}).listen(PORT, () => console.log('PAC1 on port ' + PORT));
