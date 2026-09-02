const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const admin = require('firebase-admin');
const { Paddle, Environment } = require('@paddle/paddle-node-sdk');

const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: process.env.PADDLE_ENVIRONMENT === 'production' 
    ? Environment.production 
    : Environment.sandbox,
});

// Инициализация Firebase Admin
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase Admin initialized');
  } catch (err) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT:', err.message);
  }
} else {
  console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not set – auth will not work');
}

async function verifyToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('No token provided');
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    throw new Error('Invalid token: ' + err.message);
  }
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

//const https = require('https');
function fetchWithYoutubeMusicDownloader(videoId, res) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const APIFY_TOKEN = process.env.APIFY_TOKEN; // Ваш токен из переменных окружения

    // 1. Подготовка входных данных для актора maximedupre/youtube-music-downloader
    const runInput = {
        urls: [{ url: url }],  // Список URL для скачивания[reference:3]
        // "country": "US",    // Опционально: страна для geo-targeting[reference:4]
        // "format": "mp3",    // Можно указать формат: mp3, m4a, flac, wav и др.[reference:5]
    };

    const payload = JSON.stringify(runInput);

    // 2. Отправка POST-запроса к API Apify
    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/acts/maximedupre~youtube-music-downloader/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 180000, // Таймаут, как и у вас
    };

    const req = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
                console.error(`Apify API error: ${apiRes.statusCode} - ${data}`);
                // Здесь можно вызвать fallback (например, fetchWithYtDlpProxy)
                return;
            }
            try {
                const result = JSON.parse(data);
                if (!Array.isArray(result) || result.length === 0) {
                    throw new Error('No data in Apify response');
                }

                const item = result[0];
                // 3. Обработка результата
                // Актор maximedupre/youtube-music-downloader возвращает прямую ссылку на скачанный файл.
                const downloadUrl = item.url; // или item.downloadUrl? Проверьте структуру ответа

                if (!downloadUrl) {
                    throw new Error('No download URL in response');
                }

                // 4. Скачивание и отправка аудио клиенту (как в fetchWithApify)
                https.get(downloadUrl, (audioRes) => {
                    // ... ваш код для отправки аудио-потока в res
                });

            } catch (err) {
                console.error('Error processing Apify response:', err);
                // Fallback
            }
        });
    });

    req.on('error', (err) => {
        console.error('Apify request error:', err);
        // Fallback
    });

    req.write(payload);
    req.end();
}

function fetchWithApify(videoId, res) {
  let fallbackCalled = false;

  const callFallback = () => {
    if (!fallbackCalled) {
      fallbackCalled = true;
      fetchWithYtDlpProxy(videoId, res);
    }
  };

  if (!APIFY_TOKEN) {
    console.warn(`[${videoId}] APIFY_TOKEN not set, skipping Apify`);
    callFallback();
    return;
  }

  console.log(`[${videoId}] Trying Apify (utils/youtube-link)`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const input = {
    videos: [{ url: url }],
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    memory: 8192,
  };

  const payload = JSON.stringify(input);
  console.log(`[${videoId}] Apify payload:`, payload);

  const options = {
    hostname: 'api.apify.com',
    port: 443,
    path: `/v2/acts/utils~youtube-link/run-sync-get-dataset-items?token=${APIFY_TOKEN}&memory=8192`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 300000, // увеличен до 5 минут
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

        https.get(downloadUrl, { timeout: 120000 }, (webmRes) => {
          if (webmRes.statusCode !== 200) {
            throw new Error(`WebM download failed: ${webmRes.statusCode}`);
          }

          const chunks = [];
          webmRes.on('data', chunk => chunks.push(chunk));
          webmRes.on('end', () => {
            const webmBuffer = Buffer.concat(chunks);
            console.log(`[${videoId}] WebM downloaded: ${webmBuffer.length} bytes`);

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
              if (!res.headersSent) callFallback();
            });

            ffmpeg.on('close', (code) => {
              if (code !== 0) {
                console.error(`[${videoId}] ffmpeg exited with code ${code}`);
                if (!res.headersSent) callFallback();
                return;
              }

              const wavBuffer = Buffer.concat(wavChunks);
              console.log(`[${videoId}] WAV size: ${wavBuffer.length} bytes`);

              res.writeHead(200, {
                'Content-Type': 'audio/wav',
                'Content-Length': wavBuffer.length,
                'X-Audio-Title': encodeURIComponent(item.title || 'youtube_audio'),
              });
              res.end(wavBuffer);
              console.log(`[${videoId}] WAV sent to client`);
            });

            ffmpeg.stdin.write(webmBuffer, (err) => {
              if (err) console.error(`[${videoId}] stdin write error:`, err);
            });
            ffmpeg.stdin.end((err) => {
              if (err) console.error(`[${videoId}] stdin end error:`, err);
            });
          });

          webmRes.on('error', (err) => {
            console.error(`[${videoId}] WebM download error:`, err.message);
            if (!res.headersSent) callFallback();
          });
        }).on('error', (err) => {
          console.error(`[${videoId}] Failed to fetch downloadUrl:`, err.message);
          if (!res.headersSent) callFallback();
        });
      } catch (err) {
        console.error(`[${videoId}] Apify error:`, err.message);
        callFallback();
      }
    });
  });

  req.on('error', (err) => {
    console.error(`[${videoId}] Apify request error:`, err.message);
    callFallback();
  });

  req.on('timeout', () => {
    req.destroy();
    console.error(`[${videoId}] Apify timeout`);
    callFallback();
  });

  req.write(payload);
  req.end();
}

