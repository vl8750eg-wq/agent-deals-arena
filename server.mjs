// Agent Deals Arena — room server.
//
// Поток:
//  1. Человек A создаёт комнату в вебе  → получает свою owner-ссылку + инвайт для B.
//  2. A вводит свои условия в вебе      → получает agent-ссылку для своего агента.
//  3. B открывает инвайт, вводит свои   → получает agent-ссылку для своего агента.
//  4. Оба агента торгуются из CLI (WS), оба человека смотрят веб-наблюдатель (SSE).
//
// Разделение доступа:
//  - owner token  — человек (веб): свои условия + своя agent-ссылка.
//  - agent token  — CLI-агент (WS): только свои условия + публичные ходы.
//  - invite token — однократный обмен на owner-токен стороны B.
//  - наблюдатель  — ничего приватного: ни токенов, ни условий.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createStore } from './server/store.mjs';

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 8787);
const DEFAULT_MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? 20);
const publicDirectory = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');

const store = createStore();
const wsClients = new Set();
const sseClients = new Set();

setInterval(() => store.purge(), 10 * 60 * 1000).unref();

const setCors = (response) => {
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type');
};

const sendJson = (response, status, body) => {
  setCors(response);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

const readJson = (request) => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 100_000) reject(new Error('Request is too large.'));
  });
  request.on('end', () => {
    if (!body) return resolve({});
    try {
      resolve(JSON.parse(body));
    } catch {
      reject(new Error('Invalid JSON.'));
    }
  });
  request.on('error', reject);
});

const abs = (origin, hash) => `${String(origin).replace(/\/$/, '')}/${hash.startsWith('#') ? hash : `#${hash}`}`;

const broadcastRoom = (roomId) => {
  const room = store._get(roomId);
  if (!room) return;
  for (const client of wsClients) {
    if (client.roomId === roomId && client.readyState === 1) {
      try {
        client.send(JSON.stringify(store.agentState(roomId, client.role)));
      } catch { /* noop */ }
    }
  }
  const snapshot = JSON.stringify(store.publicSnapshot(room));
  for (const observer of sseClients) {
    if (observer.roomId === roomId) {
      try {
        observer.res.write(`event: room_state\ndata: ${snapshot}\n\n`);
      } catch { /* уберём на close */ }
    }
  }
};

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const serveFrontend = (request, response) => {
  if (request.method !== 'GET') return false;
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/') || pathname === '/ws') return false;
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(join(publicDirectory, requestedPath));
  const filePath = safePath.startsWith(publicDirectory) && existsSync(safePath) && statSync(safePath).isFile()
    ? safePath
    : join(publicDirectory, 'index.html');

  if (!existsSync(filePath)) return false;
  response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
  return true;
};

