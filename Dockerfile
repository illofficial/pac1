FROM node:22-alpine

RUN apk add --no-cache python3 py3-pip ffmpeg && \
    pip3 install --break-system-packages yt-dlp

WORKDIR /app
COPY index.html mastering_chain.js server.js ./
EXPOSE 80
CMD ["node", "server.js"]