const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ytdl = require('ytdl-core');

const PORT = process.env.PORT || 80;
const STATIC = __dirname;

// ----- Список прокси-сервисов (порядок важен) -----
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.moomoo.me',
  'https://pipedapi.guardianapp.com',
  'https://api.piped.yt',
];

const INVIDIOUS_INSTANCES = [
  'https://yewtu.be',
  'https://invidious.perennialte.ch',
  'https://inv.nadeko.net',
  'https://vid.puffyan.us',
];

// Загружаем cookies для ytdl-core (если есть)
let cookieString = '';
const cookiesPath = path.join(__dirname, 'cookies.txt');
if (fs.existsSync(cookiesPath)) {
  try {
    const lines = fs.readFileSync(cookiesPath, 'utf8').split('\n');
    const cookies = lines
      .filter(line => line.trim() && !line.startsWith('#'))
      .map(line => line.split('\t'))
      .filter(parts => parts.length >= 7)
      .map(parts => `${parts[5]}=${parts[6]}`);
    cookieString = cookies.join('; ');
    console.log('✅ Cookies loaded for ytdl-core');
  } catch (err) {
    console.error('❌ Error loading cookies:', err.message);
  }
} else {
  console.warn('⚠️ cookies.txt not found – ytdl-core will work without auth (may fail)');
}

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

// ---------- Piped API (основной) ----------
function fetchPipedAudio(videoId, res, callback) {
  let current = 0;
  const errors = [];

  const tryNext = () => {
    if (current >= PIPED_INSTANCES.length) {
      console.error(`[${videoId}] All Piped instances failed, trying Invidious`);
      return fetchInvidiousAudio(videoId, res, errors);
    }

    const instance = PIPED_INSTANCES[current++];
    console.log(`[${videoId}] Trying Piped: ${instance}`);
    const url = `${instance}/streams/${videoId}`;

    const req = https.get(url, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          if (resp.statusCode !== 200) {
            throw new Error(`HTTP ${resp.statusCode}`);
          }
          const info = JSON.parse(data);
          if (!info || !info.audioStreams || !info.audioStreams.length) {
            throw new Error('No audio streams');
          }

          // Выбираем аудио с наилучшим битрейтом (обычно opus или m4a)
          const best = info.audioStreams.reduce((a, b) => (a.bitrate || 0) > (b.bitrate || 0) ? a : b);
          const audioUrl = best.url;

          const audioReq = https.get(audioUrl, (audioRes) => {
            if (audioRes.statusCode !== 200) {
              throw new Error(`Audio stream HTTP ${audioRes.statusCode}`);
            }
            res.writeHead(200, {
              'Content-Type': 'audio/mp4',
              'X-Audio-Title': encodeURIComponent(info.title || 'youtube_audio'),
            });
            audioRes.pipe(res);
            audioRes.on('end', () => console.log(`[${videoId}] Piped stream finished`));
          });
          audioReq.on('error', (err) => {
            console.error(`[${videoId}] Piped audio error:`, err.message);
            if (!res.headersSent) {
              errors.push(`${instance}: ${err.message}`);
              tryNext();
            } else {
              res.end();
            }
          });
          audioReq.setTimeout(15000, () => {
            audioReq.destroy();
            if (!res.headersSent) {
              errors.push(`${instance}: timeout`);
              tryNext();
            }
          });
        } catch (err) {
          console.error(`[${videoId}] Piped parse error:`, err.message);
          errors.push(`${instance}: ${err.message}`);
          tryNext();
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[${videoId}] Piped request error:`, err.message);
      errors.push(`${instance}: ${err.message}`);
      tryNext();
    });
    req.setTimeout(10000, () => {
      req.destroy();
      errors.push(`${instance}: timeout`);
      tryNext();
    });
  };

  tryNext();
}

// ---------- Invidious (резерв) ----------
function fetchInvidiousAudio(videoId, res, prevErrors = []) {
  let current = 0;
  const errors = [...prevErrors];

  const tryNext = () => {
    if (current >= INVIDIOUS_INSTANCES.length) {
      console.error(`[${videoId}] All Invidious instances failed, trying ytdl-core`);
      return fetchYtdlFallback(videoId, res, errors);
    }

    const instance = INVIDIOUS_INSTANCES[current++];
    console.log(`[${videoId}] Trying Invidious: ${instance}`);
    const infoUrl = `${instance}/api/v1/videos/${videoId}`;

    const req = https.get(infoUrl, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          if (resp.statusCode !== 200) {
            throw new Error(`HTTP ${resp.statusCode}`);
          }
          const info = JSON.parse(data);
          if (!info || !info.adaptiveFormats) {
            throw new Error('No adaptive formats');
          }
          const audioFormats = info.adaptiveFormats
            .filter(f => f.type && f.type.startsWith('audio/'))
            .sort((a, b) => (a.bitrate || 0) > (b.bitrate || 0) ? -1 : 1);
          if (!audioFormats.length) {
            throw new Error('No audio streams');
          }
          const best = audioFormats[0];
          const audioUrl = best.url;

          const audioReq = https.get(audioUrl, (audioRes) => {
            if (audioRes.statusCode !== 200) {
              throw new Error(`Audio stream HTTP ${audioRes.statusCode}`);
            }
            res.writeHead(200, {
              'Content-Type': 'audio/mp4',
              'X-Audio-Title': encodeURIComponent(info.title || 'youtube_audio'),
            });
            audioRes.pipe(res);
            audioRes.on('end', () => console.log(`[${videoId}] Invidious stream finished`));
          });
          audioReq.on('error', (err) => {
            console.error(`[${videoId}] Invidious audio error:`, err.message);
            if (!res.headersSent) {
              errors.push(`${instance}: ${err.message}`);
              tryNext();
            } else {
              res.end();
            }
          });
          audioReq.setTimeout(15000, () => {
            audioReq.destroy();
            if (!res.headersSent) {
              errors.push(`${instance}: timeout`);
              tryNext();
            }
          });
        } catch (err) {
          console.error(`[${videoId}] Invidious parse error:`, err.message);
          errors.push(`${instance}: ${err.message}`);
          tryNext();
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[${videoId}] Invidious request error:`, err.message);
      errors.push(`${instance}: ${err.message}`);
      tryNext();
    });
    req.setTimeout(10000, () => {
      req.destroy();
      errors.push(`${instance}: timeout`);
      tryNext();
    });
  };

  tryNext();
}

