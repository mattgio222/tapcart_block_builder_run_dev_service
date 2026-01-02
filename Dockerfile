# Dockerfile for the orchestrator service
# This service manages Fly Machines for each dev session

FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source
COPY src ./src

EXPOSE 3002

CMD ["node", "src/index.js"]
