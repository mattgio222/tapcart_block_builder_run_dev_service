require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3002;

// Fly.io API configuration
const FLY_API_URL = process.env.FLY_API_URL || 'https://api.machines.dev/v1';
const FLY_API_TOKEN = process.env.FLY_API_TOKEN;
const FLY_ORG_SLUG = process.env.FLY_ORG_SLUG || 'personal';
const FLY_REGION = process.env.FLY_REGION || 'sjc';
const SESSION_IMAGE = process.env.SESSION_IMAGE || 'registry.fly.io/tapcart-dev-session:latest';

// Session storage: sessionId -> { appName, machineId, url, createdAt }
const sessions = new Map();

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

// Fly API helper
const flyFetch = async (endpoint, options = {}) => {
  const url = `${FLY_API_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${FLY_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`Fly API error (${response.status}): ${JSON.stringify(data)}`);
  }

  return data;
};

// Create a Fly app for a session
const createFlyApp = async (appName) => {
  console.log(`[FLY] Creating app: ${appName}`);
  return flyFetch('/apps', {
    method: 'POST',
    body: JSON.stringify({
      app_name: appName,
      org_slug: FLY_ORG_SLUG,
    }),
  });
};

// Delete a Fly app
const deleteFlyApp = async (appName) => {
  console.log(`[FLY] Deleting app: ${appName}`);
  return flyFetch(`/apps/${appName}?force=true`, {
    method: 'DELETE',
  });
};

// Create a machine in a Fly app
const createMachine = async (appName, config) => {
  console.log(`[FLY] Creating machine in app: ${appName}`);
  return flyFetch(`/apps/${appName}/machines`, {
    method: 'POST',
    body: JSON.stringify(config),
  });
};

// Wait for machine to be ready
const waitForMachine = async (appName, machineId, maxWaitMs = 60000) => {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const machine = await flyFetch(`/apps/${appName}/machines/${machineId}`);
      console.log(`[FLY] Machine ${machineId} state: ${machine.state}`);

      if (machine.state === 'started') {
        return machine;
      }

      if (machine.state === 'failed' || machine.state === 'destroyed') {
        throw new Error(`Machine failed with state: ${machine.state}`);
      }
    } catch (err) {
      if (!err.message.includes('404')) {
        throw err;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error('Timeout waiting for machine to start');
};

// Clean up a session
const cleanupSession = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) return;

  console.log(`[CLEANUP] Cleaning up session ${sessionId}`);

  try {
    await deleteFlyApp(session.appName);
  } catch (err) {
    console.error(`[CLEANUP] Error deleting app:`, err.message);
  }

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

  // Check Fly API token
  if (!FLY_API_TOKEN) {
    return res.status(500).json({ error: 'Fly API token not configured' });
  }

  const sessionId = uuidv4().slice(0, 8);
  const appName = `tapcart-dev-${sessionId}`;

  console.log(`[START] Creating session ${sessionId}`);

  try {
    // Step 1: Create the Fly app
    await createFlyApp(appName);
    console.log(`[START] App ${appName} created`);

    // Step 2: Base64 encode the code files
    const codeJsxB64 = Buffer.from(codeJsx).toString('base64');
    const manifestJsonB64 = manifestJson
      ? Buffer.from(typeof manifestJson === 'string' ? manifestJson : JSON.stringify(manifestJson)).toString('base64')
      : '';

    // Step 3: Create the machine with the session image
    const machineConfig = {
      name: `dev-${sessionId}`,
      region: FLY_REGION,
      config: {
        image: SESSION_IMAGE,
        env: {
          APP_ID: appId,
          BLOCK_NAME: appStudioBlockName,
          TAPCART_API_KEY: tapcartCliApiKey,
          CODE_JSX_B64: codeJsxB64,
          MANIFEST_JSON_B64: manifestJsonB64,
        },
        services: [
          {
            protocol: 'tcp',
            internal_port: 5000,
            ports: [
              {
                port: 80,
                handlers: ['http'],
              },
              {
                port: 443,
                handlers: ['tls', 'http'],
              },
            ],
          },
        ],
        guest: {
          cpu_kind: 'shared',
          cpus: 1,
          memory_mb: 512,
        },
        auto_destroy: true,
      },
    };

    const machine = await createMachine(appName, machineConfig);
    console.log(`[START] Machine ${machine.id} created`);

    // Step 4: Wait for machine to be ready
    await waitForMachine(appName, machine.id);
    console.log(`[START] Machine ${machine.id} is ready`);

    // Step 5: Store session info
    const url = `https://${appName}.fly.dev`;
    sessions.set(sessionId, {
      appName,
      machineId: machine.id,
      url,
      blockName: appStudioBlockName,
      configurationId,
      createdAt: Date.now(),
    });

    // Give the dev server a moment to start
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log(`[START] Session ${sessionId} started at ${url}`);

    res.json({
      success: true,
      sessionId,
      url,
      message: 'Dev server started',
    });

  } catch (error) {
    console.error(`[START] Error:`, error);

    // Try to clean up the app if it was created
    try {
      await deleteFlyApp(appName);
    } catch (cleanupErr) {
      console.error(`[START] Cleanup error:`, cleanupErr.message);
    }

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
      appName: session.appName,
      url: session.url,
      blockName: session.blockName,
      createdAt: session.createdAt,
    });
  }
  res.json({ sessions: sessionList });
});

// Start server
app.listen(PORT, () => {
  console.log('========================================');
  console.log('Block Builder Run Dev Service');
  console.log(`Port: ${PORT}`);
  console.log(`Fly Org: ${FLY_ORG_SLUG}`);
  console.log(`Fly Region: ${FLY_REGION}`);
  console.log(`Session Image: ${SESSION_IMAGE}`);
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

process.on('SIGINT', async () => {
  console.log('SIGINT received, cleaning up...');
  for (const sessionId of sessions.keys()) {
    await cleanupSession(sessionId);
  }
  process.exit(0);
});