// ---------- ytdl-core (последний резерв) ----------
function fetchYtdlFallback(videoId, res, prevErrors = []) {
  console.log(`[${videoId}] Trying ytdl-core fallback`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const requestOptions = { timeout: 60000 };
  if (cookieString) {
    requestOptions.headers = { Cookie: cookieString };
    console.log(`[${videoId}] Using cookies with ytdl-core`);
  } else {
    console.warn(`[${videoId}] No cookies, ytdl-core may fail with 403/410`);
  }

  const stream = ytdl(url, {
    quality: 'highestaudio',
    requestOptions: requestOptions,
  });

  let headersSent = false;

  const sendHeaders = () => {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'X-Audio-Title': encodeURIComponent('youtube_audio'),
      });
      headersSent = true;
      console.log(`[${videoId}] ytdl-core headers sent`);
    }
  };

  stream.on('data', (chunk) => {
    sendHeaders();
    res.write(chunk);
  });

  stream.on('end', () => {
    if (headersSent) {
      res.end();
      console.log(`[${videoId}] ytdl-core finished`);
    } else {
      console.error(`[${videoId}] ytdl-core no data`);
      if (!res.headersSent) {
        res.writeHead(503);
        res.end('All video services unavailable');
      }
    }
  });

  stream.on('error', (err) => {
    console.error(`[${videoId}] ytdl-core error:`, err.message);
    if (!headersSent && !res.headersSent) {
      res.writeHead(503);
      res.end('All video services unavailable');
    } else {
      res.end();
    }
  });

  const timeout = setTimeout(() => {
    if (!headersSent) {
      console.error(`[${videoId}] ytdl-core timeout`);
      stream.destroy();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end('Timeout');
      }
    }
  }, 60000);
}

// ---------- Основной обработчик ----------
function handleYt(videoId, res) {
  fetchPipedAudio(videoId, res);
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
}).listen(PORT, () => console.log(`Server running on port ${PORT} (Piped + Invidious + ytdl-core fallback)`));
