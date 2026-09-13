import { describe, expect, it } from 'vitest';
import { nextOffer, type StrategyMessage } from '../../src/domain/agent-strategy';

const msg = (id: string, side: 'SIDE_A' | 'SIDE_B', price: number): StrategyMessage => ({
  id,
  side,
  offer: { price, currency: 'USD', terms: [], status: 'PROPOSE' },
  message: `Offer ${price}`,
});

describe('agent-strategy (CLI brains)', () => {
  it('buyer accepts immediately a price better than desired', () => {
    const turn = nextOffer({
      role: 'SIDE_A',
      desiredPrice: 100,
      walkAwayPrice: 130,
      strategy: 'cooperative',
      myTurnsTaken: 0,
      messages: [msg('m1', 'SIDE_B', 95)],
    });

    expect(turn.offer.status).toBe('ACCEPT');
    expect(turn.offer.price).toBe(95);
    expect(turn.offer.accepts).toBe('m1');
  });

  it('buyer counters a merely-acceptable price first, accepts on repeat', () => {
    const base = {
      role: 'SIDE_A' as const,
      desiredPrice: 100,
      walkAwayPrice: 130,
      strategy: 'cooperative' as const,
    };
    const first = nextOffer({ ...base, myTurnsTaken: 0, messages: [msg('m1', 'SIDE_B', 125)] });
    expect(first.offer.status).toBe('PROPOSE');

    const second = nextOffer({
      ...base,
      myTurnsTaken: 1,
      messages: [msg('m1', 'SIDE_B', 125), msg('m2', 'SIDE_A', first.offer.price), msg('m3', 'SIDE_B', 125)],
    });
    expect(second.offer.status).toBe('ACCEPT');
    expect(second.offer.price).toBe(125);
    expect(second.offer.accepts).toBe('m3');
  });

  it('seller accepts immediately a price better than desired', () => {
    const turn = nextOffer({
      role: 'SIDE_B',
      desiredPrice: 150,
      walkAwayPrice: 120,
      strategy: 'cooperative',
      myTurnsTaken: 0,
      messages: [msg('m1', 'SIDE_A', 155)],
    });

    expect(turn.offer.status).toBe('ACCEPT');
    expect(turn.offer.accepts).toBe('m1');
  });

  it('concedes from desired toward walk-away without crossing it', () => {
    const base = {
      role: 'SIDE_A' as const,
      desiredPrice: 100,
      walkAwayPrice: 130,
      strategy: 'cooperative' as const,
      messages: [],
    };
    const first = nextOffer({ ...base, myTurnsTaken: 0 });
    const second = nextOffer({ ...base, myTurnsTaken: 1 });

    expect(first.offer.status).toBe('PROPOSE');
    expect(first.offer.price).toBeGreaterThan(100);
    expect(first.offer.price).toBeLessThanOrEqual(130);
    expect(second.offer.price).toBeGreaterThan(first.offer.price);
    expect(second.offer.price).toBeLessThanOrEqual(130);
  });
  it('keeps proposing (never accepts) when opponent price is unacceptable', () => {
    const turn = nextOffer({
      role: 'SIDE_A',
      desiredPrice: 100,
      walkAwayPrice: 130,
      strategy: 'firm',
      myTurnsTaken: 0,
      messages: [msg('m1', 'SIDE_B', 200)],
    });

    expect(turn.offer.status).toBe('PROPOSE');
    expect(turn.offer.price).toBeLessThanOrEqual(130);
  });

  it('speaks like a human: greeting, lot and price in the first offer', () => {
    const turn = nextOffer({
      role: 'SIDE_A',
      desiredPrice: 100,
      walkAwayPrice: 130,
      strategy: 'cooperative',
      myTurnsTaken: 0,
      messages: [],
      lotTitle: 'Ноутбук',
    });

    expect(turn.offer.status).toBe('PROPOSE');
    expect(turn.message).toContain('Здравствуйте');
    expect(turn.message).toContain('Ноутбук');
    expect(turn.message).toContain(String(turn.offer.price));
  });

  it('argues repeats: same price gets a new argument, never leaks private conditions', () => {
    const secret = 'Продаю ноутбук, минимум 30000, срочно нужны деньги';
    const base = {
      role: 'SIDE_B' as const,
      desiredPrice: 30000,
      walkAwayPrice: 30000,
      strategy: 'cooperative' as const,
      lotTitle: 'Ноутбук',
      conditionsText: secret,
    };
    const history = [
      msg('m1', 'SIDE_A', 20000),
      msg('m2', 'SIDE_B', 30000),
    ];
    const first = nextOffer({ ...base, myTurnsTaken: 1, messages: history });
    const second = nextOffer({ ...base, myTurnsTaken: 2, messages: [...history, msg('m3', 'SIDE_A', 20000)] });
    const opener = nextOffer({ ...base, myTurnsTaken: 0, messages: [] });

    expect(first.offer.price).toBe(30000);
    expect(second.offer.price).toBe(30000);
    expect(first.message).not.toBe(second.message);
    expect(second.message).toContain('крайняя цена');
    for (const m of [first.message, second.message, opener.message]) {
      expect(m).not.toContain(secret);
      expect(m).not.toContain('30000, срочно');
    }
  });

  it('moved price reacts to the opponent number', () => {
    const turn = nextOffer({
      role: 'SIDE_A',
      desiredPrice: 100,
      walkAwayPrice: 130,
      strategy: 'cooperative',
      myTurnsTaken: 1,
      messages: [
        msg('m1', 'SIDE_A', 110),
        msg('m2', 'SIDE_B', 140),
      ],
    });

    expect(turn.offer.status).toBe('PROPOSE');
    expect(turn.offer.price).toBeGreaterThan(110);
    expect(turn.message).toContain('140');
  });

  it('rejects early when the opponent repeats an unacceptable price three times', () => {
    const turn = nextOffer({
      role: 'SIDE_B',
      desiredPrice: 30000,
      walkAwayPrice: 30000,
      strategy: 'cooperative',
      myTurnsTaken: 3,
      messages: [msg('m1', 'SIDE_A', 20000), msg('m2', 'SIDE_B', 30000), msg('m3', 'SIDE_A', 20000), msg('m4', 'SIDE_B', 30000), msg('m5', 'SIDE_A', 20000)],
    });

    expect(turn.offer.status).toBe('REJECT');
    expect(turn.offer.price).toBe(20000);
  });
});
