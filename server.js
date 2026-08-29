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
  
  // Запускаем процесс
  const proc = spawn('yt-dlp', [
    '--cookies', 'cookies.txt', 
    '-f', 'bestaudio',
    '--no-playlist',
    '--no-check-certificates',
    '--js-runtime', 'node',   // обязательно!
    '-o', '-',
    url,
  ], {
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let headersSent = false;
  let stderr = '';
  let firstChunkReceived = false;

  //---
  const safeWrite = (data) => {
    if (!headersSent) {
      // Отправляем заголовки только один раз, перед первой записью данных
      res.writeHead(200, { 'Content-Type': 'audio/mp4' });
      headersSent = true;
      console.log('Streaming started');
    }
    res.write(data);
  };

  // Обработка данных от yt-dlp
  proc.stdout.on('data', (chunk) => {
    safeWrite(chunk); // <-- Используем safeWrite
  });

  proc.stdout.on('end', () => {
    if (headersSent) {
      res.end();
    } else {
      // Если данные так и не пришли, отправляем ошибку
      res.writeHead(502);
      res.end('yt-dlp failed: no data received');
    }
  });

  // Обработка ошибок
  proc.on('error', (err) => {
    if (!headersSent) {
      res.writeHead(500);
      res.end('yt-dlp process error');
    } else {
      res.end();
    }
  });

  proc.on('close', (code) => {
    if (code !== 0 && !headersSent) {
      // Если процесс завершился с ошибкой до отправки данных
      res.writeHead(502);
      res.end('yt-dlp failed');
    } else if (code !== 0 && headersSent) {
      // Если процесс упал во время стриминга
      res.end();
    }
  });
  //---
  
  // Обработка stdout – первый чанк означает, что аудио пошло
  proc.stdout.on('data', (chunk) => {
    if (!headersSent) {
      // Отправляем заголовки прямо перед первой записью
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'X-Audio-Title': encodeURIComponent('youtube_audio'),
      });
      headersSent = true;
      console.log('Streaming started, first chunk size:', chunk.length);
    }
    res.write(chunk);
    firstChunkReceived = true;
  });

  // proc.stdout.on('end', () => {
  //   if (headersSent) res.end();
  //   else {
  //     // Если процесс завершился, а мы так и не отправили заголовки – ошибка
  //     if (!headersSent) {
  //       console.error('yt-dlp ended without sending any data');
  //       res.writeHead(502);
  //       res.end('yt-dlp failed: no data received');
  //     }
  //   }
  // });

  // // Собираем stderr для диагностики
  // proc.stderr.on('data', (d) => {
  //   stderr += d.toString();
  //   console.error('yt-dlp stderr:', d.toString());
  // });

  // // Ошибка запуска
  // proc.on('error', (e) => {
  //   console.error('yt-dlp spawn error:', e.message);
  //   if (!headersSent) {
  //     res.writeHead(502);
  //     res.end('yt-dlp error: ' + e.message);
  //   } else {
  //     res.end();
  //   }
  // });

  // Завершение процесса
  // proc.on('close', (code) => {
  //   if (code !== 0 && !headersSent) {
  //     console.error('yt-dlp exit code', code, 'stderr:', stderr.slice(0, 500));
  //     res.writeHead(502);
  //     res.end('yt-dlp failed: ' + stderr.slice(0, 300));
  //   } else if (code !== 0 && headersSent) {
  //     // Если процесс упал уже после отправки данных – просто завершаем ответ
  //     console.error('yt-dlp crashed during streaming, code', code);
  //     res.end();
  //   } else {
  //     console.log('yt-dlp finished successfully');
  //     if (headersSent) res.end();
  //   }
  // });

  // Таймаут на случай, если процесс висит
  const timeout = setTimeout(() => {
    if (!headersSent) {
      console.error('yt-dlp timeout, killing process');
      proc.kill();
      res.writeHead(504);
      res.end('yt-dlp timeout');
    }
  }, 60000); // 60 секунд на первый чанк
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
