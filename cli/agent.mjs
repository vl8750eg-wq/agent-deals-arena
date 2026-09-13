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
log(`connecting to ${url}`);

const socket = new WebSocket(url);
let myTurnsTaken = 0;
let acting = false;
let finished = false;
let seenIds = new Set();
let limitsAnnounced = false;

socket.on('open', () => {
  log('connected. Waiting for both humans to enter conditions in the web UI…');
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

  if (!state.ownConditions) {
    log('my human has not entered conditions yet — waiting (web UI, owner link).');
    return;
  }
  if (state.status !== 'IN_NEGOTIATION') {
    const other = state.submitted[role === 'SIDE_A' ? 'SIDE_B' : 'SIDE_A'] ? 'submitted' : 'pending';
    log(`waiting for the other human… (opponent conditions: ${other})`);
    return;
  }

  if (state.nextTurn !== role || acting) return;
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
  if (!finished) log('connection closed.');
});

socket.on('error', (error) => {
  log(`connection error: ${error.message}`);
});
