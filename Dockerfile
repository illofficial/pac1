FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

# Копируем всё остальное
COPY . .

EXPOSE 80
CMD ["node", "server.js"]
