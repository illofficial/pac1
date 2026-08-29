const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ytdl = require('ytdl-core');

const PORT = process.env.PORT || 80;
const STATIC = __dirname;

// Расширенный список Invidious инстансов
const INVIDIOUS_INSTANCES = [
  'https://invidious.fdn.fr',
  'https://inv.nadeko.net',
  'https://invidious.perennialte.ch',
  'https://vid.puffyan.us',
  'https://yewtu.be',
  'https://invidious.snopyta.org',
  'https://invidious.nerdvpn.de',
  'https://invidious.materialio.us',
  'https://invidious.zapashcanon.fr',
  'https://invidious.privacydev.net',
  'https://inv.riverside.rocks',
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
    console.log('✅ Cookies loaded successfully');
  } catch (err) {
    console.error('❌ Error loading cookies:', err.message);
  }
} else {
  console.warn('⚠️ cookies.txt not found – ytdl-core fallback may fail');
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

// Прокси через Invidious
function fetchInvidiousAudio(videoId, res) {
  console.log(`[${videoId}] Trying Invidious`);
  let currentInstanceIndex = 0;
  let errors = [];

  const tryNextInstance = () => {
    if (currentInstanceIndex >= INVIDIOUS_INSTANCES.length) {
      console.error(`[${videoId}] All Invidious instances failed. Errors:`, errors);
      // Пробуем запасной вариант через ytdl-core
      fetchYtdlFallback(videoId, res);
      return;
    }

    const instance = INVIDIOUS_INSTANCES[currentInstanceIndex];
    currentInstanceIndex++;
    console.log(`[${videoId}] Trying instance: ${instance}`);

    const infoUrl = `${instance}/api/v1/videos/${videoId}`;
    const req = https.get(infoUrl, (infoRes) => {
      let data = '';
      infoRes.on('data', chunk => data += chunk);
      infoRes.on('end', () => {
        try {
          if (infoRes.statusCode !== 200) {
            throw new Error(`HTTP ${infoRes.statusCode}`);
          }
          const videoInfo = JSON.parse(data);
          if (!videoInfo || !videoInfo.adaptiveFormats) {
            throw new Error('No adaptive formats');
          }

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
              errors.push(`${instance}: ${err.message}`);
              tryNextInstance();
            } else {
              res.end();
            }
          });

          audioReq.setTimeout(15000, () => {
            audioReq.destroy();
            if (!res.headersSent) {
              errors.push(`${instance}: timeout on audio stream`);
              tryNextInstance();
            }
          });

        } catch (err) {
          console.error(`[${videoId}] Error parsing video info:`, err.message);
          errors.push(`${instance}: ${err.message}`);
          tryNextInstance();
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[${videoId}] Request to ${instance} failed:`, err.message);
      errors.push(`${instance}: ${err.message}`);
      tryNextInstance();
    });

    req.setTimeout(10000, () => {
      req.destroy();
      console.error(`[${videoId}] Timeout on ${instance}`);
      errors.push(`${instance}: timeout`);
      tryNextInstance();
    });
  };

  tryNextInstance();
}

// Запасной вариант через ytdl-core (с cookies, если есть)
function fetchYtdlFallback(videoId, res) {
  console.log(`[${videoId}] Trying ytdl-core fallback`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const requestOptions = { timeout: 60000 };
  if (cookieString) {
    requestOptions.headers = { Cookie: cookieString };
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
      console.log(`[${videoId}] ytdl-core stream finished`);
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

function handleYt(videoId, res) {
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
}).listen(PORT, () => console.log(`Server running on port ${PORT} (Invidious + ytdl-core fallback)`));
