FROM node:20-bullseye

# Install system dependencies
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

# Configure Chromium for Remotion
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install || npm install --legacy-peer-deps

# Copy application code
COPY . .

# Create required directories
RUN mkdir -p /app/renders /app/props

EXPOSE 3000

CMD ["node", "server.js"]
