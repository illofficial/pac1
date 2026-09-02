const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.VIDEO_DOWNLOAD_API_KEY; // ваш API-ключ
const API_BASE = 'https://p.savenow.to';

// Создаём сервер
const server = http.createServer((req, res) => {
    // Разбираем URL
    const parsedUrl = url.parse(req.url, true);
    const path = parsedUrl.pathname;

    // CORS заголовки
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // --- Эндпоинт: скачивание ---
    if (path === '/download' && req.method === 'GET') {
        const videoUrl = parsedUrl.query.url;
        const format = parsedUrl.query.format || 'mp3'; // mp3, mp4, mp44k и др.

        if (!videoUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing "url" parameter' }));
            return;
        }

        // Формируем запрос к API
        const apiParams = new URLSearchParams({
            url: videoUrl,
            format: format,
            apikey: API_KEY,
            add_info: '1',
            allow_extended_duration: '1',
            no_merge: '0'
        });

        const apiUrl = `${API_BASE}/ajax/download.php?${apiParams}`;

        https.get(apiUrl, (apiRes) => {
            let data = '';
            apiRes.on('data', chunk => data += chunk);
            apiRes.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        jobId: json.id,
                        progressUrl: `${API_BASE}/ajax/progress.php?id=${json.id}`
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

    // --- Эндпоинт: статус ---
    if (path === '/status' && req.method === 'GET') {
        const jobId = parsedUrl.query.id;

        if (!jobId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing "id" parameter' }));
            return;
        }

        const apiUrl = `${API_BASE}/ajax/progress.php?id=${jobId}`;

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

    // --- Корневой путь ---
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        service: 'Video Download API Proxy',
        endpoints: {
            download: '/download?url=VIDEO_URL&format=mp3',
            status: '/status?id=JOB_ID'
        }
    }));
});

server.listen(PORT, () => {
    console.log(`🚀 Video download proxy running on port ${PORT}`);
});
