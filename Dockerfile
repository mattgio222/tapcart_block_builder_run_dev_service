# Dockerfile for the orchestrator service
FROM node:20-slim

# Install Docker CLI (for managing dev containers)
RUN apt-get update && apt-get install -y \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source
COPY src ./src

# Create sessions directory
RUN mkdir -p /tmp/sessions

EXPOSE 3002

CMD ["node", "src/index.js"]
