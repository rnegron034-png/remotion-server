FROM node:18-bullseye-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    curl \
    fonts-noto-color-emoji \
    libnss3 \
    libdbus-1-3 \
    libatk1.0-0 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Skip Puppeteer's heavy Chromium download (we use the installed system one)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV REMOTION_BROWSER=chromium

COPY package*.json ./

# 2. Ensure we install dependencies properly
RUN npm install

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
