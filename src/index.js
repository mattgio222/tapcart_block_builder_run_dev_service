require('dotenv').config();
const express = require('express');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const net = require('net');

const execPromise = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3002;
const BASE_URL = process.env.BASE_URL || 'http://localhost';

// Session storage: sessionId -> { process, port, blockName, createdAt }
const sessions = new Map();

// Port range for dev servers (internal ports, not exposed externally)
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
const getAvailablePort = async () => {
  for (let port = PORT_START; port <= PORT_END; port++) {
    if (!usedPorts.has(port)) {
      // Check if port is actually available
      const available = await new Promise((resolve) => {
        const server = net.createServer();
        server.listen(port, '0.0.0.0', () => {
          server.close(() => resolve(true));
        });
        server.on('error', () => resolve(false));
      });

      if (available) {
        usedPorts.add(port);
        return port;
      }
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
    // Kill the child process
    if (session.process && !session.process.killed) {
      session.process.kill('SIGTERM');
      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (session.process && !session.process.killed) {
          session.process.kill('SIGKILL');
        }
      }, 5000);
    }

    // Clean up session directory
    const sessionDir = `/tmp/sessions/${sessionId}`;
    await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    console.error(`[CLEANUP] Error:`, err.message);
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
  const port = await getAvailablePort();

  if (!port) {
    return res.status(503).json({ error: 'No available ports' });
  }

  console.log(`[START] Creating session ${sessionId} on port ${port}`);

  try {
    // Create temp directory for this session
    const sessionDir = `/tmp/sessions/${sessionId}`;
    await fs.mkdir(sessionDir, { recursive: true });

    // Write tapcart.config.json first (required before block create)
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

    // Create the block using tapcart CLI (this creates config.json and updates tapcart.config.json)
    console.log(`[${sessionId}] Creating block "${appStudioBlockName}"...`);
    await execPromise(`tapcart block create "${appStudioBlockName}"`, {
      cwd: sessionDir,
      timeout: 60000,
      env: { ...process.env, TAPCART_API_KEY: tapcartCliApiKey }
    });
    console.log(`[${sessionId}] Block created successfully`);

    // Now overwrite code.jsx with the provided code
    const blockDir = `${sessionDir}/blocks/${appStudioBlockName}`;
    await fs.writeFile(`${blockDir}/code.jsx`, codeJsx);

    // Write manifest.json if provided
    if (manifestJson) {
      const manifest = typeof manifestJson === 'string' ? manifestJson : JSON.stringify(manifestJson, null, 2);
      await fs.writeFile(`${blockDir}/manifest.json`, manifest);
    }

    // Spawn tapcart dev server as child process
    const childProcess = spawn('tapcart', ['block', 'dev', '-b', appStudioBlockName, '-p', port.toString()], {
      cwd: sessionDir,
      env: {
        ...process.env,
        TAPCART_API_KEY: tapcartCliApiKey,
        NODE_ENV: 'development'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let serverStarted = false;
    let startError = null;

    // Capture output for debugging
    childProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[${sessionId}] stdout: ${output}`);
      // Check if server started successfully
      if (output.includes('Dev server running') || output.includes('listening') || output.includes('Started')) {
        serverStarted = true;
      }
    });

    childProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.error(`[${sessionId}] stderr: ${output}`);
      if (output.includes('Error') || output.includes('error')) {
        startError = output;
      }
    });

    childProcess.on('error', (err) => {
      console.error(`[${sessionId}] Process error:`, err);
      startError = err.message;
    });

    childProcess.on('exit', (code, signal) => {
      console.log(`[${sessionId}] Process exited with code ${code}, signal ${signal}`);
      // Clean up if process exits unexpectedly
      if (sessions.has(sessionId)) {
        cleanupSession(sessionId);
      }
    });

    // Store session immediately
    sessions.set(sessionId, {
      process: childProcess,
      port,
      blockName: appStudioBlockName,
      configurationId,
      createdAt: Date.now()
    });

    // Wait for server to start (poll for a few seconds)
    const startTime = Date.now();
    const timeout = 15000; // 15 seconds

    while (!serverStarted && !startError && Date.now() - startTime < timeout) {
      // Check if process is still running
      if (childProcess.killed || childProcess.exitCode !== null) {
        startError = 'Process exited unexpectedly';
        break;
      }

      // Try to connect to the port
      const isReady = await new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(port, '127.0.0.1');
      });

      if (isReady) {
        serverStarted = true;
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!serverStarted) {
      await cleanupSession(sessionId);
      return res.status(500).json({
        error: 'Dev server failed to start',
        details: startError || 'Timeout waiting for server'
      });
    }

    // URL for accessing this session via proxy
    const url = `${BASE_URL}/dev/${sessionId}`;
    console.log(`[START] Session ${sessionId} started at ${url} (internal port ${port})`);

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
    sessions.delete(sessionId);
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
      url: `${BASE_URL}/dev/${id}`
    });
  }
  res.json({ sessions: sessionList });
});

// Helper to create proxy for a session
const createSessionProxy = (sessionId, session) => {
  return createProxyMiddleware({
    target: `http://127.0.0.1:${session.port}`,
    changeOrigin: true,
    pathRewrite: (path) => {
      // Remove /dev/sessionId prefix if present
      if (path.startsWith(`/dev/${sessionId}`)) {
        return path.replace(`/dev/${sessionId}`, '') || '/';
      }
      // Remove just /dev/ prefix for cookie-based routing
      if (path.startsWith('/dev/')) {
        return path.replace('/dev/', '/') || '/';
      }
      return path;
    },
    ws: true,
    onProxyRes: (proxyRes, req, res) => {
      // Add CSP header to upgrade HTTP to HTTPS (fixes mixed content issues)
      proxyRes.headers['content-security-policy'] = 'upgrade-insecure-requests';
    },
    onError: (err, req, res) => {
      console.error(`[PROXY] Error for session ${sessionId}:`, err.message);
      if (res.writeHead) {
        res.status(502).json({ error: 'Dev server unavailable' });
      }
    }
  });
};

// Proxy requests to dev sessions: /dev/:sessionId/*
app.use('/dev/:sessionId', (req, res, next) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    // Session ID not found - might be an asset path, try cookie-based routing
    return next();
  }

  // Set cookie to remember this session for subsequent asset requests
  res.cookie('dev_session', sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 60 * 1000 // 30 minutes
  });

  const proxy = createSessionProxy(sessionId, session);
  return proxy(req, res, next);
});

