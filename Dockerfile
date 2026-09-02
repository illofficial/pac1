FROM node:22-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg bash wget

# Устанавливаем yt-dlp и yt-dlp-proxy
RUN pip3 install --break-system-packages yt-dlp yt-dlp-proxy

WORKDIR /app
COPY video-download-proxy.js .
COPY package*.json ./
RUN npm install   # теперь не устанавливает ничего, но команда нужна
COPY . .

ENV YTDL_NO_UPDATE=1
EXPOSE 80
CMD ["node", "server.js", "video-download-proxy.js"]
