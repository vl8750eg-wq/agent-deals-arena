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
  /** Название лота — для живых реплик (опционально). */
  lotTitle?: string;
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
  const lot = input.lotTitle?.trim() ? ` по лоту «${input.lotTitle.trim().slice(0, 60)}»` : '';

  const opponentLast = [...messages].reverse().find((m) => m.side !== role && m.offer.status === 'PROPOSE');
  const myLast = [...messages].reverse().find((m) => m.side === role);

  const acceptable = (price: number): boolean =>
    isBuyer ? price <= walkAwayPrice : price >= walkAwayPrice;

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

function clamp(value: number, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.min(hi, Math.max(lo, value));
}
