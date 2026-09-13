// Демо полного потока: люди вводят условия через HTTP (как в вебе),
// затем два CLI-агента торгуются, финал виден в observer-снапшоте.
//   node cli/demo.mjs [--server=http://127.0.0.1:8787] [--origin=http://127.0.0.1:8787]
// Требует запущенного `npm run dev:api` (или npm start).

import { spawn } from 'node:child_process';

const rawArgs = Object.fromEntries(
  (process.argv.slice(2) ?? []).map((raw) => {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [raw.replace(/^--/, ''), 'true'];
  }),
);

const httpServer = String(rawArgs.server ?? process.env.SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const origin = String(rawArgs.origin ?? process.env.OBSERVER_ORIGIN ?? httpServer).replace(/\/$/, '');
const wsOrigin = httpServer.replace(/^http/, 'ws');

const post = async (path, body) => {
  const res = await fetch(`${httpServer}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
};

// 1. Человек A создаёт комнату
const room = await post('/api/rooms', { origin, lotTitle: 'Demo lot', maxRounds: 20 });
console.log(`\nRoom ${room.roomId}`);
console.log(`WEB observer: ${room.observerUrl}`);

// 2. Человек A вводит свои условия (покупатель: хочу 100, предел 130)
const ownerA = new URL(room.ownerUrlA).hash.match(/owner=([^&]+)/)?.[1];
const viewA = await (await fetch(`${httpServer}/api/rooms/${room.roomId}/view?owner=${ownerA}`)).json();
await post(`/api/rooms/${room.roomId}/conditions`, {
  owner: decodeURIComponent(ownerA),
  origin,
  conditions: { text: 'Покупаю лот, готов заплатить до 130', desiredPrice: 100, walkAwayPrice: 130 },
});

// 3. Оппонент открывает инвайт и вводит свои условия (продавец: хочу 150, предел 120)
const invite = new URL(room.inviteUrl).hash.match(/invite=([^&]+)/)?.[1];
const claim = await post(`/api/rooms/${room.roomId}/claim`, { invite: decodeURIComponent(invite), origin });
await post(`/api/rooms/${room.roomId}/conditions`, {
  owner: claim.ownerToken,
  origin,
  conditions: { text: 'Продаю лот, отдам от 120', desiredPrice: 150, walkAwayPrice: 120 },
});

// 4. Оба человека отправляют agent-ссылки своим агентам → агенты стартуют в CLI
const agentTokenA = viewA.agentToken;
const viewB = await (await fetch(`${httpServer}/api/rooms/${room.roomId}/view?owner=${claim.ownerToken}`)).json();

const agents = [
  { role: 'SIDE_A', token: agentTokenA, strategy: 'cooperative', name: 'Agent-A(buyer)' },
  { role: 'SIDE_B', token: viewB.agentToken, strategy: 'cooperative', name: 'Agent-B(seller)' },
];

const children = agents.map((agent) =>
  spawn(
    'node',
    [
      'cli/agent.mjs',
      `--server=${wsOrigin}`,
      `--room=${room.roomId}`,
      `--role=${agent.role}`,
      `--token=${agent.token}`,
      `--strategy=${agent.strategy}`,
      `--name=${agent.name}`,
      '--delay-ms=400',
    ],
    { stdio: 'inherit' },
  ),
);

await Promise.all(children.map((child) => new Promise((resolve) => child.on('close', resolve))));

const snapshot = await (await fetch(`${httpServer}/api/rooms/${room.roomId}`)).json();
console.log('\n--- FINAL (web observer snapshot) ---');
console.log(JSON.stringify({ status: snapshot.status, rounds: snapshot.rounds, result: snapshot.result }, null, 2));
if (snapshot.status !== 'DEAL_AGREED') process.exit(1);
