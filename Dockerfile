FROM node:20-bullseye

# Install Chromium, FFmpeg, and required dependencies
# Why: Remotion needs headless Chrome + FFmpeg for video encoding
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for Remotion
# Why: Remotion needs to find the system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (works with or without lockfile)
# Why: Railway may not have package-lock.json in repo
RUN npm install || npm install --legacy-peer-deps

# Copy application code
COPY . .

# Create directories for renders and props
RUN mkdir -p /app/renders /app/props

EXPOSE 3000

CMD ["node", "server.js"]
