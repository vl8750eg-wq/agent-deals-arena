#!/usr/bin/env node
// CLI-агент переговоров. Условия сделки вводит ЧЕЛОВЕК в вебе —
// агент читает их из room_state (ownConditions) и торгуется сам.
//
//   node cli/agent.mjs --server=ws://127.0.0.1:8787 --room=<id> \
//     --role=SIDE_A --token=<agent-token> --strategy=cooperative
//
// Агент через WebSocket ждёт обеих подач, затем на своём ходу (nextTurn)
// считает nextOffer() и отправляет post_message. Всё общение — в stdout.
// Люди в это время смотрят веб-наблюдатель: /#r=<id>.

import WebSocket from 'ws';
import { inferLimits, nextOffer } from './strategy.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const match = raw.match(/^--([^=]+)=(.*)$/);
    return match ? [match[1], match[2]] : [raw.replace(/^--/, ''), 'true'];
  }),
);

const server = String(args.server ?? 'ws://127.0.0.1:8787').replace(/\/$/, '');
const roomId = String(args.room ?? '');
const role = String(args.role ?? '');
const token = String(args.token ?? '');
const strategy = String(args.strategy ?? 'cooperative');
const delayMs = Number(args['delay-ms'] ?? 800);
const name = String(args.name ?? role);

function usage() {
  console.error(
    'Usage: node cli/agent.mjs --room=<id> --role=SIDE_A|SIDE_B --token=<agent-token> [--server=ws://127.0.0.1:8787] [--strategy=firm|cooperative|mirror] [--delay-ms=800]',
  );
}

if (!roomId || !['SIDE_A', 'SIDE_B'].includes(role) || !token) {
  usage();
  process.exit(1);
}
if (!['firm', 'cooperative', 'mirror'].includes(strategy)) {
  console.error('[agent] --strategy must be firm|cooperative|mirror.');
  process.exit(1);
}

const stamp = () => new Date().toLocaleTimeString('ru-RU', { hour12: false });
const log = (...parts) => console.log(`[${stamp()}] [${name}]`, ...parts);

const url = `${server}/ws?room=${encodeURIComponent(roomId)}&role=${role}&token=${encodeURIComponent(token)}`;

let socket = null;
let myTurnsTaken = 0;
let acting = false;
let finished = false;
let seenIds = new Set();
let limitsAnnounced = false;
let lastState = null;
let lastWaitKey = '';
let lastTurnSeen = '';

const waitKeyOf = (state) => {
  if (!state || state.type !== 'room_state') return 'none';
  if (state.status !== 'IN_NEGOTIATION' && state.status !== 'WAITING_FOR_SUBMISSIONS') return state.status;
  return `${state.status}|own=${Boolean(state.ownConditions)}|other=${state.submitted[role === 'SIDE_A' ? 'SIDE_B' : 'SIDE_A']}|turn=${state.nextTurn}`;
};

const waitLineOf = (state) => {
  if (!state.ownConditions) return 'жду: человек ещё не ввёл условия в вебе (owner-ссылка)…';
  if (state.status === 'WAITING_FOR_SUBMISSIONS') {
    const other = state.submitted[role === 'SIDE_A' ? 'SIDE_B' : 'SIDE_A'] ? 'submitted' : 'pending';
    return `жду вторую сторону… (оппонент: ${other})`;
  }
  if (state.status === 'IN_NEGOTIATION' && state.nextTurn !== role) {
    return `жду хода ${state.nextTurn} (раунд ${state.messages.length}/${state.maxRounds})…`;
  }
  return '';
};

// Heartbeat: процесс никогда не молчит дольше 15 сек, пока ждёт.
// Раннеры, убивающие «молчащие» сессии, видят что агент жив и чего ждёт.
setInterval(() => {
  if (finished || !lastState) return;
  const line = waitLineOf(lastState);
  if (line) log(line);
}, 15000);

