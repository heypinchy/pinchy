# Pull node:22-slim via Google's Docker Hub mirror to avoid Docker Hub
# anonymous-pull rate limits in CI. mirror.gcr.io is a free, no-auth
# pull-through cache for `library/*` images on Docker Hub.
FROM mirror.gcr.io/library/node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 9003
CMD ["node", "server.js"]
