FROM node:18-bullseye-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    curl \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. Copy ONLY package.json (Ignore package-lock.json to avoid Windows/Linux conflicts)
COPY package.json ./

# 2. Install dependencies
# Using 'npm install' without a lockfile allows it to resolve fresh for Linux
RUN npm install

# 3. Copy app code
COPY . .

# 4. SAFETY: Rebuild esbuild specifically for Linux (Fixes the "undefined" error)
RUN npm rebuild esbuild

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV REMOTION_BROWSER=chromium

EXPOSE 8080

CMD ["node", "server.js"]
