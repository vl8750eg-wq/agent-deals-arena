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
    void afterPropose;

    agentA.ws.send(JSON.stringify({ type: 'post_message', offer: { price: 111, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'Again' }));
    await waitFor(() => agentA.errors.find((e) => e.includes('Not your turn')), 'wrong-turn error');

    // 9. Сходимся в ZOPA через контр-предложения (gate не даёт принять за пределом)
    const agentB = await connectAgent(roomId, 'SIDE_B', agentTokenB);
    await waitFor(() => agentB.states.find((s) => s.messages.length === 1), 'agent B first state');

    agentB.ws.send(JSON.stringify({ type: 'post_message', offer: { price: 140, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'Take 140' }));
    const afterCounter = await waitFor(
      () => agentB.states.find((s) => s.messages.length === 2 && s.nextTurn === 'SIDE_A'),
      'counter propose',
    );
    const counterId = afterCounter.messages[1].id as string;

    // Покупатель не может принять 140 (предел 130) — только контр-предложение
    agentA.ws.send(JSON.stringify({ type: 'post_message', offer: { price: 140, currency: 'USD', terms: [], status: 'ACCEPT', accepts: counterId }, message: 'ok' }));
    await waitFor(() => agentA.errors.find((e) => e.includes('walk-away')), 'accept-over-limit error');

    agentA.ws.send(JSON.stringify({ type: 'post_message', offer: { price: 125, currency: 'USD', terms: [], status: 'PROPOSE' }, message: 'Meet at 125' }));
    const final = await waitFor(
      () => agentA.states.find((s) => s.messages.length === 3 && s.nextTurn === 'SIDE_B'),
      'final propose',
    );
    const finalId = final.messages[2].id as string;

    agentB.ws.send(JSON.stringify({ type: 'post_message', offer: { price: 125, currency: 'USD', terms: [], status: 'ACCEPT', accepts: finalId }, message: 'Deal!' }));
    const done = await waitFor(() => agentB.states.find((s) => s.status === 'DEAL_AGREED'), 'deal agreed');

    expect(done.result).toMatchObject({ status: 'DEAL_AGREED', price: 125, currency: 'USD', acceptedBy: 'SIDE_B' });

    const finalPub = await get(`/api/rooms/${roomId}`);
    expect(finalPub.data.status).toBe('DEAL_AGREED');
    expect(finalPub.data.result.price).toBe(125);

    agentA.ws.close();
    agentB.ws.close();
  });

  it('external LLM agents trade over plain HTTP; walk-away gate holds', async () => {
    const created = await post('/api/rooms', { origin: BASE, lotTitle: 'HTTP gates', maxRounds: 10 });
    expect(created.status).toBe(201);
    const roomId = created.data.roomId as string;
    const ownerA = decodeURIComponent(new URL(created.data.ownerUrlA).hash.match(/owner=([^&]+)/)![1]);
    const invite = decodeURIComponent(new URL(created.data.inviteUrl).hash.match(/invite=([^&]+)/)![1]);

    // Направление условий: A — покупатель, B — продавец
    const badA = await post(`/api/rooms/${roomId}/conditions`, {
      owner: ownerA, conditions: { desiredPrice: 200, walkAwayPrice: 100, notes: '' },
    });
    expect(badA.status).toBe(400);
    const claim = await post(`/api/rooms/${roomId}/claim`, { invite });
    const ownerB = claim.data.ownerToken as string;
    const badB = await post(`/api/rooms/${roomId}/conditions`, {
      owner: ownerB, conditions: { desiredPrice: 100, walkAwayPrice: 200, notes: '' },
    });
    expect(badB.status).toBe(400);

    await post(`/api/rooms/${roomId}/conditions`, {
      owner: ownerA, conditions: { desiredPrice: 100, walkAwayPrice: 130, notes: 'buyer' },
    });
    await post(`/api/rooms/${roomId}/conditions`, {
      owner: ownerB, conditions: { desiredPrice: 150, walkAwayPrice: 120, notes: 'seller' },
    });

    const tokA = (await get(`/api/rooms/${roomId}/view?owner=${encodeURIComponent(ownerA)}`)).data.agentToken as string;
    const tokB = (await get(`/api/rooms/${roomId}/view?owner=${encodeURIComponent(ownerB)}`)).data.agentToken as string;

    // agent-state: чужой токен — 403, свой — свои условия
    expect((await get(`/api/rooms/${roomId}/agent-state?role=SIDE_A&token=nope`)).status).toBe(403);
    const stA = await get(`/api/rooms/${roomId}/agent-state?role=SIDE_A&token=${tokA}`);
    expect(stA.data.ownConditions).toMatchObject({ desiredPrice: 100, walkAwayPrice: 130 });

    const act = (role: string, token: string, offer: unknown, message: string) =>
      post(`/api/rooms/${roomId}/agent-message`, { role, token, offer, message });

    // Покупатель не может предложить выше своего предела
    const over = await act('SIDE_A', tokA, { price: 999, currency: 'USD', terms: [], status: 'PROPOSE' }, 'too much');
    expect(over.status).toBe(400);
    expect(over.data.error).toContain('walk-away');

    // Корректный PROPOSE через HTTP
    const p1 = await act('SIDE_A', tokA, { price: 110, currency: 'USD', terms: [], status: 'PROPOSE' }, 'Take 110');
    expect(p1.status).toBe(200);
    expect(p1.data.nextTurn).toBe('SIDE_B');
    const proposeId = p1.data.messages[0].id as string;

    // ACCEPT с чужой ссылкой отвергается
    const wrongRef = await act('SIDE_B', tokB, { price: 130, currency: 'USD', terms: [], status: 'ACCEPT', accepts: 'no-such-id' }, 'ok');
    expect(wrongRef.status).toBe(400);
    expect(wrongRef.data.error).toContain('ACCEPT must reference');

    // Продавец не может принять ниже своего предела
    const cheap = await act('SIDE_B', tokB, { price: 110, currency: 'USD', terms: [], status: 'ACCEPT', accepts: proposeId }, 'ok');
    expect(cheap.status).toBe(400);

    // Продавец предлагает 140, покупатель не может принять выше своего предела
    const p2 = await act('SIDE_B', tokB, { price: 140, currency: 'USD', terms: [], status: 'PROPOSE' }, 'Take 140');
    expect(p2.status).toBe(200);
    const p2id = p2.data.messages[1].id as string;
    const rich = await act('SIDE_A', tokA, { price: 140, currency: 'USD', terms: [], status: 'ACCEPT', accepts: p2id }, 'ok');
    expect(rich.status).toBe(400);

    // Сходимся в ZOPA: 125
    const p3 = await act('SIDE_A', tokA, { price: 125, currency: 'USD', terms: [], status: 'PROPOSE' }, 'Meet at 125');
    expect(p3.status).toBe(200);
    const p3id = p3.data.messages[2].id as string;
    const fin = await act('SIDE_B', tokB, { price: 125, currency: 'USD', terms: [], status: 'ACCEPT', accepts: p3id }, 'Deal!');
    expect(fin.status).toBe(200);
    expect(fin.data.status).toBe('DEAL_AGREED');
    expect(fin.data.result).toMatchObject({ price: 125, acceptedBy: 'SIDE_B' });
  });
});
