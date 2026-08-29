FROM node:22-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm install

# Копируем остальные файлы
COPY index.html server.js ./

# Отключаем проверку обновлений ytdl-core
ENV YTDL_NO_UPDATE=1

EXPOSE 80
CMD ["node", "server.js"]
