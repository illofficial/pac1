FROM node:22-alpine

WORKDIR /app

# Копируем package.json и package-lock.json (если есть)
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем остальные файлы
COPY index.html server.js ./

EXPOSE 80
CMD ["node", "server.js"]
