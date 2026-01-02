# Block Builder Run Dev Service

A service that creates isolated Fly Machines for each Tapcart dev session.

## Architecture

This service uses the Fly Machines API to:
1. Create a new Fly app for each dev session
2. Spin up a machine running the Tapcart CLI dev server
3. Each session gets its own public URL (e.g., `https://tapcart-dev-abc123.fly.dev`)
4. Clean up machines and apps after session timeout

No proxying required - each session runs independently with its own domain.

## Prerequisites

- Fly.io account with API token
- Docker (for building the session image)
- The session image pushed to Fly's registry

## Setup

### 1. Create a Fly app for the session image

First, create an app to host the session image in Fly's registry:

```bash
fly apps create tapcart-dev-session
```

### 2. Build and push the session image

```bash
# Build the session image
npm run build-session-image

# Authenticate with Fly's Docker registry and push
npm run push-session-image
```

### 3. Deploy the orchestrator

```bash
fly deploy
```

### 4. Set environment variables

In Fly.io dashboard or via CLI:

```bash
fly secrets set SERVICE_API_KEY=your-api-key
fly secrets set FLY_API_TOKEN=$(fly tokens create deploy)
fly secrets set FLY_ORG_SLUG=your-org-slug
fly secrets set FLY_REGION=sjc
fly secrets set SESSION_IMAGE=registry.fly.io/tapcart-dev-session:latest
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
  "url": "https://tapcart-dev-abc123.fly.dev",
  "message": "Dev server started"
}
```

### DELETE /stop-dev/:sessionId
Stop a dev session and clean up resources.

### GET /sessions
List all active sessions (requires API key).

### GET /health
Health check endpoint.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Service port | `3002` |
| `SERVICE_API_KEY` | API key for authentication | Required |
| `FLY_API_TOKEN` | Fly.io API token | Required |
| `FLY_ORG_SLUG` | Fly.io organization slug | `personal` |
| `FLY_REGION` | Region for session machines | `sjc` |
| `SESSION_IMAGE` | Docker image for sessions | `registry.fly.io/tapcart-dev-session:latest` |

## How It Works

1. When `/start-dev` is called:
   - Creates a new Fly app with a unique name
   - Base64-encodes the code files
   - Creates a machine with the session image
   - The machine decodes files and starts `tapcart block dev`
   - Returns the app's public URL

2. Session cleanup:
   - Sessions automatically expire after 30 minutes
   - Or when `/stop-dev/:sessionId` is called
   - The Fly app and machine are deleted

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your values
npm run dev
```
