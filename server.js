const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 80;
const STATIC = __dirname;

// Список публичных инстансов Invidious (с поддержкой CORS или без)
const INVIDIOUS_INSTANCES = [
  'https://invidious.fdn.fr',
  'https://inv.nadeko.net',
  'https://invidious.perennialte.ch',
  'https://vid.puffyan.us',
  'https://yewtu.be',
];

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
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

function fetchInvidiousAudio(videoId, res) {
  console.log(`[${videoId}] Trying Invidious`);

  // Пробуем инстансы по очереди
  let currentInstanceIndex = 0;

  const tryNextInstance = () => {
    if (currentInstanceIndex >= INVIDIOUS_INSTANCES.length) {
      console.error(`[${videoId}] All Invidious instances failed`);
      if (!res.headersSent) {
        res.writeHead(503);
        res.end('All video services are unavailable');
      }
      return;
    }

    const instance = INVIDIOUS_INSTANCES[currentInstanceIndex];
    currentInstanceIndex++;
    console.log(`[${videoId}] Trying instance: ${instance}`);

    // Сначала получаем информацию о видео, чтобы найти аудио-поток
    const infoUrl = `${instance}/api/v1/videos/${videoId}`;
    const req = https.get(infoUrl, (infoRes) => {
      let data = '';
      infoRes.on('data', chunk => data += chunk);
      infoRes.on('end', () => {
        try {
          const videoInfo = JSON.parse(data);
          if (!videoInfo || !videoInfo.adaptiveFormats) {
            throw new Error('No adaptive formats');
          }

          // Ищем лучший аудио-формат (предпочтение opus, затем m4a)
          const audioFormats = videoInfo.adaptiveFormats
            .filter(f => f.type && f.type.startsWith('audio/'))
            .sort((a, b) => {
              const score = (f) => {
                if (f.type.includes('opus')) return 3;
                if (f.type.includes('mp4')) return 2;
                return 1;
              };
              return score(b) - score(a);
            });

          if (!audioFormats.length) {
            throw new Error('No audio streams');
          }

          const bestFormat = audioFormats[0];
          const audioUrl = bestFormat.url;

          // Проксируем аудио-поток
          const audioReq = https.get(audioUrl, (audioRes) => {
            if (audioRes.statusCode !== 200) {
              throw new Error(`Audio stream returned ${audioRes.statusCode}`);
            }

            res.writeHead(200, {
              'Content-Type': 'audio/mp4',
              'X-Audio-Title': encodeURIComponent(videoInfo.title || 'youtube_audio'),
            });

            audioRes.pipe(res);
            audioRes.on('end', () => console.log(`[${videoId}] Stream finished`));
          });

          audioReq.on('error', (err) => {
            console.error(`[${videoId}] Audio stream error:`, err.message);
            if (!res.headersSent) {
              tryNextInstance();
            } else {
              res.end();
            }
          });

        } catch (err) {
          console.error(`[${videoId}] Error parsing video info:`, err.message);
          tryNextInstance();
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[${videoId}] Request to ${instance} failed:`, err.message);
      tryNextInstance();
    });

    req.setTimeout(10000, () => {
      req.destroy();
      console.error(`[${videoId}] Timeout on ${instance}`);
      tryNextInstance();
    });
  };

  tryNextInstance();
}

function handleYt(videoId, res) {
  // Первая попытка — Invidious
  fetchInvidiousAudio(videoId, res);
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
  if (!path.extname(filePath)) {
    filePath = path.join(STATIC, 'index.html');
  }
  serveFile(res, filePath);
}).listen(PORT, () => console.log(`Server running on port ${PORT} (Invidious proxy mode)`));
