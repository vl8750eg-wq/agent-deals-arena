// Детерминированная стратегия CLI-агента (зеркало src/domain/agent-strategy.ts).
// Держим отдельным .mjs, чтобы `node cli/agent.mjs` работал без сборки TypeScript.
// Паритет nextOffer проверяется тестом tests/domain/strategy-parity.test.ts.

/**
 * Эвристика: вытащить числовые лимиты из свободного текста условий.
 * Покупатель (SIDE_A): desired = min, walkAway = max (одно число — оба равны ему).
 * Продавец (SIDE_B): desired = max, walkAway = min (одно число — оба равны ему).
 * Возвращает null, если чисел в тексте нет. Используется ТОЛЬКО с явным
 * флагом --infer-limits: угадывать денежные лимиты молча запрещено.
 *
 * @param {string} text
 * @param {'SIDE_A'|'SIDE_B'} role
 * @returns {{desiredPrice:number, walkAwayPrice:number, numbers:number[]} | null}
 */
export function inferLimits(text, role) {
  const numbers = (String(text ?? '').match(/\d[\d\s]*(?:[.,]\d+)?/g) ?? [])
    .map((raw) => Number(raw.replace(/\s/g, '').replace(',', '.')))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (numbers.length === 0) return null;
  const lo = Math.min(...numbers);
  const hi = Math.max(...numbers);
  const isBuyer = role === 'SIDE_A';
  return {
    desiredPrice: isBuyer ? lo : hi,
    walkAwayPrice: isBuyer ? hi : lo,
    numbers,
  };
}

/**
 * @param {object} input
 * @param {'SIDE_A'|'SIDE_B'} input.role
 * @param {number} input.desiredPrice
 * @param {number} input.walkAwayPrice
 * @param {'firm'|'cooperative'|'mirror'} input.strategy
 * @param {Array<{id:string,side:string,offer:{price:number,status:string},message:string}>} input.messages
 * @param {number} input.myTurnsTaken
 * @param {string} [input.lotTitle]
 */
export function nextOffer(input) {
  const { role, desiredPrice, walkAwayPrice, strategy, messages, myTurnsTaken } = input;
  const isBuyer = role === 'SIDE_A';
  const lot = (input.lotTitle ?? '').trim() ? ` по лоту «${String(input.lotTitle).trim().slice(0, 60)}»` : '';

  const opponentLast = [...messages].reverse().find((m) => m.side !== role && m.offer.status === 'PROPOSE');
  const myLast = [...messages].reverse().find((m) => m.side === role);

  const acceptable = (price) => (isBuyer ? price <= walkAwayPrice : price >= walkAwayPrice);

  if (opponentLast && acceptable(opponentLast.offer.price)) {
    return {
      offer: { price: opponentLast.offer.price, currency: 'USD', terms: [], status: 'ACCEPT', accepts: opponentLast.id },
      message: `Договорились! Принимаю ${opponentLast.offer.price} USD. Спасибо за конструктивный торг!`,
    };
  }

  // Нет ZOPA: оппонент трижды повторил одну и ту же неприемлемую цену —
  // дальше топтаться нет смысла, честно выходим REJECT вместо лимита раундов.
  const oppProposes = messages.filter((m) => m.side !== role && m.offer.status === 'PROPOSE');
  const lastThree = oppProposes.slice(-3);
  if (
    lastThree.length === 3 &&
    lastThree.every((m) => m.offer.price === lastThree[0].offer.price) &&
    !acceptable(lastThree[0].offer.price)
  ) {
    const price = lastThree[0].offer.price;
    return {
      offer: { price, currency: 'USD', terms: [], status: 'REJECT' },
      message: `К сожалению, на ${price} USD мы не сходимся — дальше уступать не могу. Спасибо за диалог!`,
    };
  }

  const span = walkAwayPrice - desiredPrice;
  const stepFraction = strategy === 'firm' ? 0.12 : strategy === 'mirror' ? 0.25 : 0.34;
  const concession = span * stepFraction * (myTurnsTaken + 1);

  if (strategy === 'mirror' && opponentLast && myLast) {
    const oppStep = Math.abs(opponentLast.offer.price - myLast.offer.price);
    const myStep = Math.abs(span * stepFraction);
    const step = Math.sign(span) * Math.min(Math.max(oppStep, myStep * 0.5), Math.abs(span));
    const price = clamp(Math.round(myLast.offer.price + step), desiredPrice, walkAwayPrice);
    return {
      offer: { price, currency: 'USD', terms: [], status: 'PROPOSE' },
      message: `Вижу ваши ${opponentLast.offer.price} USD — иду навстречу: ${price} USD. Двигаемся друг к другу!`,
    };
  }

  const price = clamp(Math.round(desiredPrice + concession), desiredPrice, walkAwayPrice);
  if (myTurnsTaken === 0) {
    return {
      offer: { price, currency: 'USD', terms: [], status: 'PROPOSE' },
      message: `Здравствуйте!${lot} предлагаю ${price} USD — считаю это честной стартовой ценой.`,
    };
  }
  const polite = strategy === 'firm'
    ? `Могу предложить ${price} USD — это мой предел, дальше уступить, увы, не получится.`
    : strategy === 'mirror'
      ? `Отвечаю ${price} USD — сближаем позиции шаг за шагом.`
      : `Готов подвинуться до ${price} USD — давайте договоримся, вещь того стоит!`;

  return {
    offer: { price, currency: 'USD', terms: [], status: 'PROPOSE' },
    message: polite,
  };
}

function clamp(value, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.min(hi, Math.max(lo, value));
}
