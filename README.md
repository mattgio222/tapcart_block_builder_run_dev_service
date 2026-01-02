# Block Builder Run Dev Service

A containerized service that runs isolated Tapcart dev servers for each session.

## Architecture

Unlike the proxy-based approach, this service:
1. Spins up a separate Docker container for each dev session
2. Each container runs the Tapcart CLI dev server directly
3. Users connect directly to the container's exposed port
4. No proxy complexity - the dev server runs exactly as it would locally

## Requirements

- Docker
- Node.js 20+
- Access to Docker socket (for container management)

## Local Development

1. Copy `.env.example` to `.env` and configure
2. Build the dev container image:
   ```bash
   docker build -t tapcart-dev -f Dockerfile.dev .
   ```
3. Run with docker-compose:
   ```bash
   docker-compose up
   ```

## API Endpoints

### POST /start-dev
Start a new dev session.

**Headers:**
- `X-API-Key`: Service API key

**Body:**
```json
{
  "appId": "string",
  "merchantName": "string",
  "tapcartCliApiKey": "string",
  "codeJsx": "string",
  "manifestJson": "string (optional)",
  "appStudioBlockName": "string",
  "configurationId": "number"
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "abc123",
  "port": 6001,
  "url": "http://localhost:6001",
  "message": "Dev server started"
}
```

### DELETE /stop-dev/:sessionId
Stop a dev session.

### GET /sessions
List all active sessions.

### GET /health
Health check endpoint.

## Deployment Options

### Option 1: Fly.io (Recommended)
Fly.io Machines are designed for this use case - ephemeral VMs that can be spun up on demand.

### Option 2: DigitalOcean/Linode VPS
A VPS with Docker installed gives full control over container management.

### Option 3: Railway with Docker
Railway supports Docker, but may have limitations with Docker-in-Docker.

## Environment Variables

- `PORT`: Service port (default: 3002)
- `BASE_URL`: Base URL for generated session URLs
- `SERVICE_API_KEY`: API key for authentication