async function fetchAudioViaVideoDownloadApi(videoId, res) {
  const PROXY_URL = process.env.VIDEO_DOWNLOAD_PROXY_URL || 'https://video-download-api.com';

  try {
    // 1. Отправляем запрос на скачивание
    const downloadRes = await fetch(`${PROXY_URL}/download?url=https://www.youtube.com/watch?v=${videoId}&format=mp3&apikey=${process.env.VIDEO_DOWNLOAD_API_KEY}`);
    if (!downloadRes.ok) throw new Error(`Failed to start download: ${downloadRes.status}`);
    const { jobId } = await downloadRes.json();

    // 2. Ожидаем завершения (polling)
    let status = 'processing';
    let downloadUrl = null;
    while (status === 'processing') {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const statusRes = await fetch(`${PROXY_URL}/status?id=${jobId}`);
      if (!statusRes.ok) continue;
      const data = await statusRes.json();
      status = data.status;
      downloadUrl = data.downloadUrl;
      console.log(`[${videoId}] Job ${jobId}: ${data.progress}/1000`);
    }

    if (!downloadUrl) throw new Error('Download URL not found');

    // 3. Скачиваем файл и отправляем клиенту
    const fileRes = await fetch(downloadUrl);
    const buffer = await fileRes.buffer();

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length,
      'X-Audio-Title': encodeURIComponent('youtube_audio'),
    });
    res.end(buffer);

  } catch (err) {
    console.error(`[${videoId}] VideoDownloadApi error:`, err.message);
    // Резерв: Apify или yt-dlp
    fetchWithApify(videoId, res);
  }
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

  const proc = spawn('yt-dlp-proxy', args, { timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });

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

  proc.stdout.on('data', (chunk) => { sendHeaders(); res.write(chunk); });
  proc.stdout.on('end', () => {
    if (headersSent) { res.end(); console.log(`[${videoId}] yt-dlp-proxy finished`); }
    else {
      console.error(`[${videoId}] yt-dlp-proxy no data`);
      if (!res.headersSent) { res.writeHead(503); res.end('All video services unavailable'); }
    }
  });

  proc.stderr.on('data', (d) => console.error(`[${videoId}] yt-dlp-proxy stderr:`, d.toString()));
  proc.on('error', (err) => {
    console.error(`[${videoId}] yt-dlp-proxy spawn error:`, err.message);
    if (!headersSent && !res.headersSent) { res.writeHead(503); res.end('All video services unavailable'); }
    else { res.end(); }
  });

  proc.on('close', (code) => {
    if (code !== 0 && !headersSent) {
      console.error(`[${videoId}] yt-dlp-proxy exit code ${code}`);
      if (!res.headersSent) { res.writeHead(503); res.end('All video services unavailable'); }
    }
  });

  const timeout = setTimeout(() => {
    if (!headersSent) {
      console.error(`[${videoId}] yt-dlp-proxy timeout`);
      proc.kill();
      if (!res.headersSent) { res.writeHead(504); res.end('Timeout'); }
    }
  }, 120000);
}

