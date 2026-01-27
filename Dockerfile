FROM node:18-bullseye-slim

# 1. Install System Dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    curl \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Copy ONLY package.json
# (We intentionally DO NOT copy package-lock.json to avoid Windows conflicts)
COPY package.json ./

# 3. Fresh Install for Linux
RUN npm install

# 4. Copy the rest of the app
COPY . .

# 5. THE FIX: Force esbuild to download the correct Linux binary
RUN node node_modules/esbuild/install.js || npm rebuild esbuild

# Environment Variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV REMOTION_BROWSER=chromium

EXPOSE 8080

CMD ["node", "server.js"]
