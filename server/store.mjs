// Хранилище комнат и протокол переговоров (чистая логика, без HTTP/WS).
// Серверные инварианты:
//  - условия сделки вводит только человек-владелец (owner token, веб);
//  - агент видит только свои условия + публичные сообщения;
//  - ходы строго по очереди (nextTurn), ACCEPT обязан ссылаться на
//    последний PROPOSE оппонента (accepts = id сообщения);
//  - наблюдатель не получает ни токенов, ни приватных условий.

import { randomBytes, randomUUID } from 'node:crypto';
import { extractNumbers } from '../shared/extract-numbers.mjs';

const ROOM_TTL_MS = 24 * 3600 * 1000;

export const createToken = () => randomBytes(18).toString('base64url');

const fail = (message) => {
  throw new Error(message);
};

const isValidConditions = (c) => {
  if (!c || typeof c.text !== 'string') return false;
  const text = c.text.trim();
  if (!text || text.length > 2_000) return false;
  for (const key of ['desiredPrice', 'walkAwayPrice']) {
    if (c[key] !== undefined && (!Number.isFinite(c[key]) || c[key] < 0)) return false;
  }
  return true;
};

const normalizeOffer = (offer) => {
  if (!offer || typeof offer !== 'object') fail('Offer must be an object.');
  const { status, price, currency, terms, accepts } = offer;
  if (!['PROPOSE', 'ACCEPT', 'REJECT'].includes(status)) fail('Offer status must be PROPOSE, ACCEPT or REJECT.');
  if (!Number.isFinite(price) || price < 0) fail('Offer price must be a non-negative number.');
  if (typeof currency !== 'string' || currency.trim().length !== 3) fail('Offer currency must be a 3-letter code.');
  const clean = {
    price,
    currency: currency.trim().toUpperCase(),
    terms: Array.isArray(terms) ? terms : [],
    status,
  };
  if (status === 'ACCEPT') {
    if (typeof accepts !== 'string' || !accepts) fail('ACCEPT must reference the opponent PROPOSE via "accepts" message id.');
    clean.accepts = accepts;
  }
  return clean;
};

