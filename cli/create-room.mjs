// Человек A создаёт комнату из терминала (тот же результат, что кнопка в вебе).
//   node cli/create-room.mjs [--server=http://127.0.0.1:8787] [--origin=...] [--title="Ноутбук"] [--max-rounds=20]

const rawArgs = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [raw.replace(/^--/, ''), 'true'];
  }),
);

const httpServer = String(rawArgs.server ?? process.env.SERVER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const origin = String(rawArgs.origin ?? process.env.OBSERVER_ORIGIN ?? httpServer).replace(/\/$/, '');

const response = await fetch(`${httpServer}/api/rooms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    origin,
    lotTitle: String(rawArgs.title ?? ''),
    maxRounds: Number(rawArgs['max-rounds'] ?? 20),
  }),
});
const payload = await response.json();
if (!response.ok) {
  console.error('Could not create room:', payload.error ?? response.statusText);
  process.exit(1);
}

console.log(`\nRoom: ${payload.roomId}${payload.lotTitle ? ` — ${payload.lotTitle}` : ''}`);
console.log(`\n1. ВАША owner-ссылка (введите свои условия):\n  ${payload.ownerUrlA}`);
console.log(`\n2. ИНВАЙТ оппоненту (он введёт свои условия):\n  ${payload.inviteUrl}`);
console.log(`\n3. НАБЛЮДАТЕЛЬ (для обоих):\n  ${payload.observerUrl}\n`);
