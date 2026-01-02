require('dotenv').config();
const express = require('express');
const Docker = require('dockerode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const docker = new Docker();
const PORT = process.env.PORT || 3002;
const BASE_URL = process.env.BASE_URL || 'http://localhost';

// Session storage: sessionId -> { containerId, port, blockName, createdAt }
const sessions = new Map();

// Port range for dev containers
const PORT_START = 6001;
const PORT_END = 6020;
const usedPorts = new Set();

// Session timeout (30 minutes)
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

// Get available port
const getAvailablePort = () => {
  for (let port = PORT_START; port <= PORT_END; port++) {
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  return null;
};

// Release port
const releasePort = (port) => {
  usedPorts.delete(port);
};

// Clean up a session
const cleanupSession = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) return;

  console.log(`[CLEANUP] Cleaning up session ${sessionId}`);

  try {
    const container = docker.getContainer(session.containerId);
    await container.stop({ t: 5 }).catch(() => {});
    await container.remove({ force: true }).catch(() => {});
  } catch (err) {
    console.error(`[CLEANUP] Error removing container:`, err.message);
  }

  releasePort(session.port);
  sessions.delete(sessionId);
  console.log(`[CLEANUP] Session ${sessionId} cleaned up`);
};

// Periodic cleanup of expired sessions
setInterval(async () => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT_MS) {
      console.log(`[TIMEOUT] Session ${sessionId} expired`);
      await cleanupSession(sessionId);
    }
  }
}, 60000);

// API Key authentication
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.SERVICE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Start dev session
app.post('/start-dev', authenticateApiKey, async (req, res) => {
  const {
    appId,
    merchantName,
    tapcartCliApiKey,
    codeJsx,
    manifestJson,
    appStudioBlockName,
    configurationId
  } = req.body;

  // Validate required fields
  if (!appId || !merchantName || !tapcartCliApiKey || !codeJsx || !appStudioBlockName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sessionId = uuidv4().slice(0, 8);
  const port = getAvailablePort();

  if (!port) {
    return res.status(503).json({ error: 'No available ports' });
  }

  console.log(`[START] Creating session ${sessionId} on port ${port}`);

  try {
    // Create temp directory for this session
    const sessionDir = `/tmp/sessions/${sessionId}`;
    const blockDir = `${sessionDir}/blocks/${appStudioBlockName}`;
    await fs.mkdir(blockDir, { recursive: true });

    // Write code.jsx
    await fs.writeFile(`${blockDir}/code.jsx`, codeJsx);

    // Write manifest.json if provided
    if (manifestJson) {
      const manifest = typeof manifestJson === 'string' ? manifestJson : JSON.stringify(manifestJson, null, 2);
      await fs.writeFile(`${blockDir}/manifest.json`, manifest);
    }

    // Write tapcart.config.json
    await fs.writeFile(`${sessionDir}/tapcart.config.json`, JSON.stringify({
      appId,
      dependencies: {}
    }, null, 2));

    // Write package.json
    await fs.writeFile(`${sessionDir}/package.json`, JSON.stringify({
      name: "tapcart-dev",
      version: "1.0.0",
      private: true
    }, null, 2));

    // Create and start Docker container
    const container = await docker.createContainer({
      Image: 'node:20-slim',
      Cmd: [
        'sh', '-c',
        `npm install -g @tapcart/tapcart-cli && tapcart block dev -b "${appStudioBlockName}" -p 5000`
      ],
      Env: [
        `TAPCART_API_KEY=${tapcartCliApiKey}`,
        `NODE_ENV=development`
      ],
      ExposedPorts: { '5000/tcp': {} },
      HostConfig: {
        PortBindings: { '5000/tcp': [{ HostPort: port.toString() }] },
        Binds: [`${sessionDir}:/app`],
        AutoRemove: false
      },
      WorkingDir: '/app',
      name: `tapcart-dev-${sessionId}`
    });

    await container.start();

    // Store session
    sessions.set(sessionId, {
      containerId: container.id,
      port,
      blockName: appStudioBlockName,
      configurationId,
      createdAt: Date.now()
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check if container is still running
    const containerInfo = await container.inspect();
    if (!containerInfo.State.Running) {
      await cleanupSession(sessionId);
      return res.status(500).json({ error: 'Dev server failed to start' });
    }

    const url = `${BASE_URL}:${port}`;
    console.log(`[START] Session ${sessionId} started at ${url}`);

    res.json({
      success: true,
      sessionId,
      port,
      url,
      message: 'Dev server started'
    });

  } catch (error) {
    console.error(`[START] Error:`, error);
    releasePort(port);
    res.status(500).json({ error: 'Failed to start dev server', details: error.message });
  }
});

// Stop dev session
app.delete('/stop-dev/:sessionId', authenticateApiKey, async (req, res) => {
  const { sessionId } = req.params;

  if (!sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  await cleanupSession(sessionId);
  res.json({ success: true, message: 'Session stopped' });
});

// List sessions
app.get('/sessions', authenticateApiKey, (req, res) => {
  const sessionList = [];
  for (const [id, session] of sessions.entries()) {
    sessionList.push({
      sessionId: id,
      port: session.port,
      blockName: session.blockName,
      createdAt: session.createdAt,
      url: `${BASE_URL}:${session.port}`
    });
  }
  res.json({ sessions: sessionList });
});

// Start server
app.listen(PORT, () => {
  console.log('========================================');
  console.log('Block Builder Run Dev Service');
  console.log(`Port: ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('========================================');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, cleaning up...');
  for (const sessionId of sessions.keys()) {
    await cleanupSession(sessionId);
  }
  process.exit(0);
});
