# Block Builder Run Dev Service

A service that runs Tapcart dev servers for each session, with built-in proxying.

## Architecture

This service:
1. Spawns the Tapcart CLI dev server as a child process for each session
2. Proxies requests to the appropriate dev server based on session ID
3. Automatically cleans up sessions after timeout (30 minutes)

## Requirements

- Node.js 20+
- @tapcart/tapcart-cli (installed globally in the Docker image)

## Local Development

1. Copy `.env.example` to `.env` and configure
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the service:
   ```bash
   npm run dev
   ```

Or with Docker:
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
  "url": "https://your-service.fly.dev/dev/abc123",
  "message": "Dev server started"
}
```

### DELETE /stop-dev/:sessionId
Stop a dev session.

### GET /sessions
List all active sessions (requires API key).

### GET /health
Health check endpoint.

### GET /dev/:sessionId/*
Proxy endpoint - forwards requests to the session's dev server.

## Deployment

### Fly.io (Recommended)
Deploy with:
```bash
fly deploy
```

## Environment Variables

- `PORT`: Service port (default: 3002)
- `BASE_URL`: Base URL for generated session URLs (e.g., https://your-app.fly.dev)
- `SERVICE_API_KEY`: API key for authentication