function connect() {
  if (finished) return;
  log(`connecting to ${url}`);
  socket = new WebSocket(url);

  socket.on('open', () => {
    log('connected. Жду своей очереди — торг начнётся сам.');
  });

socket.on('message', (raw) => {
  let state;
  try {
    state = JSON.parse(raw.toString());
  } catch {
    log('received non-JSON payload.');
    return;
  }
  if (state.type === 'error') {
    log(`SERVER ERROR: ${state.error}`);
    return;
  }
  if (state.type !== 'room_state') return;
  lastState = state;

  for (const m of state.messages) {
    if (!seenIds.has(m.id)) {
      seenIds.add(m.id);
      const arrow = m.side === role ? '->' : '<-';
      log(`${arrow} ${m.side}: ${m.offer.status} ${m.offer.price} ${m.offer.currency} — "${m.message}"`);
    }
  }

  if (state.status === 'DEAL_AGREED') {
    if (!finished) {
      finished = true;
      log(`DEAL_AGREED at ${state.result?.price} USD. Humans can see it in the web observer: /#r=${roomId}`);
      socket.close();
      process.exit(0);
    }
    return;
  }
  if (state.status === 'FAILED') {
    if (!finished) {
      finished = true;
      log(`FAILED: ${state.result?.reason ?? 'no deal'}.`);
      socket.close();
      process.exit(2);
    }
    return;
  }

  if (!state.ownConditions || state.status !== 'IN_NEGOTIATION' || state.nextTurn !== role) {
    // Строка ожидания — только при смене ситуации, не спамим на каждый broadcast.
    const key = waitKeyOf(state);
    if (key !== lastWaitKey) {
      lastWaitKey = key;
      const line = waitLineOf(state);
      if (line) log(line);
    }
    if (state.nextTurn !== lastTurnSeen) {
      lastTurnSeen = state.nextTurn;
      if (state.status === 'IN_NEGOTIATION') log(`очередь хода: ${state.nextTurn}`);
    }
    return;
  }
  lastTurnSeen = state.nextTurn;

  if (acting) return;
  acting = true;
  setTimeout(() => {
    try {
      // Лимиты: явные числа из условий, иначе вытаскиваем их из текста условий как есть.
      let desired = state.ownConditions.desiredPrice;
      let walk = state.ownConditions.walkAwayPrice;
      let fromText = '';
      if (!Number.isFinite(desired) || !Number.isFinite(walk)) {
        const inferred = inferLimits(state.ownConditions.text ?? '', role);
        if (!inferred) {
          log('в условиях нет ни одного числа — торговать не с чем. Уточни условия текстом с цифрами.');
          socket.close();
          process.exit(3);
          return;
        }
        desired = inferred.desiredPrice;
        walk = inferred.walkAwayPrice;
        fromText = ` (понял из текста: ${inferred.numbers.join(', ')})`;
      }
      if (!limitsAnnounced) {
        limitsAnnounced = true;
        log(`торгую по условиям сделки: desired=${desired}, walkaway=${walk}${fromText}`);
      }
      const turn = nextOffer({
        role,
        desiredPrice: desired,
        walkAwayPrice: walk,
        strategy,
        messages: state.messages,
        myTurnsTaken,
        lotTitle: state.lotTitle,
        conditionsText: state.ownConditions.text,
      });
      myTurnsTaken += 1;
      socket.send(JSON.stringify({ type: 'post_message', offer: turn.offer, message: turn.message }));
    } catch (error) {
      log(`strategy error: ${error instanceof Error ? error.message : error}`);
    } finally {
      acting = false;
    }
  }, Number.isFinite(delayMs) ? delayMs : 800);
});

  socket.on('close', () => {
    if (finished) return;
    acting = false;
    log('соединение потеряно — переподключаюсь через 3 сек… (сессия продолжается)');
    setTimeout(connect, 3000);
  });

  socket.on('error', (error) => {
    if (!finished) log(`connection error: ${error.message} (жду/переподключаюсь, сессия продолжается)`);
  });
}

connect();
