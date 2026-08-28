FROM node:18-bookworm-slim

# Устанавливаем ffmpeg, python3 и pip
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    --no-install-recommends && \
    pip3 install --upgrade yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
