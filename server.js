const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const admin = require('firebase-admin');

// Инициализация из переменной окружения
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase Admin initialized');
  } catch (err) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT:', err.message);
  }
} else {
  console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set – auth will not work');
}

// Получение текущего токена
async function getFirebaseToken() {
  const user = auth.currentUser;
  if (user) {
    try {
      return await user.getIdToken();
    } catch (e) {
      console.error('Error getting token:', e);
      return null;
    }
  }
  return null;
}

const PORT = process.env.PORT || 80;
const STATIC = __dirname;
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';

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

async function verifyToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('No token provided');
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return decodedToken; // содержит uid, email и др.
  } catch (err) {
    throw new Error('Invalid token: ' + err.message);
  }
}

function fetchWithApify(videoId, res) {
  if (!APIFY_TOKEN) {
    console.warn(`[${videoId}] APIFY_TOKEN not set, skipping Apify`);
    return fetchWithYtDlpProxy(videoId, res);
  }

  console.log(`[${videoId}] Trying Apify (utils/youtube-link)`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const input = {
    videos: [{ url: url }],
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
    },
  };

  const payload = JSON.stringify(input);
  console.log(`[${videoId}] Apify payload:`, payload);

  const options = {
    hostname: 'api.apify.com',
    port: 443,
    path: `/v2/acts/utils~youtube-link/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 180000,
  };

  const req = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      console.log(`[${videoId}] Apify response status: ${apiRes.statusCode}`);
      console.log(`[${videoId}] Apify response body (first 500 chars):`, data.slice(0, 500));

      try {
        if (apiRes.statusCode !== 200 && apiRes.statusCode !== 201) {
          throw new Error(`Apify API returned ${apiRes.statusCode}: ${data.slice(0, 500)}`);
        }
        const result = JSON.parse(data);
        if (!Array.isArray(result) || result.length === 0) {
          throw new Error('No data in Apify response');
        }

        const item = result[0];
        console.log(`[${videoId}] Title: ${item.title}`);
        if (!item.ok || !item.downloadUrl) {
          throw new Error('Download URL missing in response');
        }
        const downloadUrl = item.downloadUrl;
        console.log(`[${videoId}] Download URL: ${downloadUrl}`);

        // 1. Скачиваем WebM с Apify в память
        https.get(downloadUrl, { timeout: 120000 }, (webmRes) => {
          if (webmRes.statusCode !== 200) {
            throw new Error(`WebM download failed: ${webmRes.statusCode}`);
          }

          const chunks = [];
          webmRes.on('data', chunk => chunks.push(chunk));
          webmRes.on('end', () => {
            const webmBuffer = Buffer.concat(chunks);
            console.log(`[${videoId}] WebM downloaded: ${webmBuffer.length} bytes`);

            // 2. Конвертируем через ffmpeg в WAV, собирая вывод в буфер
            const ffmpeg = spawn('ffmpeg', [
              '-i', 'pipe:0',
              '-f', 'wav',
              '-acodec', 'pcm_s16le',
              '-ar', '44100',
              '-ac', '2',
              'pipe:1'
            ]);

            let wavChunks = [];
            ffmpeg.stdout.on('data', chunk => wavChunks.push(chunk));

            ffmpeg.on('error', (err) => {
              console.error(`[${videoId}] ffmpeg error:`, err.message);
              if (!res.headersSent) fetchWithYtDlpProxy(videoId, res);
            });

            ffmpeg.on('close', (code) => {
              if (code !== 0) {
                console.error(`[${videoId}] ffmpeg exited with code ${code}`);
                if (!res.headersSent) fetchWithYtDlpProxy(videoId, res);
                return;
              }

              const wavBuffer = Buffer.concat(wavChunks);
              console.log(`[${videoId}] WAV size: ${wavBuffer.length} bytes`);

              // 3. Отправляем WAV клиенту с Content-Length
              res.writeHead(200, {
                'Content-Type': 'audio/wav',
                'Content-Length': wavBuffer.length,
                'X-Audio-Title': encodeURIComponent(item.title || 'youtube_audio'),
              });
              res.end(wavBuffer);
              console.log(`[${videoId}] WAV sent to client`);
            });

            ffmpeg.stdin.write(webmBuffer);
            ffmpeg.stdin.end();
          });

          webmRes.on('error', (err) => {
            console.error(`[${videoId}] WebM download error:`, err.message);
            if (!res.headersSent) fetchWithYtDlpProxy(videoId, res);
          });
        }).on('error', (err) => {
          console.error(`[${videoId}] Failed to fetch downloadUrl:`, err.message);
          if (!res.headersSent) fetchWithYtDlpProxy(videoId, res);
        });
      } catch (err) {
        console.error(`[${videoId}] Apify error:`, err.message);
        fetchWithYtDlpProxy(videoId, res);
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[${videoId}] Apify request error:`, err.message);
    fetchWithYtDlpProxy(videoId, res);
  });

  req.on('timeout', () => {
    req.destroy();
    console.error(`[${videoId}] Apify timeout`);
    fetchWithYtDlpProxy(videoId, res);
  });

  req.write(payload);
  req.end();
}

