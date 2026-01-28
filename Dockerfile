FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ffmpeg \
  chromium \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app
COPY . .

RUN npm install

CMD ["npm", "start"]
