FROM node:18-slim

# Установка ffmpeg и python3-pip
RUN apt-get update && apt-get install -y ffmpeg python3-pip && \
    pip3 install --upgrade yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
