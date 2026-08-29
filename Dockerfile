FROM node:22-alpine
WORKDIR /app
COPY index.html mastering_chain.js server.js ./
EXPOSE 80
CMD ["node", "server.js"]