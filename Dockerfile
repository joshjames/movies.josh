FROM node:20-slim

# Install system dependencies (Python, Subliminal, and FFmpeg) in a single optimized layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip \
    python3-venv \
    ffmpeg \
    && pip3 install subliminal --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]