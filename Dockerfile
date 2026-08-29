FROM node:22-alpine

# Устанавливаем Python, pip, ffmpeg и другие полезные утилиты
RUN apk add --no-cache python3 py3-pip ffmpeg bash

# Скачиваем самую свежую версию yt-dlp и делаем ее исполняемой
RUN wget -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY index.html server.js ./

# Убеждаемся, что yt-dlp установлен и работает
RUN yt-dlp --version

EXPOSE 80
CMD ["node", "server.js"]