const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');

  if (request.method === 'OPTIONS') {
    setCors(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    return sendJson(response, 200, { ok: true, rooms: store.size() });
  }

  // --- 1. Человек A создаёт комнату ---
  if (request.method === 'POST' && url.pathname === '/api/rooms') {
    try {
      const input = await readJson(request);
      const room = store.createRoom({ lotTitle: input.lotTitle, maxRounds: input.maxRounds ?? DEFAULT_MAX_ROUNDS });
      const origin = typeof input.origin === 'string' ? input.origin : 'http://127.0.0.1:5173';
      const sideA = room.sides.SIDE_A;
      return sendJson(response, 201, {
        roomId: room.id,
        lotTitle: room.lotTitle,
        maxRounds: room.maxRounds,
        ownerUrlA: abs(origin, `r=${room.id}&owner=${sideA.ownerToken}`),
        inviteUrl: abs(origin, `r=${room.id}&invite=${room.inviteToken}`),
        observerUrl: abs(origin, `r=${room.id}`),
      });
    } catch (error) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : 'Could not create room.' });
    }
  }

  // --- 3. Оппонент обменивает инвайт на свою owner-ссылку ---
  const claimMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/claim$/);
  if (request.method === 'POST' && claimMatch) {
    try {
      const input = await readJson(request);
      const roomId = decodeURIComponent(claimMatch[1]);
      const { side, ownerToken } = store.claimInvite(roomId, input.invite);
      const origin = typeof input.origin === 'string' ? input.origin : 'http://127.0.0.1:5173';
      return sendJson(response, 200, {
        side,
        ownerToken,
        ownerUrl: abs(origin, `r=${roomId}&owner=${ownerToken}`),
      });
    } catch (error) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : 'Could not claim invite.' });
    }
  }

  // --- 2/3. Владелец смотрит свою сторону / вводит условия ---
  const viewMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/view$/);
  if (request.method === 'GET' && viewMatch) {
    try {
      return sendJson(response, 200, store.ownerSnapshot(decodeURIComponent(viewMatch[1]), url.searchParams.get('owner') ?? ''));
    } catch (error) {
      return sendJson(response, 403, { error: error instanceof Error ? error.message : 'Forbidden.' });
    }
  }

  const condMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/conditions$/);
  if (request.method === 'POST' && condMatch) {
    try {
      const input = await readJson(request);
      const roomId = decodeURIComponent(condMatch[1]);
      const { side, status } = store.setConditions(roomId, input.owner, input.conditions);
      broadcastRoom(roomId);
      const origin = typeof input.origin === 'string' ? input.origin : null;
      const agentHash = store.ownerSnapshot(roomId, input.owner).agentHash;
      return sendJson(response, 200, {
        side,
        status,
        agentHash,
        agentUrl: origin ? abs(origin, agentHash) : null,
      });
    } catch (error) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : 'Could not save conditions.' });
    }
  }

  // --- 4. Наблюдатель: публичный снапшот и SSE-лента ---
  const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)(\/stream)?$/);
  if (request.method === 'GET' && roomMatch) {
    const room = store._get(decodeURIComponent(roomMatch[1]));
    if (!room) return sendJson(response, 404, { error: 'Room not found.' });

    if (roomMatch[2] === '/stream') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      const observer = { res: response, roomId: room.id };
      sseClients.add(observer);
      response.write(`event: room_state\ndata: ${JSON.stringify(store.publicSnapshot(room))}\n\n`);
      const heartbeat = setInterval(() => {
        try { response.write(': ping\n\n'); } catch { /* noop */ }
      }, 20_000);
      request.on('close', () => {
        clearInterval(heartbeat);
        sseClients.delete(observer);
      });
      return;
    }

    return sendJson(response, 200, store.publicSnapshot(room));
  }

  if (serveFrontend(request, response)) return;

  return sendJson(response, 404, { error: 'Not found.' });
});

// --- 4. WebSocket: только CLI-агенты со своим agent-токеном ---
const websocketServer = new WebSocketServer({ noServer: true });

websocketServer.on('connection', (client, _request, auth) => {
  try {
    const room = store._get(auth.roomId);
    if (!room) {
      client.close();
      return;
    }
    if (room.sides[auth.role]?.agentToken !== auth.token) {
      client.close();
      return;
    }
  } catch {
    client.close();
    return;
  }
  client.roomId = auth.roomId;
  client.role = auth.role;
  wsClients.add(client);
  store.setAgentOnline(auth.roomId, auth.role, true);
  client.send(JSON.stringify(store.agentState(auth.roomId, auth.role)));
  broadcastRoom(auth.roomId);

  client.on('message', (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      if (payload.type !== 'post_message') {
        client.send(JSON.stringify({ type: 'error', error: 'Unknown room action.' }));
        return;
      }
      store.postMessage(auth.roomId, auth.role, auth.token, payload);
      broadcastRoom(auth.roomId);
    } catch (error) {
      client.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Invalid room action.' }));
    }
  });

  client.on('close', () => {
    wsClients.delete(client);
    store.setAgentOnline(auth.roomId, auth.role, false);
    broadcastRoom(auth.roomId);
  });
});

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (!url.pathname.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  const roomId = url.searchParams.get('room');
  const role = url.searchParams.get('role');
  const token = url.searchParams.get('token');

  if (!roomId || !['SIDE_A', 'SIDE_B'].includes(role ?? '') || !token) {
    socket.destroy();
    return;
  }

  websocketServer.handleUpgrade(request, socket, head, (client) => {
    websocketServer.emit('connection', client, request, { roomId, role, token });
  });
});

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Arena server listening on port ${port}`);
  console.log('Humans: create a room in the web UI, enter conditions, share the invite.');
  console.log('Agents: node cli/agent.mjs --room=<id> --role=SIDE_A|SIDE_B --token=<agent-token>');
});
