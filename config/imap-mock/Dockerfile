FROM mirror.gcr.io/library/node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 9006
CMD ["node", "server.js"]