function handleYt(videoId, res, req) {
  verifyToken(req)
    .then(user => {
      console.log(`User ${user.uid} requested video ${videoId}`);
      if (APIFY_TOKEN) {
        //fetchWithYoutubeMusicDownloader(videoId, res);
        //fetchWithApify(videoId, res);
        fetchAudioViaVideoDownloadApi(videoId, res);
      } else {
        fetchWithYtDlpProxy(videoId, res);
      }
    })
    .catch(err => {
      console.error('Auth error:', err.message);
      if (!res.headersSent) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized', message: err.message }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
}

// ------ Обработчики событий Paddle ------
async function handleTransactionCompleted(data) {
  const customerId = data.customerId; // это ваш userId из Firebase
  const subscriptionId = data.subscriptionId;
  const nextBilledAt = data.items?.[0]?.nextBilledAt || null;

  if (!customerId) {
    console.error('❌ Нет customerId в вебхуке');
    return;
  }

  const userRef = admin.firestore().collection('users').doc(customerId);
  await userRef.set({
    subscriptionStatus: 'active',
    paddleSubscriptionId: subscriptionId,
    expiresAt: nextBilledAt,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  console.log(`✅ Подписка активирована для пользователя ${customerId}`);
}

async function handleSubscriptionCanceled(data) {
  const customerId = data.customerId;
  if (!customerId) return;

  const userRef = admin.firestore().collection('users').doc(customerId);
  await userRef.set({
    subscriptionStatus: 'inactive',
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  console.log(`❌ Подписка отменена для пользователя ${customerId}`);
}

async function handleSubscriptionUpdated(data) {
  // Например, изменилась дата оплаты или статус
  const customerId = data.customerId;
  const status = data.status; // 'active', 'past_due', 'canceled' и т.д.
  if (!customerId) return;

  const userRef = admin.firestore().collection('users').doc(customerId);
  await userRef.set({
    subscriptionStatus: status === 'active' ? 'active' : 'inactive',
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  console.log(`🔄 Подписка обновлена для ${customerId}: ${status}`);
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
    res.end('ok');
    return;
  }

  // 3. ✅ НОВЫЙ БЛОК ДЛЯ ВЕБХУКОВ PADDLE
  if (req.method === 'POST' && url.pathname === '/api/webhooks/paddle') {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
      const rawBody = Buffer.concat(body);
      try {
        // Проверяем подпись и парсим событие
        const eventData = await paddle.webhooks.unmarshal(
          rawBody,
          req.headers['paddle-signature'],
          process.env.PADDLE_WEBHOOK_SECRET
        );

        console.log('🔔 Получен вебхук:', eventData.eventType);

        // Обработка событий
        switch (eventData.eventType) {
          case 'transaction.completed':
            await handleTransactionCompleted(eventData.data);
            break;
          case 'subscription.canceled':
            await handleSubscriptionCanceled(eventData.data);
            break;
          case 'subscription.updated':
            await handleSubscriptionUpdated(eventData.data);
            break;
          default:
            console.log(`ℹ️ Необработанный тип: ${eventData.eventType}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        console.error('❌ Ошибка вебхука:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return; // важно: не идти к serveFile
  }

  // ----- Прокси для video-download-api.com -----
if (req.method === 'GET' && url.pathname === '/api/video-download') {
  const videoUrl = url.searchParams.get('url');
  const format = url.searchParams.get('format') || 'mp3';

  if (!videoUrl) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing "url" parameter' }));
    return;
  }

  // Ваш API-ключ (добавьте в переменные окружения на Render)
  const API_KEY = process.env.VIDEO_DOWNLOAD_API_KEY;
  if (!API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API key not configured' }));
    return;
  }

  const apiParams = new URLSearchParams({
    url: videoUrl,
    format: format,
    apikey: API_KEY,
    add_info: '1',
    allow_extended_duration: '1',
    no_merge: '0'
  });

  const apiUrl = `https://p.savenow.to/ajax/download.php?${apiParams}`;

  https.get(apiUrl, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jobId: json.id,
          progressUrl: `https://p.savenow.to/ajax/progress.php?id=${json.id}`
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid API response' }));
      }
    });
  }).on('error', (err) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
  return;
}

// ----- Статус для video-download-api -----
if (req.method === 'GET' && url.pathname === '/api/video-download-status') {
  const jobId = url.searchParams.get('id');

  if (!jobId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing "id" parameter' }));
    return;
  }

  const apiUrl = `https://p.savenow.to/ajax/progress.php?id=${jobId}`;

  https.get(apiUrl, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          progress: json.progress,
          downloadUrl: json.download_url || null,
          status: json.progress === 1000 ? 'completed' : 'processing'
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid API response' }));
      }
    });
  }).on('error', (err) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
  return;
}
  
  // 4. Создание чекаута Paddle
  if (req.method === 'POST' && url.pathname === '/api/create-checkout') {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
      try {
        const { priceId } = JSON.parse(Buffer.concat(body).toString());
        
        // Получаем токен пользователя из заголовка
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          throw new Error('Unauthorized');
        }
        const idToken = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userId = decodedToken.uid;
  
        // Создаём транзакцию в Paddle
        const transaction = await paddle.transactions.create({
          items: [{ priceId, quantity: 1 }],
          //customerId: userId,
          successUrl: 'https://pac111.onrender.com/success',  // замените на свой домен
          cancelUrl: 'https://pac111.onrender.com/cancel',
        });
  
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ checkoutUrl: transaction.checkoutUrl }));
      } catch (err) {
        console.error('❌ Ошибка создания чекаута:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/success') {
    // Отдаём тот же index.html, но клиентская логика покажет нужный экран
    serveFile(res, path.join(STATIC, 'index.html'));
    return;
  }
  
  if (url.pathname === '/cancel') {
    serveFile(res, path.join(STATIC, 'index.html'));
    return;
  }
  
  // 4. Обработка статики (serveFile)
  let filePath = path.join(STATIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!path.extname(filePath)) filePath = path.join(STATIC, 'index.html');
  serveFile(res, filePath);
});

server.timeout = 300000; // увеличен до 5 минут
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (timeout: ${server.timeout/1000}s)`);
  if (APIFY_TOKEN) console.log('🔑 Apify token is set');
  else console.warn('⚠️ APIFY_TOKEN not set, only yt-dlp-proxy fallback will work');
});
