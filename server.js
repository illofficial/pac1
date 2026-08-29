const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 80;
const STATIC = __dirname;

// ----- Прокси-сервисы (порядок важен) -----
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

// ---------- Piped API ----------
function fetchPipedAudio(videoId, res) {
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
          if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`);
          const info = JSON.parse(data);
          if (!info || !info.audioStreams || !info.audioStreams.length) {
            throw new Error('No audio streams');
          }
          const best = info.audioStreams.reduce((a, b) => (a.bitrate || 0) > (b.bitrate || 0) ? a : b);
          const audioUrl = best.url;

          const audioReq = https.get(audioUrl, (audioRes) => {
            if (audioRes.statusCode !== 200) throw new Error(`Audio stream HTTP ${audioRes.statusCode}`);
            res.writeHead(200, {
              'Content-Type': 'audio/mp4',
              'X-Audio-Title': encodeURIComponent(info.title || 'youtube_audio'),
            });
            audioRes.pipe(res);
            audioRes.on('end', () => console.log(`[${videoId}] Piped stream finished`));
          });
          audioReq.on('error', (err) => {
            console.error(`[${videoId}] Piped audio error:`, err.message);
            if (!res.headersSent) { errors.push(`${instance}: ${err.message}`); tryNext(); } else res.end();
          });
          audioReq.setTimeout(15000, () => { audioReq.destroy(); if (!res.headersSent) { errors.push(`${instance}: timeout`); tryNext(); } });
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
    req.setTimeout(10000, () => { req.destroy(); errors.push(`${instance}: timeout`); tryNext(); });
  };
  tryNext();
}

// ---------- yt-dlp-proxy (автоматический подбор прокси) ----------
function fetchYtDlpProxy(videoId, res) {
  console.log(`[${videoId}] Trying yt-dlp-proxy with automatic proxy selection`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Аргументы для yt-dlp-proxy (те же, что и для yt-dlp)
  const args = [
    '-f', 'bestaudio',
    '--no-playlist',
    '--no-check-certificates',
    '--extractor-args', 'youtube:player-client=android', // эмуляция Android
    '-o', '-',
    url,
  ];

  const proc = spawn('yt-dlp-proxy', args, {
    timeout: 180000, // увеличенный таймаут (3 минуты) на поиск прокси
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
    } else if (code !== 0) {
      console.warn(`[${videoId}] yt-dlp-proxy exited with code ${code} after streaming started`);
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
  }, 120000); // 2 минуты на поиск прокси + загрузку
}

// ---------- Invidious ----------
function fetchInvidiousAudio(videoId, res, prevErrors = []) {
  let current = 0;
  const errors = [...prevErrors];

  const tryNext = () => {
    if (current >= INVIDIOUS_INSTANCES.length) {
      console.error(`[${videoId}] All Invidious instances failed, trying yt-dlp Android`);
      return fetchYtDlpAndroid(videoId, res, errors);
    }
    const instance = INVIDIOUS_INSTANCES[current++];
    console.log(`[${videoId}] Trying Invidious: ${instance}`);
    const infoUrl = `${instance}/api/v1/videos/${videoId}`;

    const req = https.get(infoUrl, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`);
          const info = JSON.parse(data);
          if (!info || !info.adaptiveFormats) throw new Error('No adaptive formats');
          const audioFormats = info.adaptiveFormats
            .filter(f => f.type && f.type.startsWith('audio/'))
            .sort((a, b) => (a.bitrate || 0) > (b.bitrate || 0) ? -1 : 1);
          if (!audioFormats.length) throw new Error('No audio streams');
          const best = audioFormats[0];
          const audioUrl = best.url;

          const audioReq = https.get(audioUrl, (audioRes) => {
            if (audioRes.statusCode !== 200) throw new Error(`Audio stream HTTP ${audioRes.statusCode}`);
            res.writeHead(200, {
              'Content-Type': 'audio/mp4',
              'X-Audio-Title': encodeURIComponent(info.title || 'youtube_audio'),
            });
            audioRes.pipe(res);
            audioRes.on('end', () => console.log(`[${videoId}] Invidious stream finished`));
          });
          audioReq.on('error', (err) => {
            console.error(`[${videoId}] Invidious audio error:`, err.message);
            if (!res.headersSent) { errors.push(`${instance}: ${err.message}`); tryNext(); } else res.end();
          });
          audioReq.setTimeout(15000, () => { audioReq.destroy(); if (!res.headersSent) { errors.push(`${instance}: timeout`); tryNext(); } });
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
    req.setTimeout(10000, () => { req.destroy(); errors.push(`${instance}: timeout`); tryNext(); });
  };
  tryNext();
}

// ---------- yt-dlp с эмуляцией Android (основной резерв) ----------
function fetchYtDlpAndroid(videoId, res, prevErrors = []) {
  console.log(`[${videoId}] Trying yt-dlp with Android emulation`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const args = [
    '-f', 'bestaudio',
    '--no-playlist',
    '--no-check-certificates',
    '--extractor-args', 'youtube:player-client=android',
    '-o', '-',
    url,
  ];

  const proc = spawn('yt-dlp', args, {
    timeout: 120000,
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
      console.log(`[${videoId}] yt-dlp headers sent (Android mode)`);
    }
  };

  proc.stdout.on('data', (chunk) => {
    sendHeaders();
    res.write(chunk);
  });
  proc.stdout.on('end', () => {
    if (headersSent) {
      res.end();
      console.log(`[${videoId}] yt-dlp finished`);
    } else {
      console.error(`[${videoId}] yt-dlp no data`);
      if (!res.headersSent) {
        res.writeHead(503);
        res.end('All video services unavailable');
      }
    }
  });
  proc.stderr.on('data', (d) => {
    console.error(`[${videoId}] yt-dlp stderr:`, d.toString());
  });
  proc.on('error', (err) => {
    console.error(`[${videoId}] ytdl-core error:`, err.message);
    if (!headersSent && !res.headersSent) {
      // Если ytdl-core с cookies не сработал, пробуем yt-dlp-proxy
      return fetchYtDlpProxy(videoId, res);
    } else {
      res.end();
    }
  });
  // proc.on('error', (err) => {
  //   console.error(`[${videoId}] yt-dlp spawn error:`, err.message);
  //   if (!headersSent && !res.headersSent) {
  //     res.writeHead(503);
  //     res.end('All video services unavailable');
  //   } else {
  //     res.end();
  //   }
  // });
  proc.on('close', (code) => {
    if (code !== 0 && !headersSent) {
      console.error(`[${videoId}] yt-dlp exit code ${code}`);
      if (!res.headersSent) {
        res.writeHead(503);
        res.end('All video services unavailable');
      }
    }
  });
  const timeout = setTimeout(() => {
    if (!headersSent) {
      console.error(`[${videoId}] yt-dlp timeout`);
      proc.kill();
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
  if (!path.extname(filePath)) filePath = path.join(STATIC, 'index.html');
  serveFile(res, filePath);
}).listen(PORT, () => console.log(`Server running on port ${PORT} (Piped + Invidious + yt-dlp Android fallback)`));
