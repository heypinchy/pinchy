# Pull node:22-slim via Google's Docker Hub mirror to avoid Docker Hub
# anonymous-pull rate limits in CI. mirror.gcr.io is a free, no-auth
# pull-through cache for `library/*` images on Docker Hub.
FROM mirror.gcr.io/library/node:22-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js .

EXPOSE 443 9001
CMD ["node", "server.js"]
