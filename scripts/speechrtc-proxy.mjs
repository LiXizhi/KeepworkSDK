import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

// 轻量加载仓库根目录 .env（无 dotenv 依赖）：仅填充尚未在环境中的键，
// 真密钥只存在于本地 .env（已 .gitignore），不进 Git。
function loadDotEnv() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.resolve(here, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* ignore .env parse errors */ }
}
loadDotEnv();

const preferredPort = Number(process.env.SPEECHRTC_PROXY_PORT || 55002);
const defaultUpstream = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const maxPortAttempts = 10;
// appId 为半公开标识，保留默认值；accessToken 为真密钥，必须来自 .env / 环境变量。
const defaultVolcConfig = {
  appId: process.env.VOLC_APP_ID || '3065448513',
  accessToken: process.env.VOLC_ACCESS_TOKEN || '',
};

let activePort = preferredPort;

function parseRequestUrl(request) {
  const host = request.headers.host || `localhost:${activePort}`;
  return new URL(request.url || '/', `http://${host}`);
}

function writeCorsHeaders(response, contentType) {
  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': contentType,
  });
}

function getUsageHeader(url) {
  const usageTokens = url.searchParams.get('usage_tokens');
  return usageTokens ? usageTokens : null;
}

function createUpstreamHeaders(url) {
  const appKey = url.searchParams.get('app_key') || process.env.VOLC_APP_ID || defaultVolcConfig.appId;
  const accessToken = url.searchParams.get('access_token') || process.env.VOLC_ACCESS_TOKEN || defaultVolcConfig.accessToken;
  const resourceId = url.searchParams.get('resource_id') || 'volc.service_type.10029';
  const connectId = url.searchParams.get('connect_id') || '';

  if (!appKey || !accessToken) {
    throw new Error('Missing app_key or access_token configuration');
  }

  const headers = {
    'X-Api-App-Key': appKey,
    'X-Api-Access-Key': accessToken,
    'X-Api-Resource-Id': resourceId,
  };

  if (connectId) {
    headers['X-Api-Connect-Id'] = connectId;
  }

  const usageHeader = getUsageHeader(url);
  if (usageHeader) {
    headers['X-Control-Require-Usage-Tokens-Return'] = usageHeader;
  }

  return headers;
}

function closePair(clientSocket, upstreamSocket, code = 1011, reason = 'proxy error') {
  if (clientSocket.readyState === WebSocket.OPEN || clientSocket.readyState === WebSocket.CONNECTING) {
    clientSocket.close(code, reason);
  }
  if (upstreamSocket && (upstreamSocket.readyState === WebSocket.OPEN || upstreamSocket.readyState === WebSocket.CONNECTING)) {
    upstreamSocket.close();
  }
}

const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    response.end();
    return;
  }

  const url = parseRequestUrl(request);
  if (url.pathname === '/healthz') {
    writeCorsHeaders(response, 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: true, port: activePort, preferredPort }));
    return;
  }

  writeCorsHeaders(response, 'text/plain; charset=utf-8');
  response.end(`SpeechRTC proxy is running on ws://localhost:${activePort}/tts\nHealth: http://localhost:${activePort}/healthz\n`);
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (clientSocket, request) => {
  const url = parseRequestUrl(request);
  const upstreamUrl = url.searchParams.get('upstream') || defaultUpstream;
  const pendingClientMessages = [];

  let upstreamSocket;
  try {
    upstreamSocket = new WebSocket(upstreamUrl, {
      headers: createUpstreamHeaders(url),
      perMessageDeflate: false,
      rejectUnauthorized: true,
    });
  } catch (error) {
    closePair(clientSocket, null, 1011, 'proxy configuration error');
    return;
  }

  upstreamSocket.on('open', () => {
    while (pendingClientMessages.length > 0 && upstreamSocket.readyState === WebSocket.OPEN) {
      const message = pendingClientMessages.shift();
      upstreamSocket.send(message.data, { binary: message.isBinary });
    }
  });

  upstreamSocket.on('message', (data, isBinary) => {
    if (clientSocket.readyState !== WebSocket.OPEN) return;
    clientSocket.send(data, { binary: isBinary });
  });

  upstreamSocket.on('close', (code, reason) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(code || 1000, reason?.toString() || 'upstream closed');
    }
  });

  upstreamSocket.on('error', (error) => {
    console.error(`[speechrtc-proxy] upstream error: ${error.message}`);
    closePair(clientSocket, upstreamSocket, 1011, 'upstream error');
  });

  clientSocket.on('message', (data, isBinary) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
      return;
    }
    if (upstreamSocket.readyState === WebSocket.CONNECTING) {
      pendingClientMessages.push({ data, isBinary });
    }
  });

  clientSocket.on('close', () => {
    if (upstreamSocket.readyState === WebSocket.OPEN || upstreamSocket.readyState === WebSocket.CONNECTING) {
      upstreamSocket.close();
    }
  });

  clientSocket.on('error', () => {
    if (upstreamSocket.readyState === WebSocket.OPEN || upstreamSocket.readyState === WebSocket.CONNECTING) {
      upstreamSocket.close();
    }
  });
});

server.on('upgrade', (request, socket, head) => {
  const url = parseRequestUrl(request);
  if (url.pathname !== '/tts') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (clientSocket) => {
    wss.emit('connection', clientSocket, request);
  });
});

async function start() {
  try {
    activePort = await new Promise((resolve, reject) => {
      let candidate = preferredPort;
      let attempts = 0;

      const tryNextPort = () => {
        attempts += 1;
        if (attempts > maxPortAttempts) {
          reject(new Error(`Could not find an available port in range ${preferredPort}-${preferredPort + maxPortAttempts - 1}`));
          return;
        }

        const probeServer = http.createServer();
        probeServer.once('error', (error) => {
          probeServer.close(() => {
            if (error && error.code === 'EADDRINUSE') {
              candidate += 1;
              tryNextPort();
              return;
            }
            reject(error);
          });
        });
        probeServer.once('listening', () => {
          const { port } = probeServer.address();
          probeServer.close(() => resolve(port));
        });
        probeServer.listen(candidate, '0.0.0.0');
      };

      tryNextPort();
    });
    server.listen(activePort, '0.0.0.0', () => {
      if (activePort !== preferredPort) {
        console.warn(`[speechrtc-proxy] Port ${preferredPort} is busy; using ${activePort} instead.`);
      }
      console.log(`SpeechRTC proxy listening on ws://localhost:${activePort}/tts`);
      console.log(`Health endpoint: http://localhost:${activePort}/healthz`);
      console.log(`Default Volc credentials: appId=${defaultVolcConfig.appId}, accessToken=${defaultVolcConfig.accessToken ? 'configured' : 'missing'}`);
      console.log('Use testSpeechRTC proxy mode with Proxy URL set to this endpoint.');
    });
  } catch (error) {
    console.error(`[speechrtc-proxy] Failed to start: ${error.message}`);
    process.exitCode = 1;
  }
}

start();