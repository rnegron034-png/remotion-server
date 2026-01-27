FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
  ffmpeg \
  chromium \
  fonts-liberation \
  libnss3 \
  libxss1 \
  libasound2 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxcomposite1 \
  libxrandr2 \
  libgbm1 \
  libxdamage1 \
  libxshmfence1 \
  libxkbcommon0 \
  libpangocairo-1.0-0 \
  libpango-1.0-0 \
  libcairo2 \
  libgtk-3-0 \
  libx11-xcb1 \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV REMOTION_BROWSER=chromium

WORKDIR /app
COPY package.json package-lock.json* ./

RUN npm install
RUN npm install -g remotion   # <<< THIS WAS MISSING

COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
