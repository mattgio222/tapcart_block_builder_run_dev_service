# Dockerfile for the run-dev service
FROM node:20-slim

WORKDIR /app

# Install tapcart CLI globally
RUN npm install -g @tapcart/tapcart-cli

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
