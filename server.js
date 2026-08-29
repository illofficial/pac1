const http = require('http');
const fs = require('fs');
const path = require('path');
const ytdl = require('ytdl-core');

const PORT = process.env.PORT || 80;
const STATIC = __dirname;

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};

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
  console.log(`[${videoId}] Starting ytdl-core`);

  const stream = ytdl(url, {
    quality: 'highestaudio',
    requestOptions: { timeout: 60000 },
  });

  let headersSent = false;
  const sendHeaders = () => {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'X-Audio-Title': encodeURIComponent('youtube_audio'),
      });
      headersSent = true;
      console.log(`[${videoId}] Headers sent, streaming`);
    }
  };

  stream.on('data', (chunk) => {
    sendHeaders();
    res.write(chunk);
  });

  stream.on('end', () => {
    if (headersSent) {
      res.end();
      console.log(`[${videoId}] Stream finished`);
    } else {
      // Если данных не было – это ошибка (не должно случиться, если была ошибка ранее)
      console.error(`[${videoId}] No data received`);
      if (!res.headersSent) {
        res.writeHead(404);
        res.end('Video not found or no audio available');
      }
    }
  });

  stream.on('error', (err) => {
    console.error(`[${videoId}] ytdl error:`, err.message);
    // Разбираем ошибку
    let statusCode = 500;
    let message = 'Internal server error';

    if (err.message.includes('Status code: 410')) {
      statusCode = 404;
      message = 'Video is unavailable (deleted, private, or region-restricted)';
    } else if (err.message.includes('Status code: 403')) {
      statusCode = 403;
      message = 'Video is age-restricted or requires authentication';
    } else if (err.message.includes('Status code: 429')) {
      statusCode = 429;
      message = 'Too many requests, please try again later';
    } else if (err.message.includes('Status code: 404')) {
      statusCode = 404;
      message = 'Video not found';
    }

    if (!headersSent && !res.headersSent) {
      res.writeHead(statusCode);
      res.end(message);
    } else {
      // Если уже начали стримить – просто завершаем
      res.end();
    }
  });

  const timeout = setTimeout(() => {
    if (!headersSent) {
      console.error(`[${videoId}] Timeout waiting for first chunk`);
      stream.destroy();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end('Timeout');
      }
    }
  }, 60000);
}

  stream.on('data', (chunk) => {
    sendHeaders();
    res.write(chunk);
  });

  stream.on('end', () => {
    if (headersSent) {
      res.end();
      console.log(`[${videoId}] Stream finished`);
    } else {
      console.error(`[${videoId}] No data received`);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('No audio data');
      }
    }
  });

  stream.on('error', (err) => {
    console.error(`[${videoId}] ytdl error:`, err.message);
    if (!headersSent && !res.headersSent) {
      res.writeHead(502);
      res.end('ytdl error: ' + err.message);
    } else {
      res.end();
    }
  });

  const timeout = setTimeout(() => {
    if (!headersSent) {
      console.error(`[${videoId}] Timeout waiting for first chunk`);
      stream.destroy();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end('Timeout');
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
}).listen(PORT, () => console.log(`Server running on port ${PORT}`));