function fetchWithYtDlpProxy(videoId, res) {
  console.log(`[${videoId}] Trying yt-dlp-proxy as fallback`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const args = [
    '-f', 'bestaudio',
    '--no-playlist',
    '--no-check-certificates',
    '--extractor-args', 'youtube:player-client=android',
    '-o', '-',
    url,
  ];

  const proc = spawn('yt-dlp-proxy', args, {
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let headersSent = false;
  const sendHeaders = () => {
    if (!headersSent) {
      res.writeHead(200, {
        'Content-Type': 'audio/mp4',
        'X-Audio-Title': encodeURIComponent('youtube_audio'),
      });
      headersSent = true;
      console.log(`[${videoId}] yt-dlp-proxy headers sent`);
    }
  };

  proc.stdout.on('data', (chunk) => {
    sendHeaders();
    res.write(chunk);
  });

  proc.stdout.on('end', () => {
    if (headersSent) {
      res.end();
      console.log(`[${videoId}] yt-dlp-proxy finished`);
    } else {
      console.error(`[${videoId}] yt-dlp-proxy no data`);
      if (!res.headersSent) {
        res.writeHead(503);
        res.end('All video services unavailable');
      }
    }
  });

  proc.stderr.on('data', (d) => {
    console.error(`[${videoId}] yt-dlp-proxy stderr:`, d.toString());
  });

  proc.on('error', (err) => {
    console.error(`[${videoId}] yt-dlp-proxy spawn error:`, err.message);
    if (!headersSent && !res.headersSent) {
      res.writeHead(503);
      res.end('All video services unavailable');
    } else {
      res.end();
    }
  });

  proc.on('close', (code) => {
    if (code !== 0 && !headersSent) {
      console.error(`[${videoId}] yt-dlp-proxy exit code ${code}`);
      if (!res.headersSent) {
        res.writeHead(503);
        res.end('All video services unavailable');
      }
    }
  });

  const timeout = setTimeout(() => {
    if (!headersSent) {
      console.error(`[${videoId}] yt-dlp-proxy timeout`);
      proc.kill();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end('Timeout');
      }
    }
  }, 120000);
}

function handleYt(videoId, res, req) { // добавьте req
  // Проверяем токен (если нужно защитить эндпоинт)
  verifyToken(req)
    .then(user => {
      console.log(`User ${user.uid} requested video ${videoId}`);
      // Теперь вызываем основную логику (Apify или резерв)
      if (APIFY_TOKEN) {
        fetchWithApify(videoId, res);
      } else {
        fetchWithYtDlpProxy(videoId, res);
      }
    })
    .catch(err => {
      console.error('Auth error:', err.message);
      if (!res.headersSent) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', message: err.message }));
      }
    });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/yt/')) {
    const videoId = url.pathname.split('/api/yt/')[1].split('?')[0];
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      res.writeHead(400);
      return res.end('Invalid video ID');
    }
    return handleYt(videoId, res, req); 
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200);
    return res.end('ok');
  }
  let filePath = path.join(STATIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!path.extname(filePath)) filePath = path.join(STATIC, 'index.html');
  serveFile(res, filePath);
});

server.timeout = 180000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (timeout: ${server.timeout/1000}s)`);
  if (APIFY_TOKEN) console.log('🔑 Apify token is set');
  else console.warn('⚠️ APIFY_TOKEN not set, only yt-dlp-proxy fallback will work');
});
