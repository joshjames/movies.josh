#!/usr/bin/env bash
# Anyflix Automated Global Deployment Script
# Targets: Cloudflare Workers (Edge) + Docker (Processing Engine)

set -e

echo "🍿 Welcome to the Anyflix Personal Media Server Setup Wizard!"
echo "--------------------------------------------------------"

# Step 1: System Environment & Dependency Verification
echo "🔍 Checking local stack dependencies..."
for cmd in docker npm node; do
    if ! command -v $cmd &> /dev/null; then
        echo "❌ Error: Required dependency '$cmd' is not installed." >&2
        exit 1
    fi
done
echo "✅ Tooling check passed."

# Step 2: Initialize Web Deployment Wizard
# This spins up a temporary high-speed local node web page where the user
# inputs credentials (Storage Keys, Cloudflare Tokens) and selects their Top 100 movies.
echo "🌐 Starting interactive configuration wizard on http://localhost:8080..."
# In production, this runs a minimal wizard server that outputs an 'anyflix.env' file
# and a 'seed_queue.json' based on user check-box selections.
node tools/wizard.js

if [ ! -f "anyflix.env" ]; then
    echo "❌ Deployment aborted: Configuration setup file not generated."
    exit 1
fi

# Export variables for the script context
export $(grep -v '^#' anyflix.env | xargs)

# Step 3: Compile and Deploy Cloudflare Edge Workers
echo "⚡ Provisioning global edge routing tables via Cloudflare..."
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "⚠️ Cloudflare Token missing. Skipping Edge deployment, running local-only."
else
    # Install Cloudflare Wrangler CLI utility locally
    npm install -g wrangler
    
    echo "📦 Deploying Cloudflare KV/D1 Database for tracking metadata states..."
    wrangler kv:namespace create ANYFLIX_METADATA || true
    
    echo "🚀 Pushing Edge Worker script straight to the Cloudflare global network..."
    wrangler deploy src/edge/worker.js --name anyflix-router
fi

# Step 4: Launch the Heavy Ingestion Pipeline via Docker
echo "🐳 Spin-locking localized container blocks for media streaming..."

# Build the processing block base image
docker build -t anyflix-processor:latest .

# Run the container background routine detached, bound to the host storage mapping
docker run -d \
  --name anyflix-engine \
  --env-file anyflix.env \
  -v "$(pwd)/movies:/app/movies" \
  --restart unless-stopped \
  anyflix-processor:latest

# Step 5: Seed the Target Ingestion Queue
if [ -f "seed_queue.json" ]; then
    echo "📥 Injecting movie selections into processing engine loop..."
    docker cp seed_queue.json anyflix-engine:/app/src/data/queue.json
fi

echo "--------------------------------------------------------"
echo "🎉 SUCCESS! Your personal Anyflix ecosystem is fully deployed."
echo "🌍 Frontend Streaming Edge URL: https://anyflix-router.$CLOUDFLARE_SUBDOMAIN.workers.dev"
echo "🎬 The background container is now populating your cloud storage bucket!"
echo "📈 Run 'docker logs -f anyflix-engine' to monitor progress."