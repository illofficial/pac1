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

// ------ ЮKassa (прямые HTTP-запросы) ------
async function createYooKassaPayment(amount, description, returnUrl, metadata) {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;

    if (!shopId || !secretKey) {
        throw new Error('YooKassa credentials not set');
    }

    const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
    const data = JSON.stringify({
        amount: {
            value: amount,
            currency: 'RUB',
        },
        confirmation: {
            type: 'redirect',
            return_url: returnUrl,
        },
        capture: true,
        description: description,
        metadata: metadata,
    });

    const options = {
        hostname: 'api.yookassa.ru',
        path: '/v3/payments',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${auth}`,
            'Content-Length': Buffer.byteLength(data),
        },
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    // Проверяем статус ответа
                    if (res.statusCode >= 400) {
                        // Ищем текст ошибки
                        const errorMsg = json.error?.description || json.description || `HTTP ${res.statusCode}: ${body}`;
                        reject(new Error(errorMsg));
                    } else {
                        resolve(json);
                    }
                } catch (err) {
                    reject(new Error(`Failed to parse YooKassa response: ${body}`));
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
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

const { v4: uuidv4 } = require('uuid');
//const YooKassa = require('@yookassa/sdk-node');

// const yooKassa = new YooKassa({
//     shopId: process.env.YOOKASSA_SHOP_ID,
//     secretKey: process.env.YOOKASSA_SECRET_KEY,
// });

// --- Новая функция для скачивания через Tornado API ---
async function fetchAudioViaTornadoApi(videoId, res) {
    const TORNADO_API_KEY = process.env.TORNADO_API_KEY;
    const API_BASE_URL = 'https://api.tornadoapi.io'; // Базовый URL для всех запросов[reference:7][reference:8]

    // Если ключ не найден, переключаемся на резервный метод (например, Apify)
    if (!TORNADO_API_KEY) {
        console.warn('TORNADO_API_KEY not set, falling back to Apify.');
        return fetchWithApify(videoId, res);
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    try {
        console.log(`[${videoId}] Creating Tornado job...`);

        // 1. Отправляем запрос на создание задачи на скачивание аудио[reference:9][reference:10]
        const createJobResponse = await fetch(`${API_BASE_URL}/jobs`, {
            method: 'POST',
            headers: {
                'x-api-key': TORNADO_API_KEY, // Ключ передаётся в заголовке[reference:11]
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              url: videoUrl,
              audio_only: true,
              // format и audio_bitrate не указываем — будет M4A с наивысшим битрейтом
          }),
        });

        if (!createJobResponse.ok) {
            const errorText = await createJobResponse.text();
            throw new Error(`Tornado API error (${createJobResponse.status}): ${errorText}`);
        }

        const jobData = await createJobResponse.json();
        const jobId = jobData.job_id; // Получаем ID задачи[reference:15]
        console.log(`[${videoId}] Tornado job created: ${jobId}`);

        // 2. Ожидаем завершения задачи (polling)[reference:16][reference:17]
        let jobStatus = 'Pending';
        let downloadUrl = null;
        let attempts = 0;
        const maxAttempts = 60; // Ждём максимум 60 * 3 = 180 секунд

        while (jobStatus !== 'Completed' && jobStatus !== 'Failed' && jobStatus !== 'Warning') {
            if (attempts >= maxAttempts) {
                throw new Error('Job timed out after 180 seconds.');
            }
            await new Promise(resolve => setTimeout(resolve, 3000)); // Ждём 3 секунды[reference:18]

            const statusResponse = await fetch(`${API_BASE_URL}/jobs/${jobId}`, {
                headers: { 'x-api-key': TORNADO_API_KEY },
            });

            if (!statusResponse.ok) {
                const errorText = await statusResponse.text();
                throw new Error(`Status check failed (${statusResponse.status}): ${errorText}`);
            }

            const statusData = await statusResponse.json();
            jobStatus = statusData.status; // Статусы: "Pending", "Processing", "Completed", "Failed"[reference:19]
            downloadUrl = statusData.s3_url; // Ссылка на готовый файл[reference:20]

            console.log(`[${videoId}] Job ${jobId} status: ${jobStatus}${downloadUrl ? ', file ready!' : ''}`);
            attempts++;
        }

        if (jobStatus === 'Failed' || jobStatus === 'Warning') {
            throw new Error(`Job failed with status: ${jobStatus}`);
        }

        if (!downloadUrl) {
            throw new Error('Download URL (s3_url) is missing from the final response.');
        }

        // 3. Скачиваем аудио по полученной ссылке и отправляем клиенту
        console.log(`[${videoId}] Downloading audio from: ${downloadUrl}`);
        const fileResponse = await fetch(downloadUrl);
        if (!fileResponse.ok) {
            throw new Error(`Failed to download audio file: ${fileResponse.status}`);
        }

        // Получаем аудио как буфер
        const audioBuffer = await fileResponse.arrayBuffer();

        // Отправляем аудио клиенту
        res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': audioBuffer.byteLength,
            'X-Audio-Title': encodeURIComponent(`audio_${videoId}`),
        });
        res.end(Buffer.from(audioBuffer));
        console.log(`[${videoId}] Audio sent to client via Tornado API`);

    } catch (error) {
        console.error(`[${videoId}] Tornado API error:`, error);
        // В случае ошибки переключаемся на резервный метод (Apify)
        fetchWithApify(videoId, res);
    }
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
        console.log(`User ${user.uid} requested video ${videoId}`);
        //fetchWithYoutubeMusicDownloader(videoId, res);
        //fetchWithApify(videoId, res);
        //fetchAudioViaVideoDownloadApi(videoId, res);
        fetchAudioViaTornadoApi(videoId, res);
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

// ------ Обработчики событий Paddle -----
async function handleTransactionCompleted(data) {
  const userId = data.custom_data?.userId || data.custom_data?.user_id;
  const paddleCustomerId = data.customer_id;
  const subscriptionId = data.subscription_id;

  if (!userId) {
    console.error('❌ Нет userId в custom_data:', JSON.stringify(data).slice(0, 500));
    return;
  }
  const userRef = admin.firestore().collection('users').doc(userId);
  await userRef.set({
    subscriptionStatus: 'active',
    paddleCustomerId,
    paddleSubscriptionId: subscriptionId,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  console.log(`✅ Подписка активирована для ${userId}`);
}

async function handleSubscriptionCanceled(data) {
  const userId = await resolveUserId(data);
  if (!userId) {
    console.error('❌ subscription.canceled: не смог определить userId',
      JSON.stringify({ custom_data: data.custom_data, customer_id: data.customer_id, id: data.id }));
    return;
  }

  await admin.firestore().collection('users').doc(userId).set({
    subscriptionStatus: 'inactive',
    hasAccess: false,
    canceledAt: data.canceled_at || new Date().toISOString(),
    scheduledCancelAt: null,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  console.log(`❌ Подписка отменена для ${userId} (sub: ${data.id})`);
}

async function handleSubscriptionUpdated(data) {
  const userId = await resolveUserId(data);
  if (!userId) {
    console.error('❌ subscription.updated: не смог определить userId',
      JSON.stringify({ custom_data: data.custom_data, customer_id: data.customer_id, id: data.id }));
    return;
  }

  // active | trialing | past_due | paused | canceled
  const raw = data.status;
  const status = (raw === 'active' || raw === 'trialing') ? 'active'
               : (raw === 'past_due') ? 'past_due'
               : (raw === 'paused') ? 'paused'
               : 'inactive';

  // отмена "в конце периода" прилетает именно сюда, а не в canceled
  const sc = data.scheduled_change;

  await admin.firestore().collection('users').doc(userId).set({
    subscriptionStatus: status,
    hasAccess: status === 'active' || status === 'past_due',
    paddleSubscriptionId: data.id || null,
    paddleCustomerId: data.customer_id || null,
    expiresAt: data.next_billed_at || data.current_billing_period?.ends_at || null,
    scheduledCancelAt: (sc && sc.action === 'cancel') ? sc.effective_at : null,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  console.log(`🔄 Подписка обновлена для ${userId}: ${raw}`);
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

  if (req.method === 'POST' && url.pathname === '/api/create-yookassa-payment') {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
        try {
            const { amount, plan } = JSON.parse(Buffer.concat(body).toString());

            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                throw new Error('Unauthorized');
            }
            const idToken = authHeader.split('Bearer ')[1];
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            const userId = decodedToken.uid;

            const payment = await createYooKassaPayment(
                amount,
                `Premium Audio Converter - ${plan}`,
                'https://pac111.onrender.com/success',
                { userId, plan }
            );

            // Логируем полный ответ для отладки
            console.log('📦 Полный ответ от ЮKassa:', JSON.stringify(payment, null, 2));

            if (!payment.confirmation || !payment.confirmation.confirmation_url) {
                // Если нет confirmation_url, выводим информацию из ответа
                const errorMsg = payment.error?.description || payment.description || 'Неизвестная ошибка ЮKassa';
                throw new Error(errorMsg);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ confirmationUrl: payment.confirmation.confirmation_url }));
        } catch (err) {
            console.error('❌ Ошибка создания платежа ЮKassa:', err);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            } else {
                res.end();
            }
        }
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

        const transaction = await paddle.transactions.create({
          items: [{ priceId, quantity: 1 }],
          customData: { userId }, // <-- обязательно, иначе не свяжешь оплату с юзером
          collectionMode: 'automatic',
          checkout: { // <-- success/cancel должны быть ВНУТРИ checkout, а не на верхнем уровне
            successUrl: 'https://pac111.onrender.com/success',
            cancelUrl: 'https://pac111.onrender.com/cancel',
          }
        });
        
        console.log('DEBUG transaction:', JSON.stringify(transaction, null, 2));
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          transactionId: transaction.id,
          checkoutUrl: transaction.checkout?.url || null,
        }));
  
        // res.writeHead(200, { 'Content-Type': 'application/json' });
        // console.log('✅ Sending checkoutUrl to client:', transaction.checkoutUrl);
        // res.end(JSON.stringify({ checkoutUrl: transaction.checkoutUrl }));
      } catch (err) {
        console.error('❌ Ошибка создания чекаута:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  async function createYooKassaPayment(amount, description, returnUrl, metadata) {
    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;

    if (!shopId || !secretKey) {
        throw new Error('YooKassa credentials not set');
    }

    const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
    const data = JSON.stringify({
        amount: {
            value: amount,
            currency: 'RUB',
        },
        confirmation: {
            type: 'redirect',
            return_url: returnUrl,
        },
        capture: true,
        description: description,
        metadata: metadata,
    });

    const options = {
        hostname: 'api.yookassa.ru',
        path: '/v3/payments',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${auth}`,
            'Content-Length': Buffer.byteLength(data),
        },
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    if (json.error) {
                        reject(new Error(json.error.description || 'YooKassa error'));
                    } else {
                        resolve(json);
                    }
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/yookassa-webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const event = JSON.parse(body);
            if (event.object?.status === 'succeeded') {
                const userId = event.object.metadata?.userId;
                if (userId) {
                    const userRef = admin.firestore().collection('users').doc(userId);
                    await userRef.set({
                        subscriptionStatus: 'active',
                        updatedAt: new Date().toISOString(),
                    }, { merge: true });
                    console.log(`✅ Подписка активирована для ${userId} через ЮKassa`);
                }
            }
            res.writeHead(200);
            res.end('OK');
        } catch (err) {
            console.error('❌ Ошибка вебхука ЮKassa:', err);
            res.writeHead(400);
            res.end('Bad Request');
        }
    });
    return;
  }
  
  if (req.method === 'GET' && url.pathname === '/api/paddle-token') {
    const clientToken = process.env.PADDLE_CLIENT_TOKEN;
    if (!clientToken) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: 'Client token not set' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: clientToken }));
    return;
  }
  
  // 3. ✅ НОВЫЙ БЛОК ДЛЯ ВЕБХУКОВ PADDLE
  // ----- Обработка вебхуков от Paddle (ручная проверка, правильная формула) -----
  if (req.method === 'POST' && url.pathname === '/api/webhooks/paddle') {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
      const rawBody = Buffer.concat(body);
      const rawBodyString = rawBody.toString('utf8');
  
      const signatureHeader = req.headers['paddle-signature'];
      if (!signatureHeader) {
        console.error('❌ Missing paddle-signature header');
        res.writeHead(400);
        res.end('Missing signature');
        return;
      }
  
      // Парсим заголовок: "ts=...;h1=..."
      const parts = signatureHeader.split(';');
      let timestamp = null;
      let signature = null;
      for (const part of parts) {
        const [key, value] = part.split('=');
        if (key === 'ts') timestamp = value;
        if (key === 'h1') signature = value;
      }
  
      if (!timestamp || !signature) {
        console.error('❌ Invalid signature header format');
        res.writeHead(400);
        res.end('Invalid signature format');
        return;
      }
  
      // Проверяем, что timestamp не старше 5 минут (защита от replay)
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - parseInt(timestamp)) > 300) {
        console.error('❌ Timestamp too old or in future');
        res.writeHead(400);
        res.end('Invalid timestamp');
        return;
      }
  
      const secret = process.env.PADDLE_WEBHOOK_SECRET;
      if (!secret) {
        console.error('❌ PADDLE_WEBHOOK_SECRET not set');
        res.writeHead(500);
        res.end('Webhook secret not configured');
        return;
      }
  
      // ✅ Правильная формула: HMAC-SHA256(secret, timestamp + ":" + requestBody)
      const crypto = require('crypto');
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(`${timestamp}:${rawBodyString}`);
      const expectedSignature = hmac.digest('hex');
  
      // Для отладки (можно удалить после настройки)
      console.log('🔍 Expected signature:', expectedSignature);
      console.log('🔍 Received signature:', signature);
  
      // Сравниваем подписи (защита от timing attack)
      const isValid = crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );
  
      if (!isValid) {
        console.error('❌ Invalid webhook signature');
        res.writeHead(400);
        res.end('Invalid signature');
        return;
      }
  
      console.log('✅ Webhook signature verified successfully');
  
      try {
        // Парсим событие
        const event = JSON.parse(rawBodyString);
        console.log(`✅ Webhook event type: ${event.event_type}`);
  
        // Обработка событий
        switch (event.event_type) {
          case 'transaction.created':
            // Просто логируем (опционально)
            console.log(`ℹ️ Transaction created: ${event.data.id}`);
            break;
          case 'transaction.completed':
            await handleTransactionCompleted(event.data);
            break;
          case 'subscription.canceled':
            await handleSubscriptionCanceled(event.data);
            break;
          case 'subscription.updated':
            await handleSubscriptionUpdated(event.data);
            break;
          default:
            console.log(`ℹ️ Unhandled event type: ${event.event_type}`);
        }
  
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        console.error('❌ Error processing webhook event:', err);
        res.writeHead(400);
        res.end('Error processing event');
      }
    });
    return;
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

  if (url.pathname === '/success') {
    // Отдаём тот же index.html, но клиентская логика покажет нужный экран
    serveFile(res, path.join(STATIC, 'index.html'));
    return;
  }
  
  if (url.pathname === '/cancel') {
    serveFile(res, path.join(STATIC, 'index.html'));
    return;
  }

  if (url.pathname === '/paywall') {
    serveFile(res, path.join(STATIC, 'index.html'));
    return;
  }

  if (url.pathname === '/terms') {
    serveFile(res, path.join(STATIC, 'index.html'));
    return;
  }
  
  if (url.pathname === '/privacy') {
    serveFile(res, path.join(STATIC, 'index.html'));
    return;
  }
  
  if (url.pathname === '/refund') {
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