export function createStore() {
  const rooms = new Map();

  const get = (roomId) => {
    const room = rooms.get(roomId);
    if (!room) fail('Room not found.');
    if (room.expiresAt < Date.now()) {
      rooms.delete(roomId);
      fail('Room expired.');
    }
    return room;
  };

  const sideOfOwner = (room, ownerToken) => {
    for (const side of ['SIDE_A', 'SIDE_B']) {
      if (room.sides[side].ownerToken === ownerToken) return side;
    }
    return null;
  };

  const lastOpponentPropose = (room, role) =>
    [...room.messages].reverse().find((m) => m.side !== role && m.offer.status === 'PROPOSE') ?? null;

  const resultOf = (room) => {
    const lastAccept = [...room.messages].reverse().find((m) => m.offer.status === 'ACCEPT');
    if (room.status === 'DEAL_AGREED' && lastAccept) {
      return { status: 'DEAL_AGREED', price: lastAccept.offer.price, currency: lastAccept.offer.currency, acceptedBy: lastAccept.side };
    }
    if (room.status === 'FAILED') {
      return { status: 'FAILED', reason: room.failReason ?? 'Negotiation ended without a deal.' };
    }
    return null;
  };

  /** Публичный вид: токенов и приватных условий нет. */
  const publicSnapshot = (room) => ({
    type: 'room_state',
    roomId: room.id,
    lotTitle: room.lotTitle,
    status: room.status,
    nextTurn: room.nextTurn,
    rounds: room.messages.length,
    maxRounds: room.maxRounds,
    submitted: { SIDE_A: Boolean(room.sides.SIDE_A.conditions), SIDE_B: Boolean(room.sides.SIDE_B.conditions) },
    agentOnline: { SIDE_A: room.sides.SIDE_A.agentOnline, SIDE_B: room.sides.SIDE_B.agentOnline },
    messages: room.messages,
    result: resultOf(room),
  });

  const createRoom = ({ lotTitle = '', maxRounds = 20 } = {}) => {
    const room = {
      id: randomUUID(),
      lotTitle: String(lotTitle ?? '').slice(0, 200),
      maxRounds: Number.isFinite(Number(maxRounds)) && Number(maxRounds) > 0 ? Math.min(100, Math.floor(Number(maxRounds))) : 20,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + ROOM_TTL_MS,
      inviteToken: createToken(),
      sides: {
        SIDE_A: { ownerToken: createToken(), agentToken: createToken(), conditions: null, agentOnline: false },
        SIDE_B: { ownerToken: createToken(), agentToken: createToken(), conditions: null, agentOnline: false },
      },
      messages: [],
      status: 'WAITING_FOR_SUBMISSIONS',
      nextTurn: 'SIDE_A',
      failReason: null,
    };
    rooms.set(room.id, room);
    return room;
  };

  /** Обмен инвайта оппонента на его owner-токен (идемпотентно). */
  const claimInvite = (roomId, inviteToken) => {
    const room = get(roomId);
    if (!inviteToken || inviteToken !== room.inviteToken) fail('Invalid invite token.');
    return { side: 'SIDE_B', ownerToken: room.sides.SIDE_B.ownerToken };
  };

  const ownerSnapshot = (roomId, ownerToken) => {
    const room = get(roomId);
    const side = sideOfOwner(room, ownerToken);
    if (!side) fail('Invalid owner token.');
    const own = room.sides[side];
    return {
      ...publicSnapshot(room),
      role: side,
      ownConditions: own.conditions,
      ownSubmitted: Boolean(own.conditions),
      otherSubmitted: Boolean(room.sides[side === 'SIDE_A' ? 'SIDE_B' : 'SIDE_A'].conditions),
      agentToken: own.agentToken,
      agentHash: `#r=${room.id}&agent=${side}&token=${own.agentToken}`,
      // Инвайт оппонента видит только создатель комнаты (сторона A).
      inviteHash: side === 'SIDE_A' ? `#r=${room.id}&invite=${room.inviteToken}` : null,
    };
  };

  const agentState = (roomId, role, agentToken) => {
    const room = get(roomId);
    const own = room.sides[role];
    if (!own) fail('Unknown role.');
    if (own.agentToken !== agentToken) fail('Invalid agent credentials.');
    return {
      ...publicSnapshot(room),
      role,
      ownConditions: own.conditions,
    };
  };

  /** Условия вводит человек-владелец через веб. После обеих подач — IN_NEGOTIATION.
   *  Направление фиксировано: A — покупатель (desired <= walkAway),
   *  B — продавец (desired >= walkAway). Иначе 400 с объяснением. */
  const setConditions = (roomId, ownerToken, conditions) => {
    const room = get(roomId);
    const side = sideOfOwner(room, ownerToken);
    if (!side) fail('Invalid owner token.');
    if (room.status !== 'WAITING_FOR_SUBMISSIONS') fail('Conditions are locked: negotiation already started.');
    if (!isValidConditions(conditions)) fail('Invalid deal conditions: write your deal terms as text (1..2000 chars).');
    // Направление — только если заданы оба числа (нужны CLI и gate).
    if (Number.isFinite(conditions.desiredPrice) && Number.isFinite(conditions.walkAwayPrice)) {
      if (side === 'SIDE_A' && conditions.desiredPrice > conditions.walkAwayPrice) {
        fail('SIDE_A is the buyer: desired price must be <= walk-away price.');
      }
      if (side === 'SIDE_B' && conditions.desiredPrice < conditions.walkAwayPrice) {
        fail('SIDE_B is the seller: desired price must be >= walk-away price.');
      }
    }
    const clean = { text: String(conditions.text).trim() };
    if (Number.isFinite(conditions.desiredPrice)) clean.desiredPrice = conditions.desiredPrice;
    if (Number.isFinite(conditions.walkAwayPrice)) clean.walkAwayPrice = conditions.walkAwayPrice;
    room.sides[side].conditions = clean;
    if (room.sides.SIDE_A.conditions && room.sides.SIDE_B.conditions) {
      room.status = 'IN_NEGOTIATION';
      room.nextTurn = 'SIDE_A';
    }
    return { side, status: room.status };
  };

  /** Шёпот человека своему агенту прямо по ходу торга.
   *  Числа из подсказки только РАСШИРЯЮТ коридор наружу
   *  (покупатель: walkAway вверх, продавец: walkAway вниз);
   *  текст подсказки дописывается к условиям — его читают LLM-агенты.
   *  После финала шёпот закрыт. */
  const whisper = (roomId, ownerToken, text) => {
    const room = get(roomId);
    const side = sideOfOwner(room, ownerToken);
    if (!side) fail('Invalid owner token.');
    if (room.status !== 'WAITING_FOR_SUBMISSIONS' && room.status !== 'IN_NEGOTIATION') {
      fail('Negotiation is over: whisper is closed.');
    }
    const own = room.sides[side];
    if (!own.conditions) fail('Enter your deal conditions first.');
    const clean = String(text ?? '').trim().slice(0, 500);
    if (!clean) fail('Whisper must be 1..500 characters.');
    const numbers = extractNumbers(clean);
    if (numbers.length > 0) {
      if (side === 'SIDE_A') {
        own.conditions.walkAwayPrice = Math.max(own.conditions.walkAwayPrice ?? -Infinity, ...numbers);
        if (!Number.isFinite(own.conditions.desiredPrice)) own.conditions.desiredPrice = Math.min(...numbers);
      } else {
        own.conditions.walkAwayPrice = Math.min(own.conditions.walkAwayPrice ?? Infinity, ...numbers);
        if (!Number.isFinite(own.conditions.desiredPrice)) own.conditions.desiredPrice = Math.max(...numbers);
      }
    }
    own.conditions.text = `${own.conditions.text}\n[шёпот человека]: ${clean}`.slice(-2000);
    return { side, conditions: own.conditions };
  };
  /** Ход CLI-агента: проверка токена, очереди и ссылки ACCEPT. */
  const postMessage = (roomId, role, agentToken, payload) => {
    const room = get(roomId);
    const side = room.sides[role];
    if (!side || side.agentToken !== agentToken) fail('Invalid agent credentials.');
    if (room.status !== 'IN_NEGOTIATION') fail('Negotiation is not active.');
    if (role !== room.nextTurn) fail(`Not your turn. Expected ${room.nextTurn}.`);
    if (!room.sides.SIDE_A.conditions || !room.sides.SIDE_B.conditions) fail('Both sides must submit conditions first.');

    const offer = normalizeOffer(payload?.offer);
    const message = String(payload?.message ?? '').trim();
    if (!message || message.length > 2000) fail('Message must be 1..2000 characters.');

    if (offer.status === 'ACCEPT') {
      const target = lastOpponentPropose(room, role);
      if (!target || target.id !== offer.accepts) {
        fail(`ACCEPT must reference the latest opponent PROPOSE (accepts=${target ? target.id : 'none'}).`);
      }
    }

    // Серверный предел walk-away — только если человек задал числовой лимит.
    // A — покупатель (цена <= walkAway), B — продавец (цена >= walkAway).
    const limit = side.conditions.walkAwayPrice;
    if (Number.isFinite(limit)) {
      const withinLimit = role === 'SIDE_A' ? offer.price <= limit : offer.price >= limit;
      if (!withinLimit) {
        fail(`Offer price ${offer.price} violates your walk-away limit (${limit}).`);
      }
    }

    const entry = {
      id: randomUUID(),
      seq: room.messages.length + 1,
      side: role,
      offer,
      message,
      createdAt: new Date().toISOString(),
    };
    room.messages.push(entry);

    if (offer.status === 'ACCEPT') {
      room.status = 'DEAL_AGREED';
    } else if (offer.status === 'REJECT') {
      room.status = 'FAILED';
      room.failReason = `${role} rejected the deal.`;
    } else if (room.messages.length >= room.maxRounds) {
      room.status = 'FAILED';
      room.failReason = `Round limit reached (${room.maxRounds}).`;
    } else {
      room.nextTurn = role === 'SIDE_A' ? 'SIDE_B' : 'SIDE_A';
    }
    return entry;
  };

  const setAgentOnline = (roomId, role, online) => {
    const room = rooms.get(roomId);
    if (room && room.sides[role]) room.sides[role].agentOnline = online;
  };

  const purge = () => {
    for (const [id, room] of rooms) {
      if (room.expiresAt < Date.now()) rooms.delete(id);
    }
  };

  return {
    createRoom, claimInvite, ownerSnapshot, agentState,
    setConditions, whisper, postMessage, publicSnapshot, setAgentOnline, purge,
    size: () => rooms.size,
    // только для тестов/отладки:
    _get: (roomId) => rooms.get(roomId),
  };
}
