// Сквозной тест реальной архитектуры: HTTP API людей + WS CLI-агентов.
// Поднимает server.mjs на тестовом порту и прогоняет весь поток:
// создание → условия A → инвайт B → условия B → торг агентов → DEAL_AGREED,
// плюс негативные кейсы (чужие токены, чужой ход, битый ACCEPT).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildProcess, spawn } from 'node:child_process';
import WebSocket, { type RawData } from 'ws';

const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;

let server: ChildProcess;

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};

const get = async (path: string) => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('Test server did not start.');
    await new Promise((r) => setTimeout(r, 200));
  }
}

type WsClient = { ws: WebSocket; states: any[]; errors: string[] };

function connectAgent(roomId: string, role: string, token: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?room=${roomId}&role=${role}&token=${token}`);
    const client: WsClient = { ws, states: [], errors: [] };
    ws.on('message', (raw: RawData) => {
      try {
        const payload = JSON.parse(raw.toString());
        if (payload.type === 'error') client.errors.push(payload.error);
        else if (payload.type === 'room_state') client.states.push(payload);
      } catch { /* noop */ }
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

async function waitFor<T>(getIt: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = getIt();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  server = spawn('node', ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForHealth();
});

afterAll(() => {
  server?.kill();
});

describe('arena full flow', () => {
  it('humans create room, enter conditions; agents negotiate; observers see the deal', async () => {
    // 1. Человек A создаёт комнату
    const created = await post('/api/rooms', { origin: BASE, lotTitle: 'Test lot', maxRounds: 10 });
    expect(created.status).toBe(201);
    const roomId = created.data.roomId as string;
    expect(created.data.ownerUrlA).toContain('owner=');
    expect(created.data.inviteUrl).toContain('invite=');

    const ownerA = new URL(created.data.ownerUrlA).hash.match(/owner=([^&]+)/)![1];
    const invite = new URL(created.data.inviteUrl).hash.match(/invite=([^&]+)/)![1];

    // 2. Чужие токены не проходят
    expect((await get(`/api/rooms/${roomId}/view?owner=nope`)).status).toBe(403);
    expect((await post(`/api/rooms/${roomId}/conditions`, { owner: 'nope', conditions: { desiredPrice: 1, walkAwayPrice: 2, notes: '' } })).status).toBe(400);
    expect((await post(`/api/rooms/${roomId}/claim`, { invite: 'nope' })).status).toBe(400);

    // 3. Человек A вводит условия
    const viewA0 = await get(`/api/rooms/${roomId}/view?owner=${ownerA}`);
    expect(viewA0.data.role).toBe('SIDE_A');
    expect(viewA0.data.ownConditions).toBeNull();
    const agentTokenA = viewA0.data.agentToken as string;

    const condA = await post(`/api/rooms/${roomId}/conditions`, {
      owner: decodeURIComponent(ownerA),
      conditions: { desiredPrice: 100, walkAwayPrice: 130, notes: 'buyer' },
    });
    expect(condA.data.status).toBe('WAITING_FOR_SUBMISSIONS');

    // 4. Оппонент принимает инвайт и вводит условия
    const claim = await post(`/api/rooms/${roomId}/claim`, { invite: decodeURIComponent(invite) });
    expect(claim.status).toBe(200);
    const ownerB = claim.data.ownerToken as string;

    const condB = await post(`/api/rooms/${roomId}/conditions`, {
      owner: ownerB,
      conditions: { desiredPrice: 150, walkAwayPrice: 120, notes: 'seller' },
    });
    expect(condB.data.status).toBe('IN_NEGOTIATION');

    const viewB = await get(`/api/rooms/${roomId}/view?owner=${ownerB}`);
    const agentTokenB = viewB.data.agentToken as string;

    // 5. Наблюдатель: торг идёт, приватного ничего нет
    const pub = await get(`/api/rooms/${roomId}`);
    expect(pub.data.status).toBe('IN_NEGOTIATION');
    const serialized = JSON.stringify(pub.data);
    expect(serialized).not.toContain('agentToken');
    expect(serialized).not.toContain('ownerToken');
    expect(serialized).not.toContain('inviteToken');
    expect(serialized).not.toContain('buyer');

    // 6. Агент с чужим токеном: handshake проходит, но сервер сразу закрывает без room_state
    const bad = await connectAgent(roomId, 'SIDE_A', 'bad-token');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bad-token socket was not closed')), 5000);
      bad.ws.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    expect(bad.states.length).toBe(0);

    // 7. Агент A видит только свои условия
    const agentA = await connectAgent(roomId, 'SIDE_A', agentTokenA);
    const stateA = await waitFor(() => agentA.states.find((s) => s.ownConditions), 'agent A conditions');
    expect(stateA.ownConditions.desiredPrice).toBe(100);
    expect(JSON.stringify(stateA)).not.toContain('seller');

    // 8. Агент A предлагает; повторный ход вне очереди — ошибка
    agentA.ws.send(JSON.stringify({ type: 'post_message', offer: { price: 110, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'Take 110' }));
    const afterPropose = await waitFor(
      () => agentA.states.find((s) => s.messages.length === 1 && s.nextTurn === 'SIDE_B'),
      'turn flip to B',
    );
    const proposeId = afterPropose.messages[0].id as string;

    agentA.ws.send(JSON.stringify({ type: 'post_message', offer: { price: 111, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'Again' }));
    await waitFor(() => agentA.errors.find((e) => e.includes('Not your turn')), 'wrong-turn error');

    // 9. Агент B: битый ACCEPT отвергается, корректный — завершает сделкой
    const agentB = await connectAgent(roomId, 'SIDE_B', agentTokenB);
    await waitFor(() => agentB.states.find((s) => s.messages.length === 1), 'agent B first state');

    agentB.ws.send(JSON.stringify({ type: 'post_message', offer: { price: 120, currency: 'USD', terms: [], status: 'ACCEPT', accepts: 'wrong-id' }, message: 'Deal?' }));
    await waitFor(() => agentB.errors.find((e) => e.includes('ACCEPT must reference')), 'bad-accept error');

    agentB.ws.send(JSON.stringify({ type: 'post_message', offer: { price: 110, currency: 'USD', terms: [], status: 'ACCEPT', accepts: proposeId }, message: 'Deal!' }));
    const done = await waitFor(() => agentB.states.find((s) => s.status === 'DEAL_AGREED'), 'deal agreed');

    expect(done.result).toMatchObject({ status: 'DEAL_AGREED', price: 110, currency: 'USD', acceptedBy: 'SIDE_B' });

    const finalPub = await get(`/api/rooms/${roomId}`);
    expect(finalPub.data.status).toBe('DEAL_AGREED');
    expect(finalPub.data.result.price).toBe(110);

    agentA.ws.close();
    agentB.ws.close();
  });
});
