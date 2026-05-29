FROM mirror.gcr.io/library/node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY fake-ollama-server.ts fake-ollama-process.ts ./
EXPOSE 11435
# tsx runs the TS source directly so the container stays in lockstep with
# the canonical fake-ollama-server.ts used by integration tests — no
# separate build step, no risk of the container drifting from the source.
CMD ["npx", "tsx", "fake-ollama-process.ts"]
