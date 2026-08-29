FROM node:22-alpine

WORKDIR /app

# Копируем файлы с зависимостями
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем остальные файлы проекта
COPY index.html server.js ./

# (Опционально) если нужен ffmpeg для других целей, установим
RUN apk add --no-cache ffmpeg

EXPOSE 80
CMD ["node", "server.js"]