// Fallback: Handle /dev/* requests without valid session ID (asset requests)
// Uses cookie to determine which session to route to
app.use('/dev', (req, res, next) => {
  // Try to get session from cookie
  const cookieHeader = req.headers.cookie || '';
  const sessionMatch = cookieHeader.match(/dev_session=([^;]+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : null;

  if (!sessionId) {
    return res.status(404).json({ error: 'No active session' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session expired' });
  }

  console.log(`[PROXY] Routing ${req.path} to session ${sessionId} via cookie`);
  const proxy = createSessionProxy(sessionId, session);
  return proxy(req, res, next);
});

// Root-level Tapcart API endpoints - route via cookie
// These are requested by the Tapcart dev server's frontend
const tapcartApiEndpoints = ['/modes', '/theme', '/fonts', '/dependencies', '/components', '/currency', '/scope', '/settings', '/collections'];

app.use(tapcartApiEndpoints, (req, res, next) => {
  // Try to get session from cookie
  const cookieHeader = req.headers.cookie || '';
  const sessionMatch = cookieHeader.match(/dev_session=([^;]+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : null;

  if (!sessionId) {
    return res.status(404).json({ error: 'No active session for API request' });
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session expired' });
  }

  console.log(`[PROXY] Routing API ${req.path} to session ${sessionId} via cookie`);

  // Create a simple proxy for root-level requests
  const proxy = createProxyMiddleware({
    target: `http://127.0.0.1:${session.port}`,
    changeOrigin: true,
    onProxyRes: (proxyRes) => {
      proxyRes.headers['content-security-policy'] = 'upgrade-insecure-requests';
    },
    onError: (err) => {
      console.error(`[PROXY] API error for session ${sessionId}:`, err.message);
      res.status(502).json({ error: 'Dev server unavailable' });
    }
  });

  return proxy(req, res, next);
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

process.on('SIGINT', async () => {
  console.log('SIGINT received, cleaning up...');
  for (const sessionId of sessions.keys()) {
    await cleanupSession(sessionId);
  }
  process.exit(0);
});
