FROM node:22-slim

RUN npm install -g openclaw@latest

COPY config/openclaw.json /root/.openclaw/openclaw.json

EXPOSE 18789

CMD ["openclaw", "gateway", "--port", "18789"]
