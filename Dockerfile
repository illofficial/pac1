FROM node:22-alpine

# Устанавливаем Python, pip, ffmpeg, и необходимые утилиты
RUN apk add --no-cache python3 py3-pip ffmpeg bash wget

RUN pip3 install --no-cache-dir --upgrade pip
RUN pip3 install --no-cache-dir yt-dlp yt-dlp-proxy

# Устанавливаем yt-dlp и yt-dlp-proxy
RUN pip3 install --no-cache-dir yt-dlp yt-dlp-proxy

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

ENV YTDL_NO_UPDATE=1
EXPOSE 80
CMD ["node", "server.js"]
