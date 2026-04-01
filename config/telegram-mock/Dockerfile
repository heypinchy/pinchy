FROM node:22-slim

RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js .

EXPOSE 443 9001
CMD ["node", "server.js"]
