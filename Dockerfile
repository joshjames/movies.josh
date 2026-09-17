FROM node:20-slim

# Install system dependencies (Python, Subliminal, FFmpeg, and rsync/ssh for
# the scheduler-worker's LA->satellite metadata mirror) in a single optimized layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip \
    python3-venv \
    ffmpeg \
    rsync \
    openssh-client \
    && pip3 install subliminal --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]