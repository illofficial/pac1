FROM node:22-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg bash wget && \
    wget -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

RUN npm install

WORKDIR /app

# Копируем всё, включая cookies.txt
COPY index.html server.js cookies.txt ./

RUN yt-dlp --version

EXPOSE 80
CMD ["node", "server.js"]
