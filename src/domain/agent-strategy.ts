import type { Side, StructuredOffer } from './negotiation-room';

export type ConcessionStrategy = 'firm' | 'cooperative' | 'mirror';

export interface StrategyMessage {
  id: string;
  side: Side;
  offer: StructuredOffer;
  message: string;
}

export interface StrategyInput {
  role: Side;
  desiredPrice: number;
  walkAwayPrice: number;
  strategy: ConcessionStrategy;
  messages: StrategyMessage[];
  myTurnsTaken: number;
}

export interface StrategyOutput {
  offer: StructuredOffer;
  message: string;
}

/**
 * Детерминированная стратегия торга CLI-агента.
 * Зеркало: cli/strategy.mjs (паритет проверяется тестом strategy-parity).
 *
 * SIDE_A — покупатель: приемлемо всё, что <= walkAwayPrice.
 * SIDE_B — продавец: приемлемо всё, что >= walkAwayPrice.
 * ACCEPT всегда ссылается на id последнего PROPOSE оппонента.
 */
export function nextOffer(input: StrategyInput): StrategyOutput {
  const { role, desiredPrice, walkAwayPrice, strategy, messages, myTurnsTaken } = input;
  const isBuyer = role === 'SIDE_A';

  const opponentLast = [...messages].reverse().find((m) => m.side !== role && m.offer.status === 'PROPOSE');
  const myLast = [...messages].reverse().find((m) => m.side === role);

  const acceptable = (price: number): boolean =>
    isBuyer ? price <= walkAwayPrice : price >= walkAwayPrice;

  if (opponentLast && acceptable(opponentLast.offer.price)) {
    return {
      offer: { price: opponentLast.offer.price, currency: 'USD', terms: [], status: 'ACCEPT', accepts: opponentLast.id },
      message: `Deal! ${opponentLast.offer.price} USD works for me.`,
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
      message: `No common ground at ${price} USD — I have to stop here.`,
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
      message: `I can meet you halfway at ${price} USD.`,
    };
  }

  const price = clamp(Math.round(desiredPrice + concession), desiredPrice, walkAwayPrice);
  const polite = strategy === 'firm'
    ? `My position is firm, but I can offer ${price} USD.`
    : strategy === 'mirror'
      ? `I see your move — my counter is ${price} USD.`
      : `In a cooperative spirit, I propose ${price} USD.`;

  return {
    offer: { price, currency: 'USD', terms: [], status: 'PROPOSE' },
    message: polite,
  };
}

function clamp(value: number, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.min(hi, Math.max(lo, value));
}
