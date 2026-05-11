FROM mirror.gcr.io/library/node:22-slim
WORKDIR /app
COPY package.json ./
COPY server.js ./
EXPOSE 11435
CMD ["node", "server.js"]
