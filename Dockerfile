FROM node:18-bullseye-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    curl \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Copy ONLY package files first
COPY package*.json ./

# 2. Install dependencies (Clean install)
# This will now be SAFE because .dockerignore prevents overwriting
RUN npm ci

# 3. Copy the rest of your app code
COPY . .

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV REMOTION_BROWSER=chromium

EXPOSE 8080

CMD ["node", "server.js"]
