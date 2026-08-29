FROM node:22-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg bash wget && \
    wget -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

ENV YTDL_NO_UPDATE=1
EXPOSE 80
CMD ["node", "server.js"]
