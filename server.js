const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

function fetchWithApify(videoId, res) {
  if (!APIFY_TOKEN) {
    console.warn(`[${videoId}] APIFY_TOKEN not set, skipping Apify`);
    return fetchWithYtDlpProxy(videoId, res);
  }

  console.log(`[${videoId}] Trying Apify`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const input = {
    videos: [{ url: url }],
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
    },
  };

  const payload = JSON.stringify(input);
  const options = {
    hostname: 'api.apify.com',
    port: 443,
    path: `/v2/acts/utils~youtube-link/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 60000,
  };

  const req = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        if (apiRes.statusCode !== 200) {
          throw new Error(`Apify API returned ${apiRes.statusCode}: ${data.slice(0, 500)}`);
        }
        const result = JSON.parse(data);
        if (!Array.isArray(result) || result.length === 0) {
          throw new Error('No data in Apify response');
        }

        const item = result[0];
        console.log(`[${videoId}] Apify item: ${item.title || 'no title'}`);

        // Проверяем, есть ли аудиоформаты
        let audioFormats = [];
        if (item.audioFormats && Array.isArray(item.audioFormats)) {
          audioFormats = item.audioFormats;
        }
        // Также проверим видеоформаты с аудиодорожкой
        if (item.videoFormats && Array.isArray(item.videoFormats)) {
          for (const fmt of item.videoFormats) {
            if (fmt.audioBitrate) {
              audioFormats.push({ url: fmt.url, bitrate: fmt.audioBitrate || fmt.bitrate, ext: 'mp4' });
            }
          }
        }

        if (audioFormats.length === 0) {
          throw new Error('No audio formats found');
        }

        // Предпочтение: mp4/m4a, затем webm, затем любой другой
        const preferredTypes = ['audio/mp4', 'audio/x-m4a', 'audio/webm'];
        let selected = null;
        for (const type of preferredTypes) {
          selected = audioFormats.find(f => f.url && f.contentType && f.contentType.includes(type));
          if (selected) break;
        }
        if (!selected) {
          selected = audioFormats.find(f => f.url && f.contentType && f.contentType.startsWith('audio/'));
        }
        if (!selected) {
          // Если нет contentType, берём первый попавшийся url
          selected = audioFormats.find(f => f.url);
        }
        if (!selected || !selected.url) {
          throw new Error('No audio URL found');
        }

        const audioUrl = selected.url;
        console.log(`[${videoId}] Selected audio URL: ${audioUrl}`);

        // Делаем запрос к аудио-ссылке, чтобы убедиться, что это аудио
        const audioReq = https.get(audioUrl, { timeout: 15000 }, (audioRes) => {
          const contentType = audioRes.headers['content-type'] || '';
          console.log(`[${videoId}] Audio response status: ${audioRes.statusCode}, Content-Type: ${contentType}`);

          if (audioRes.statusCode !== 200) {
            throw new Error(`Audio stream returned ${audioRes.statusCode}`);
          }

          if (!contentType.startsWith('audio/')) {
            // Если не аудио, возможно, это HTML-страница с ошибкой
            // Прочитаем немного данных и выведем в лог
            let body = '';
            audioRes.on('data', chunk => {
              body += chunk.toString('utf8', 0, 500);
              audioRes.destroy();
            });
            audioRes.on('end', () => {
              console.error(`[${videoId}] Non-audio response: ${body.slice(0, 300)}`);
              throw new Error('Received non-audio content');
            });
            return;
          }

          // Всё хорошо, передаём клиенту
          res.writeHead(200, {
            'Content-Type': 'audio/mp4',
            'X-Audio-Title': encodeURIComponent(item.title || 'youtube_audio'),
          });
          audioRes.pipe(res);
          audioRes.on('end', () => console.log(`[${videoId}] Apify stream finished`));
        });

        audioReq.on('error', (err) => {
          console.error(`[${videoId}] Apify audio request error:`, err.message);
          if (!res.headersSent) {
            fetchWithYtDlpProxy(videoId, res);
          } else {
            res.end();
          }
        });

        audioReq.setTimeout(15000, () => {
          audioReq.destroy();
          if (!res.headersSent) {
            console.error(`[${videoId}] Apify audio timeout, falling back`);
            fetchWithYtDlpProxy(videoId, res);
          }
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

function handleYt(videoId, res) {
  if (APIFY_TOKEN) {
    fetchWithApify(videoId, res);
  } else {
    console.warn(`[${videoId}] APIFY_TOKEN not set, using yt-dlp-proxy only`);
    fetchWithYtDlpProxy(videoId, res);
  }
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
}).listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (APIFY_TOKEN) console.log('🔑 Apify token is set');
  else console.warn('⚠️ APIFY_TOKEN not set, only yt-dlp-proxy fallback will work');
});
